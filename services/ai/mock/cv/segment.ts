import { colorBin, colorDistance, colorHistogram, HIST_BINS } from "./color";
import { componentMask, labelComponents, largestComponent } from "./components";
import { close, dilate, fillHoles, open, rectMask } from "./morphology";

/**
 * Prompt-driven segmentation primitives used by the mock provider when the
 * foreground model can't answer (moving camera, static objects).
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Color region growing from seed points. A pixel joins when it is close to
 * the seed color model AND not across a strong edge from its neighbor.
 */
export function regionGrow(
  frame: Uint8Array,
  w: number,
  h: number,
  seeds: Point[],
  opts: { tolerance?: number; maxAreaFraction?: number; constraint?: Uint8Array } = {},
): Uint8Array {
  const tolerance = opts.tolerance ?? 26;
  const maxArea = Math.floor(w * h * (opts.maxAreaFraction ?? 0.4));
  const out = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  // Seed color = mean of 3×3 neighborhoods around seeds.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sc = 0;
  for (const s of seeds) {
    const cx = Math.round(s.x);
    const cy = Math.round(s.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const p = (y * w + x) * 3;
        sr += frame[p];
        sg += frame[p + 1];
        sb += frame[p + 2];
        sc++;
      }
    }
  }
  if (!sc) return out;
  sr /= sc;
  sg /= sc;
  sb /= sc;

  for (const s of seeds) {
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (opts.constraint && !opts.constraint[i]) continue;
    if (!out[i]) {
      out[i] = 1;
      queue[tail++] = i;
    }
  }

  const edgeTol = tolerance * 0.9;
  while (head < tail && tail < maxArea) {
    const i = queue[head++];
    const x = i % w;
    const p = i * 3;
    const neighbors = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1];
    for (const j of neighbors) {
      if (j < 0 || out[j]) continue;
      if (opts.constraint && !opts.constraint[j]) continue;
      const q = j * 3;
      const d = colorDistance(frame[q], frame[q + 1], frame[q + 2], sr, sg, sb);
      if (d > tolerance) continue;
      const e = colorDistance(frame[q], frame[q + 1], frame[q + 2], frame[p], frame[p + 1], frame[p + 2]);
      if (e > edgeTol) continue;
      out[j] = 1;
      queue[tail++] = j;
    }
  }
  return fillHoles(close(out, w, h, 1), w, h);
}

/**
 * GrabCut-style box segmentation without graph cuts: iteratively re-estimated
 * foreground/background color histograms, then the component nearest the box
 * center. Works well for objects that differ in color from their surroundings.
 */
export function segmentBoxByColor(
  frame: Uint8Array,
  w: number,
  h: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  iterations = 3,
): Uint8Array {
  const bx0 = Math.max(0, Math.floor(box.x0));
  const by0 = Math.max(0, Math.floor(box.y0));
  const bx1 = Math.min(w, Math.ceil(box.x1));
  const by1 = Math.min(h, Math.ceil(box.y1));
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw < 3 || bh < 3) return new Uint8Array(w * h);

  const inBox = rectMask(w, h, bx0, by0, bx1, by1);
  const ring = dilate(inBox, w, h, Math.max(4, Math.round(Math.min(bw, bh) * 0.15)));
  const bgSample = new Uint8Array(w * h);
  for (let i = 0; i < bgSample.length; i++) bgSample[i] = ring[i] && !inBox[i] ? 1 : 0;
  // Box border band also counts as background evidence (the user drew a loose box).
  const band = Math.max(1, Math.round(Math.min(bw, bh) * 0.04));
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      if (x - bx0 < band || bx1 - 1 - x < band || y - by0 < band || by1 - 1 - y < band) bgSample[y * w + x] = 1;
    }
  }
  let fgSample: Uint8Array = rectMask(w, h, bx0 + bw * 0.25, by0 + bh * 0.2, bx1 - bw * 0.25, by1 - bh * 0.2);

  let result: Uint8Array = new Uint8Array(w * h);
  const bgHist = colorHistogram(frame, bgSample, 0.5 / HIST_BINS);
  for (let it = 0; it < iterations; it++) {
    const fgHist = colorHistogram(frame, fgSample, 0.5 / HIST_BINS);
    result = new Uint8Array(w * h);
    for (let y = by0; y < by1; y++) {
      for (let x = bx0; x < bx1; x++) {
        const i = y * w + x;
        const p = i * 3;
        const bin = colorBin(frame[p], frame[p + 1], frame[p + 2]);
        if (fgHist[bin] > bgHist[bin] * 1.15) result[i] = 1;
      }
    }
    result = close(open(result, w, h, 1), w, h, 1);
    fgSample = result;
  }
  // Keep the component closest to the box center.
  const lab = labelComponents(result, w, h);
  if (!lab.components.length) return result;
  const cx = (bx0 + bx1) / 2;
  const cy = (by0 + by1) / 2;
  const best = lab.components.reduce((a, b) => {
    const score = (c: typeof a) => c.area / (1 + Math.hypot(c.cx - cx, c.cy - cy) / Math.max(bw, bh));
    return score(b) > score(a) ? b : a;
  });
  return fillHoles(componentMask(lab, best.label), w, h);
}

/** Pixels of `mask` reachable from `point` through similar colors (for negative clicks). */
export function carveRegion(frame: Uint8Array, w: number, h: number, mask: Uint8Array, point: Point, tolerance = 22) {
  const region = regionGrow(frame, w, h, [point], { tolerance, constraint: mask, maxAreaFraction: 1 });
  return region;
}

export { largestComponent };
