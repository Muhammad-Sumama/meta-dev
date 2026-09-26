import { openAsBlob } from "node:fs";
import { AppError } from "@/lib/errors";
import { decodeMask, encodeMask, isValidRLE } from "@/lib/mask/rle";
import type { FramePrompt, PointPrompt } from "@/lib/schemas/project";
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
} from "../ai/types";

/**
 * Production segmentation provider: an HTTP client for the SAM 2 inference
 * server in `inference/` (FastAPI + PyTorch, GPU recommended).
 *
 *   SEGMENTATION_PROVIDER=sam2
 *   SAM2_SERVICE_URL=http://gpu-host:8008
 *   SAM2_API_KEY=…                 (optional shared secret)
 *   SAM2_SHARED_STORAGE=true       (send file paths instead of uploading)
 *
 * Wire format for masks: row-major RLE `counts` starting with a background
 * run, at the requested mask_width × mask_height (see inference/README.md).
 */

export interface SAM2ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  sharedStorage: boolean;
  fetchImpl?: typeof fetch;
}

interface WireMask {
  counts: number[];
  size: [number, number];
}

type Box = [number, number, number, number];

function boxToWire(b: { x0: number; y0: number; x1: number; y1: number } | undefined): Box | null {
  return b ? [b.x0, b.y0, b.x1, b.y1] : null;
}

export class SAM2Provider implements SegmentationProvider {
  readonly info: ProviderInfo = {
    id: "sam2",
    name: "SAM 2",
    kind: "production",
    description: "Segment Anything Model 2 video predictor served by the OpenSAM inference server.",
  };
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: SAM2ProviderConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private url(path: string) {
    return `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(json = true): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
  }

  private async request(path: string, init: RequestInit, opts: CallOptions & { timeoutMs?: number } = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.cfg.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), { ...init, signal });
    } catch (err) {
      if (opts.signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      if (timeout.aborted) throw new AppError("AI_TIMEOUT", { message: "The segmentation model took too long.", cause: err });
      throw new AppError("MODEL_UNAVAILABLE", { message: "We couldn't reach the SAM 2 server.", cause: err });
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError("MODEL_UNAVAILABLE", { message: "The SAM 2 server rejected our credentials.", hint: "Check SAM2_API_KEY." });
    }
    if (res.status === 507 || res.status === 413) throw new AppError("INSUFFICIENT_RESOURCES", { message: "The GPU server ran out of memory for this video." });
    if (res.status === 503) throw new AppError("MODEL_UNAVAILABLE", { message: "SAM 2 is still loading or unavailable." });
    return res;
  }

  private async json<T>(res: Response, fallback: "SEGMENTATION_FAILED" | "TRACKING_FAILED"): Promise<T> {
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new AppError(fallback, { cause: new Error(`HTTP ${res.status}: ${detail.slice(0, 500)}`) });
    }
    try {
      return (await res.json()) as T;
    } catch (cause) {
      throw new AppError("INVALID_AI_RESPONSE", { cause });
    }
  }

  private decode(session: VideoSession, m: WireMask | undefined): Uint8Array {
    const n = session.width * session.height;
    if (!m || !isValidRLE(m.counts, n)) throw new AppError("INVALID_AI_RESPONSE", { message: "The segmentation server returned an invalid mask." });
    return decodeMask(m.counts, n);
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(this.url("/health"), { headers: this.headers(), signal: AbortSignal.timeout(4000) });
      const body = (await res.json().catch(() => ({}))) as { status?: string; model?: string; device?: string; grounding?: boolean };
      if (!res.ok || body.status === "error") return { status: "unavailable", message: "SAM 2 server reported an error." };
      if (body.status === "loading") return { status: "degraded", message: "SAM 2 is loading the model…" };
      return {
        status: "ready",
        message: `SAM 2 ready (${body.model ?? "model"} on ${body.device ?? "device"}).`,
        latencyMs: Date.now() - t0,
        details: { grounding: body.grounding ?? false },
      };
    } catch {
      return { status: "unavailable", message: "Can't reach the SAM 2 server." };
    }
  }

  async initializeVideo(source: VideoSource, opts: CallOptions = {}): Promise<VideoSession> {
    const sessionId = `${source.projectId}-${source.version}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const session: VideoSession = {
      id: sessionId,
      providerId: this.info.id,
      source,
      width: source.maskWidth,
      height: source.maskHeight,
      notes: [],
    };
    const existing = await this.request(`/v1/sessions/${sessionId}`, { headers: this.headers() }, { ...opts, timeoutMs: 15_000 });
    if (existing.ok) return session;

    const meta = { session_id: sessionId, mask_width: source.maskWidth, mask_height: source.maskHeight, fps: source.fps, frame_count: source.frameCount };
    let res: Response;
    if (this.cfg.sharedStorage) {
      res = await this.request("/v1/sessions", { method: "POST", headers: this.headers(), body: JSON.stringify({ ...meta, video_path: source.filePath }) }, opts);
    } else {
      const form = new FormData();
      form.set("meta", JSON.stringify(meta));
      form.set("video", await openAsBlob(source.filePath), "source");
      res = await this.request("/v1/sessions", { method: "POST", headers: this.headers(false), body: form }, opts);
    }
    await this.json<unknown>(res, "SEGMENTATION_FAILED");
    return session;
  }

  async locateObjects(session: VideoSession, frameIndices: number[], query: TargetQuery, opts: CallOptions = {}): Promise<Detection[]> {
    const res = await this.request(
      `/v1/sessions/${session.id}/ground`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ frame_indices: frameIndices, text: query.description }) },
      opts,
    );
    if (res.status === 501) {
      throw new AppError("MODEL_UNAVAILABLE", {
        message: "Text grounding isn't enabled on the SAM 2 server.",
        hint: "Enable GROUNDING_MODEL on the inference server, or click the object instead.",
      });
    }
    const body = await this.json<{ detections?: Array<{ frame_index: number; box: Box; score: number; label?: string }> }>(res, "SEGMENTATION_FAILED");
    return (body.detections ?? [])
      .filter((d) => Array.isArray(d.box) && d.box.length === 4 && d.box.every((v) => Number.isFinite(v)))
      .map((d) => ({
        frameIndex: d.frame_index,
        box: { x0: Math.max(0, d.box[0]), y0: Math.max(0, d.box[1]), x1: Math.min(1, d.box[2]), y1: Math.min(1, d.box[3]) },
        score: Math.max(0, Math.min(1, d.score)),
        label: d.label ?? query.description,
      }));
  }

  async segmentFrame(session: VideoSession, prompt: FramePrompt, opts: CallOptions = {}): Promise<MaskResult> {
    const res = await this.request(
      `/v1/sessions/${session.id}/segment`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          frame_index: prompt.frameIndex,
          points: prompt.points.map((p) => [p.x, p.y]),
          labels: prompt.points.map((p) => p.label),
          box: boxToWire(prompt.box),
        }),
      },
      opts,
    );
    const body = await this.json<{ frame_index: number; score: number; mask: WireMask }>(res, "SEGMENTATION_FAILED");
    return { frameIndex: prompt.frameIndex, mask: this.decode(session, body.mask), score: body.score ?? 0 };
  }

  async refineMask(
    session: VideoSession,
    req: { frameIndex: number; mask: Uint8Array; points: PointPrompt[] },
    opts: CallOptions = {},
  ): Promise<MaskResult> {
    const res = await this.request(
      `/v1/sessions/${session.id}/segment`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          frame_index: req.frameIndex,
          points: req.points.map((p) => [p.x, p.y]),
          labels: req.points.map((p) => p.label),
          mask: { counts: encodeMask(req.mask), size: [session.height, session.width] },
        }),
      },
      opts,
    );
    const body = await this.json<{ score: number; mask: WireMask }>(res, "SEGMENTATION_FAILED");
    return { frameIndex: req.frameIndex, mask: this.decode(session, body.mask), score: body.score ?? 0 };
  }

  async trackObject(session: VideoSession, req: TrackRequest, cb: TrackCallbacks): Promise<void> {
    const res = await this.request(
      `/v1/sessions/${session.id}/propagate`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          keyframes: req.keyframes.map((k) => ({
            frame_index: k.frameIndex,
            points: k.points.map((p) => [p.x, p.y]),
            labels: k.points.map((p) => p.label),
            box: boxToWire(k.box),
            mask: k.mask ? { counts: encodeMask(k.mask), size: [session.height, session.width] } : null,
          })),
          start_frame: req.startFrame,
          end_frame: req.endFrame,
          direction: req.direction,
        }),
      },
      { signal: cb.signal },
    );
    if (!res.ok || !res.body) await this.json(res, "TRACKING_FAILED");

    // NDJSON stream: progress / mask / error / done events.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    const handle = async (line: string) => {
      if (!line.trim()) return;
      let ev: { type?: string; frame_index?: number; counts?: number[]; done?: number; total?: number; message?: string };
      try {
        ev = JSON.parse(line);
      } catch (cause) {
        throw new AppError("INVALID_AI_RESPONSE", { cause });
      }
      if (ev.type === "mask" && typeof ev.frame_index === "number") {
        const mask = this.decode(session, { counts: ev.counts ?? [], size: [session.height, session.width] });
        await cb.onFrame(ev.frame_index, mask.some((v) => v) ? mask : null);
      } else if (ev.type === "progress") {
        cb.onProgress?.(ev.done ?? 0, ev.total ?? 0);
      } else if (ev.type === "error") {
        throw new AppError("TRACKING_FAILED", { cause: new Error(ev.message ?? "SAM 2 propagation failed") });
      } else if (ev.type === "done") {
        finished = true;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        await handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    await handle(buf);
    if (!finished) throw new AppError("TRACKING_FAILED", { message: "The SAM 2 server stopped before finishing." });
  }

  async disposeVideo(session: VideoSession): Promise<void> {
    await this.request(`/v1/sessions/${session.id}`, { method: "DELETE", headers: this.headers() }, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}
