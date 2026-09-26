import { foregroundMask, type BackgroundModel } from "./background";
import { colorBin, colorHistogram, smoothHistogram } from "./color";
import { labelComponents } from "./components";
import { close, dilate, fillHoles, type Mask } from "./morphology";

/**
 * Frame-to-frame mask tracker for the mock provider (shape-prior tracking).
 *
 * Each step:
 *  1. Evidence = pixels that are foreground (static-camera background
 *     subtraction, when reliable) AND match the object's color model.
 *  2. Translation search: find the shift of the previous mask that best
 *     overlaps the evidence, around the constant-velocity prediction.
 *  3. New mask = evidence inside the shifted shape, plus evidence in a thin
 *     band around it (2px weak / 4px strong color evidence). Band pixels must
 *     also look more like this object than like the *other* moving objects
 *     seen at the keyframe (discriminative color test).
 *  4. Backstop: sudden area growth drops band additions for that frame.
 *
 * Steps 3–4 are what keep a second subject from being absorbed when the two
 * touch or cross — even when they share colors (red shirt vs. red car).
 *
 * All per-frame work runs on a cropped region of interest.
 *
 * Limitations vs. SAM 2: no re-identification after long occlusions, masks
 * grow at most a few pixels per frame, and there's no semantic understanding.
 */

interface Roi {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

function cropRgb(src: Uint8Array, fullW: number, roi: Roi): Uint8Array {
  const out = new Uint8Array(roi.w * roi.h * 3);
  for (let y = 0; y < roi.h; y++) {
    const from = ((roi.y0 + y) * fullW + roi.x0) * 3;
    out.set(src.subarray(from, from + roi.w * 3), y * roi.w * 3);
  }
  return out;
}

const BAND_WEAK = 2;
const BAND_STRONG = 4;
/** Band pixels must be this much more likely under the object's colors than under other objects'. */
const DISCRIMINATION = 1.5;

export class MaskTracker {
  /** Previous mask as pixel indices in full-frame coordinates. */
  private prevIdx: Int32Array;
  private areaEma: number;
  private vx = 0;
  private vy = 0;
  private lost = 0;
  private readonly gate: Float32Array;
  private readonly otherGate: Float32Array;
  private readonly weakThreshold: number;
  private readonly strongThreshold: number;
  done = false;

  constructor(
    private readonly w: number,
    private readonly h: number,
    initFrame: Uint8Array,
    initMask: Mask,
    private readonly model: BackgroundModel | null,
    private readonly maxLost = 12,
  ) {
    this.prevIdx = MaskTracker.indices(initMask);
    this.areaEma = this.prevIdx.length;
    // The color model is fixed at the keyframe; adapting it online lets an
    // occluding subject's colors leak in. ±1-bin smoothing tolerates gradual
    // lighting and compression changes.
    this.gate = smoothHistogram(colorHistogram(initFrame, initMask, 0));
    this.otherGate = MaskTracker.otherColors(w, h, initFrame, initMask, this.prevIdx.length, model);
    const unit = 1 / (27 * Math.max(1, this.prevIdx.length));
    this.weakThreshold = 1.5 * unit;
    this.strongThreshold = 8 * unit;
    if (!this.prevIdx.length) this.done = true;
  }

  /**
   * Color model of the *other* moving subjects: foreground colors across the
   * whole clip minus this object's expected share (its keyframe colors × area
   * × number of samples). Falls back to other foreground in the keyframe.
   */
  private static otherColors(w: number, h: number, frame: Uint8Array, mask: Mask, area: number, model: BackgroundModel | null): Float32Array {
    const empty = new Float32Array(4096);
    if (!model?.motionReliable) return empty;
    const own = colorHistogram(frame, mask, 0); // normalized
    let raw: Float32Array;
    if (model.fgColorCounts && model.fgSamples) {
      raw = new Float32Array(4096);
      const ownTotal = area * model.fgSamples;
      for (let b = 0; b < 4096; b++) raw[b] = Math.max(0, model.fgColorCounts[b] - own[b] * ownTotal);
    } else {
      const fg = foregroundMask(frame, model);
      const near = dilate(mask, w, h, 3);
      const others = new Uint8Array(w * h);
      for (let i = 0; i < others.length; i++) others[i] = fg[i] && !near[i] ? 1 : 0;
      raw = colorHistogram(frame, others, 0);
    }
    let total = 0;
    for (let b = 0; b < 4096; b++) total += raw[b];
    if (total < 20) return empty;
    for (let b = 0; b < 4096; b++) raw[b] /= total;
    return smoothHistogram(raw);
  }

  private static indices(mask: Mask): Int32Array {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    const out = new Int32Array(n);
    let k = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) out[k++] = i;
    return out;
  }

  private lose(out: Uint8Array) {
    this.lost++;
    if (this.lost > this.maxLost) this.done = true;
    return out;
  }

  step(frame: Uint8Array): Mask {
    const { w, h } = this;
    const out = new Uint8Array(w * h);
    if (this.done) return out;

    const k = 1 + this.lost;
    const px = Math.round(this.vx * k);
    const py = Math.round(this.vy * k);
    const speed = Math.hypot(this.vx, this.vy);
    const R = Math.min(24, Math.ceil(3 + 0.6 * speed + this.lost * 2));

    // Bounding box of the previous mask.
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (const i of this.prevIdx) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = R + BAND_STRONG + 3;
    const x0 = Math.max(0, minX + Math.min(0, px) - pad);
    const y0 = Math.max(0, minY + Math.min(0, py) - pad);
    const x1 = Math.min(w, maxX + Math.max(0, px) + pad + 1);
    const y1 = Math.min(h, maxY + Math.max(0, py) + pad + 1);
    if (x1 - x0 < 3 || y1 - y0 < 3) {
      this.done = true;
      return out;
    }
    const roi: Roi = { x0, y0, w: x1 - x0, h: y1 - y0 };
    const rw = roi.w;
    const rh = roi.h;
    const cf = cropRgb(frame, w, roi);

    // 1. Evidence maps.
    const motion = Boolean(this.model?.motionReliable);
    const fg = motion
      ? foregroundMask(cf, { ...this.model!, width: rw, height: rh, data: cropRgb(this.model!.data, w, roi) })
      : null;
    const weak = new Uint8Array(rw * rh);
    const strong = new Uint8Array(rw * rh);
    const distinct = new Uint8Array(rw * rh);
    for (let i = 0; i < weak.length; i++) {
      if (fg && !fg[i]) continue;
      const p = i * 3;
      const bin = colorBin(cf[p], cf[p + 1], cf[p + 2]);
      const s = this.gate[bin];
      if (s >= this.weakThreshold) weak[i] = 1;
      if (s >= this.strongThreshold) strong[i] = 1;
      if (s > DISCRIMINATION * this.otherGate[bin]) distinct[i] = 1;
    }

    // 2. Translation search around the velocity prediction (sampled points).
    const stride = Math.max(1, Math.floor(this.prevIdx.length / 1500));
    let bestDx = px;
    let bestDy = py;
    let bestHits = -1;
    let bestInside = 0;
    let bestDist = Infinity;
    for (let ddy = -R; ddy <= R; ddy++) {
      for (let ddx = -R; ddx <= R; ddx++) {
        const dx = px + ddx;
        const dy = py + ddy;
        let hits = 0;
        let inside = 0;
        for (let s = 0; s < this.prevIdx.length; s += stride) {
          const i = this.prevIdx[s];
          const fx = (i % w) + dx;
          const fy = ((i / w) | 0) + dy;
          if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
          inside++;
          const x = fx - x0;
          const y = fy - y0;
          if (x >= 0 && y >= 0 && x < rw && y < rh && weak[y * rw + x]) hits++;
        }
        const dist = Math.abs(ddx) + Math.abs(ddy);
        // Prefer the shift closest to the prediction on ties.
        if (hits > bestHits || (hits === bestHits && dist < bestDist)) {
          bestHits = hits;
          bestInside = inside;
          bestDx = dx;
          bestDy = dy;
          bestDist = dist;
        }
      }
    }
    // Ratio over samples still inside the frame, so objects exiting the frame aren't "lost" early.
    const sampleCount = Math.ceil(this.prevIdx.length / stride);
    if (bestInside < Math.max(4, sampleCount * 0.03)) {
      this.done = true;
      return out;
    }
    if (bestHits / bestInside < 0.15) return this.lose(out);

    // 3. Shifted shape and acceptance bands.
    const shape = new Uint8Array(rw * rh);
    for (const i of this.prevIdx) {
      const x = (i % w) + bestDx - x0;
      const y = ((i / w) | 0) + bestDy - y0;
      if (x >= 0 && y >= 0 && x < rw && y < rh) shape[y * rw + x] = 1;
    }
    const nearWeak = dilate(shape, rw, rh, BAND_WEAK);
    const nearStrong = dilate(shape, rw, rh, BAND_STRONG);
    const build = (allowBand: boolean) => {
      const r = new Uint8Array(rw * rh);
      for (let i = 0; i < r.length; i++) {
        if (shape[i]) {
          if (weak[i]) r[i] = 1;
        } else if (allowBand && distinct[i] && ((nearWeak[i] && weak[i]) || (nearStrong[i] && strong[i]))) {
          r[i] = 1;
        }
      }
      return fillHoles(close(r, rw, rh, 1), rw, rh);
    };
    let result = build(true);

    // 4. Growth backstop (skip when the object is entering through a frame edge).
    const edgeMargin = Math.ceil(speed) + BAND_STRONG + 1;
    const nearEdge = minX + bestDx <= edgeMargin || minY + bestDy <= edgeMargin || maxX + bestDx >= w - 1 - edgeMargin || maxY + bestDy >= h - 1 - edgeMargin;
    let area = 0;
    for (let i = 0; i < result.length; i++) area += result[i];
    if (!nearEdge && area > Math.max(this.areaEma * 1.25, this.areaEma + 25)) result = build(false);

    // Keep the main body plus parts near it; drop specks (< 4%) and detached
    // pieces far away (typically parts of another subject that were absorbed
    // while touching and are now drifting away with their own motion). An
    // object split by an occluder keeps both halves because the gap is small
    // relative to the object's size.
    const lab = labelComponents(result, rw, rh);
    let total = 0;
    let main = lab.components[0];
    for (const c of lab.components) {
      total += c.area;
      if (c.area > main.area) main = c;
    }
    const keep = new Uint8Array(lab.components.length + 1);
    if (main) {
      const size = Math.max(maxX - minX, maxY - minY);
      const reach = Math.max(4, Math.round(size * 0.25));
      const mainMask = new Uint8Array(rw * rh);
      for (let i = 0; i < mainMask.length; i++) if (lab.labels[i] === main.label) mainMask[i] = 1;
      const zone = dilate(mainMask, rw, rh, reach);
      const nearMain = new Uint8Array(lab.components.length + 1);
      for (let i = 0; i < zone.length; i++) if (zone[i] && lab.labels[i]) nearMain[lab.labels[i]] = 1;
      for (const c of lab.components) if (c.area >= total * 0.04 && nearMain[c.label]) keep[c.label] = 1;
    }
    let areaNow = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (keep[lab.labels[y * rw + x]]) {
          out[(y + y0) * w + (x + x0)] = 1;
          areaNow++;
        }
      }
    }
    if (!areaNow) return this.lose(out);

    // Velocity from the measured shift (robust to partial occlusion, unlike the centroid).
    this.vx = 0.5 * this.vx + 0.5 * (bestDx / k);
    this.vy = 0.5 * this.vy + 0.5 * (bestDy / k);
    this.areaEma = 0.85 * this.areaEma + 0.15 * areaNow;
    this.prevIdx = MaskTracker.indices(out);
    this.lost = 0;
    return out;
  }
}
