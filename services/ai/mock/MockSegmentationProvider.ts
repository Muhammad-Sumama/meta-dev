import { AppError } from "@/lib/errors";
import type { FramePrompt, PointPrompt } from "@/lib/schemas/project";
import type { FrameSource } from "../frameSource";
import type {
  CallOptions,
  Detection,
  MaskResult,
  ProviderHealth,
  ProviderInfo,
  SegmentationProvider,
  TargetQuery,
  TrackCallbacks,
  TrackRequest,
  VideoSession,
  VideoSource,
} from "../types";
import { buildBackgroundModel, foregroundMask, type BackgroundModel } from "./cv/background";
import { classifyColor } from "./cv/color";
import { componentMask, labelComponents } from "./cv/components";
import { groundInForeground } from "./cv/grounding";
import { area, close, dilate, fillHoles, intersect, rectMask, subtract, union } from "./cv/morphology";
import { carveRegion, regionGrow, segmentBoxByColor } from "./cv/segment";
import { MaskTracker } from "./cv/tracker";

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  MOCK SEGMENTATION PROVIDER  (no neural network)
 * ─────────────────────────────────────────────────────────────────────────
 * Implements the SAM 2 provider contract with classical computer vision so
 * the full product works on a laptop without a GPU:
 *
 *   initializeVideo  → temporal-median background model (static cameras)
 *   locateObjects    → moving blobs scored by shape + color heuristics
 *   segmentFrame     → foreground component under clicks / in box, else
 *                      color region growing or GrabCut-style box segmentation
 *   trackObject      → motion-predicted blob association frame to frame
 *
 * Quality is far below SAM 2: it needs a mostly static camera for whole-object
 * masks, doesn't re-identify objects after occlusion, and its text grounding
 * understands only categories, colors, clothing and position. The production
 * path is SAM2Provider (services/sam2/SAM2Provider.ts).
 */

interface MockSessionState {
  session: VideoSession;
  frames: FrameSource;
  model: BackgroundModel | null;
}

export interface MockSegmentationOptions {
  frameSourceFactory: (source: VideoSource) => FrameSource;
  backgroundSamples?: number;
}

const yieldToEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Real objects persist across the sampled frames with a similar size and
 * shape; blobs formed when two subjects touch are transient. Detections
 * without look-alikes in other frames are down-weighted (up to 30%).
 */
export function applyPersistencePrior(detections: Detection[], frameCount: number): Detection[] {
  if (frameCount < 3) return detections;
  const dims = (d: Detection) => {
    const bw = d.box.x1 - d.box.x0;
    const bh = d.box.y1 - d.box.y0;
    return { area: bw * bh, aspect: bh / Math.max(1e-6, bw) };
  };
  return detections.map((d) => {
    const a = dims(d);
    const frames = new Set<number>();
    for (const o of detections) {
      if (o.frameIndex === d.frameIndex || frames.has(o.frameIndex)) continue;
      const b = dims(o);
      const areaRatio = b.area / a.area;
      const aspectRatio = b.aspect / a.aspect;
      if (areaRatio > 0.6 && areaRatio < 1.65 && aspectRatio > 0.7 && aspectRatio < 1.4 && Math.abs(o.score - d.score) < 0.15) {
        frames.add(o.frameIndex);
      }
    }
    const persistence = frames.size / (frameCount - 1);
    return { ...d, score: d.score * (0.7 + 0.3 * persistence) };
  });
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
}

export class MockSegmentationProvider implements SegmentationProvider {
  readonly info: ProviderInfo = {
    id: "mock",
    name: "Mock inference (classical CV)",
    kind: "mock",
    description:
      "CPU-only stand-in for SAM 2: background subtraction, color region growing and blob tracking. Best on static-camera footage.",
  };

  private sessions = new Map<string, MockSessionState>();
  private building = new Map<string, Promise<MockSessionState>>();

  constructor(private readonly opts: MockSegmentationOptions) {}

  async health(): Promise<ProviderHealth> {
    return { status: "ready", message: "Mock segmentation runs locally on the CPU." };
  }

  async initializeVideo(
    source: VideoSource,
    opts: CallOptions & { onProgress?: (fraction: number, message: string) => void } = {},
  ): Promise<VideoSession> {
    const key = `${source.projectId}:${source.version}:${source.maskWidth}x${source.maskHeight}`;
    const existing = this.sessions.get(key);
    if (existing) return existing.session;
    let pending = this.building.get(key);
    if (!pending) {
      pending = this.buildSession(key, source, opts).finally(() => this.building.delete(key));
      this.building.set(key, pending);
    }
    return (await pending).session;
  }

  private async buildSession(
    key: string,
    source: VideoSource,
    opts: CallOptions & { onProgress?: (fraction: number, message: string) => void },
  ): Promise<MockSessionState> {
    const frames = this.opts.frameSourceFactory(source);
    const w = source.maskWidth;
    const h = source.maskHeight;
    const n = Math.min(this.opts.backgroundSamples ?? 41, source.frameCount);
    const samples: Uint8Array[] = [];
    opts.onProgress?.(0, "Analyzing the scene…");

    if (source.frameCount <= 900) {
      const stride = Math.max(1, Math.floor(source.frameCount / n));
      for await (const f of frames.stream(0, source.frameCount, opts.signal)) {
        if (f.index % stride === 0 && samples.length < n) samples.push(f.data.slice());
        if (f.index % 30 === 0) opts.onProgress?.(f.index / source.frameCount, "Analyzing the scene…");
      }
    } else {
      for (let s = 0; s < n; s++) {
        abortIfNeeded(opts.signal);
        const idx = Math.floor(((s + 0.5) * source.frameCount) / n);
        samples.push((await frames.readFrame(idx, opts.signal)).slice());
        opts.onProgress?.(s / n, "Analyzing the scene…");
      }
    }
    abortIfNeeded(opts.signal);

    const model = samples.length >= 5 ? buildBackgroundModel(samples, w, h) : null;
    const notes = [
      model?.motionReliable
        ? "Static camera detected: using background subtraction for whole-object masks."
        : "Camera motion or short clip detected: falling back to color-based segmentation (lower quality).",
    ];
    const state: MockSessionState = {
      session: { id: `mock_${key}`, providerId: this.info.id, source, width: w, height: h, notes },
      frames,
      model,
    };
    this.sessions.set(key, state);
    // Keep memory bounded: at most 4 analyzed videos.
    while (this.sessions.size > 4) this.sessions.delete(this.sessions.keys().next().value as string);
    opts.onProgress?.(1, "Scene analyzed");
    return state;
  }

  private state(session: VideoSession): MockSessionState {
    const key = session.id.replace(/^mock_/, "");
    const s = this.sessions.get(key);
    if (!s) throw new AppError("SEGMENTATION_FAILED", { message: "The video session expired. Try again." });
    return s;
  }

  async disposeVideo(session: VideoSession): Promise<void> {
    this.sessions.delete(session.id.replace(/^mock_/, ""));
  }

  // -------------------------------------------------------------------------
  async locateObjects(session: VideoSession, frameIndices: number[], query: TargetQuery, opts: CallOptions = {}) {
    const st = this.state(session);
    const { width: w, height: h } = session;
    const detections: Detection[] = [];
    for (const frameIndex of frameIndices) {
      abortIfNeeded(opts.signal);
      const frame = await st.frames.readFrame(frameIndex, opts.signal);
      let candidatesMask: Uint8Array | null = null;
      if (st.model?.motionReliable) {
        candidatesMask = foregroundMask(frame, st.model);
      } else {
        const colors = [...query.colors, ...query.clothing.map((c) => c.color).filter(Boolean)] as string[];
        if (colors.length) {
          const m = new Uint8Array(w * h);
          for (let i = 0, p = 0; i < m.length; i++, p += 3) {
            const c = classifyColor(frame[p], frame[p + 1], frame[p + 2]);
            if (c && colors.includes(c)) m[i] = 1;
          }
          candidatesMask = fillHoles(close(m, w, h, 2), w, h);
        }
      }
      if (!candidatesMask) continue;
      const candidates = groundInForeground(frame, candidatesMask, w, h, query).slice(0, 6);
      for (const c of candidates) {
        detections.push({ frameIndex, box: c.box, point: c.point, score: c.score, label: c.label });
      }
      await yieldToEventLoop();
    }
    return applyPersistencePrior(detections, frameIndices.length);
  }

  // -------------------------------------------------------------------------
  private toPixel(p: { x: number; y: number }, w: number, h: number) {
    return { x: Math.min(w - 1, Math.max(0, p.x * w)), y: Math.min(h - 1, Math.max(0, p.y * h)) };
  }

  private applyPoints(
    frame: Uint8Array,
    base: Uint8Array,
    points: PointPrompt[],
    st: MockSessionState,
    fg: Uint8Array | null,
  ): { mask: Uint8Array; fromMotion: boolean } {
    const { width: w, height: h } = st.session;
    let mask = base;
    let fromMotion = false;
    const lab = fg ? labelComponents(fg, w, h) : null;

    const componentNear = (px: number, py: number): number => {
      if (!lab) return 0;
      const x0 = Math.round(px);
      const y0 = Math.round(py);
      for (let r = 0; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const l = lab.labels[y * w + x];
            if (l) return l;
          }
        }
      }
      return 0;
    };

    for (const pt of points.filter((p) => p.label === 1)) {
      const { x, y } = this.toPixel(pt, w, h);
      const l = componentNear(x, y);
      if (l && lab) {
        mask = union(mask, componentMask(lab, l));
        fromMotion = true;
      } else {
        mask = union(mask, regionGrow(frame, w, h, [{ x, y }], { tolerance: 26, maxAreaFraction: 0.35 }));
      }
    }
    for (const pt of points.filter((p) => p.label === 0)) {
      const { x, y } = this.toPixel(pt, w, h);
      const i = Math.round(y) * w + Math.round(x);
      if (!mask[i]) continue;
      const l = componentNear(x, y);
      // A negative click on a separate moving blob removes that blob; inside a
      // single blob it carves out the color-similar region around the click.
      const blob = l && lab ? componentMask(lab, l) : null;
      if (blob && area(intersect(blob, mask)) < area(mask) * 0.9) mask = subtract(mask, blob);
      else mask = subtract(mask, dilate(carveRegion(frame, w, h, mask, { x, y }), w, h, 1));
    }
    return { mask, fromMotion };
  }

  async segmentFrame(session: VideoSession, prompt: FramePrompt, opts: CallOptions = {}): Promise<MaskResult> {
    const st = this.state(session);
    const { width: w, height: h } = session;
    const frame = await st.frames.readFrame(prompt.frameIndex, opts.signal);
    const fg = st.model?.motionReliable ? foregroundMask(frame, st.model) : null;
    let mask: Uint8Array = new Uint8Array(w * h);
    let fromMotion = false;

    if (prompt.box) {
      const b = prompt.box;
      const px = { x0: b.x0 * w, y0: b.y0 * h, x1: b.x1 * w, y1: b.y1 * h };
      const padX = (px.x1 - px.x0) * 0.04 + 1;
      const padY = (px.y1 - px.y0) * 0.04 + 1;
      const boxMask = rectMask(w, h, px.x0 - padX, px.y0 - padY, px.x1 + padX, px.y1 + padY);
      if (fg) {
        const lab = labelComponents(fg, w, h);
        const inside = new Float64Array(lab.components.length + 1);
        for (let i = 0; i < fg.length; i++) if (lab.labels[i] && boxMask[i]) inside[lab.labels[i]]++;
        const keep = new Set(lab.components.filter((c) => inside[c.label] / c.area >= 0.5).map((c) => c.label));
        const motionMask = intersect(componentMask(lab, keep), boxMask);
        const boxArea = (px.x1 - px.x0) * (px.y1 - px.y0);
        if (area(motionMask) > boxArea * 0.04) {
          mask = motionMask;
          fromMotion = true;
        }
      }
      if (!fromMotion) mask = segmentBoxByColor(frame, w, h, px);
    }

    if (prompt.points.length) {
      // Positive points add regions the box missed; negative points carve.
      const res = this.applyPoints(frame, mask, prompt.points, st, fg);
      mask = res.mask;
      fromMotion = fromMotion || res.fromMotion;
    }

    mask = fillHoles(mask, w, h);
    if (area(mask) === 0) {
      throw new AppError("SEGMENTATION_FAILED", {
        message: "We couldn't find an object at that spot.",
        hint: "Click directly on the object, or draw a box around it.",
      });
    }
    return { frameIndex: prompt.frameIndex, mask, score: fromMotion ? 0.9 : 0.6 };
  }

  async refineMask(
    session: VideoSession,
    req: { frameIndex: number; mask: Uint8Array; points: PointPrompt[] },
    opts: CallOptions = {},
  ): Promise<MaskResult> {
    const st = this.state(session);
    const frame = await st.frames.readFrame(req.frameIndex, opts.signal);
    const fg = st.model?.motionReliable ? foregroundMask(frame, st.model) : null;
    const { mask } = this.applyPoints(frame, req.mask.slice(), req.points, st, fg);
    return { frameIndex: req.frameIndex, mask: fillHoles(mask, session.width, session.height), score: 0.7 };
  }

  // -------------------------------------------------------------------------
  async trackObject(session: VideoSession, req: TrackRequest, cb: TrackCallbacks): Promise<void> {
    const st = this.state(session);
    const { width: w, height: h } = session;
    const start = Math.max(0, req.startFrame);
    const end = Math.min(session.source.frameCount - 1, req.endFrame);
    const keyframes = [...req.keyframes]
      .filter((k) => k.frameIndex >= start && k.frameIndex <= end)
      .sort((a, b) => a.frameIndex - b.frameIndex);
    if (!keyframes.length) throw new AppError("TRACKING_FAILED", { message: "The selection is outside the tracking range." });

    const total = end - start + 1;
    let done = 0;
    const tick = () => cb.onProgress?.(++done, total);

    // Resolve keyframe masks.
    const kfMasks: Array<{ frameIndex: number; mask: Uint8Array; frame: Uint8Array }> = [];
    for (const kf of keyframes) {
      const frame = await st.frames.readFrame(kf.frameIndex, cb.signal);
      const mask =
        kf.mask ?? (await this.segmentFrame(session, { frameIndex: kf.frameIndex, points: kf.points, box: kf.box }, cb)).mask;
      kfMasks.push({ frameIndex: kf.frameIndex, mask, frame });
      await cb.onFrame(kf.frameIndex, mask);
      tick();
    }

    const forward = req.direction !== "backward";
    const backward = req.direction !== "forward";

    // Forward passes: each keyframe drives frames until the next keyframe.
    if (forward) {
      for (let k = 0; k < kfMasks.length; k++) {
        const from = kfMasks[k].frameIndex + 1;
        const to = k + 1 < kfMasks.length ? kfMasks[k + 1].frameIndex - 1 : end;
        if (to < from) continue;
        const tracker = new MaskTracker(w, h, kfMasks[k].frame, kfMasks[k].mask, st.model);
        let i = from;
        for await (const f of st.frames.stream(from, to - from + 1, cb.signal)) {
          abortIfNeeded(cb.signal);
          if (tracker.done) break;
          const m = tracker.step(f.data);
          await cb.onFrame(f.index, area(m) ? m : null);
          tick();
          i = f.index + 1;
          if (f.index % 4 === 0) await yieldToEventLoop();
        }
        for (; i <= to; i++) tick();
      }
    }

    // Backward pass from the first keyframe, decoded in chunks (FFmpeg can't decode in reverse).
    if (backward && kfMasks[0].frameIndex > start) {
      const tracker = new MaskTracker(w, h, kfMasks[0].frame, kfMasks[0].mask, st.model);
      let hi = kfMasks[0].frameIndex - 1;
      const CHUNK = 48;
      while (hi >= start && !tracker.done) {
        const lo = Math.max(start, hi - CHUNK + 1);
        const chunk: Array<{ index: number; data: Uint8Array }> = [];
        for await (const f of st.frames.stream(lo, hi - lo + 1, cb.signal)) chunk.push({ index: f.index, data: f.data.slice() });
        for (let c = chunk.length - 1; c >= 0; c--) {
          abortIfNeeded(cb.signal);
          if (tracker.done) break;
          const m = tracker.step(chunk[c].data);
          await cb.onFrame(chunk[c].index, area(m) ? m : null);
          tick();
        }
        await yieldToEventLoop();
        hi = lo - 1;
      }
    }
    cb.onProgress?.(total, total);
  }
}
