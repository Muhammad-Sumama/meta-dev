import { decodeMask, encodeMask, isEmptyMask, type RLECounts } from "./rle";

/** Pure mask-editing operations used by the brush/eraser tools (browser) and tests. */

export interface Pt {
  x: number;
  y: number;
}

export function stampCircle(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, value: 0 | 1) {
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const span = Math.sqrt(Math.max(0, r2 - dy * dy));
    const x0 = Math.max(0, Math.round(cx - span));
    const x1 = Math.min(w - 1, Math.round(cx + span) - 1);
    if (x1 >= x0) mask.fill(value, y * w + x0, y * w + x1 + 1);
  }
}

/** Stamps circles along a polyline (points in mask pixel coordinates). */
export function stampStroke(mask: Uint8Array, w: number, h: number, pts: Pt[], radius: number, value: 0 | 1) {
  if (!pts.length) return mask;
  const step = Math.max(0.5, radius * 0.35);
  stampCircle(mask, w, h, pts[0].x, pts[0].y, radius, value);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      stampCircle(mask, w, h, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius, value);
    }
  }
  return mask;
}

/** Applies a stroke to RLE counts; returns null when the result is empty. */
export function applyStrokeToCounts(
  counts: RLECounts | null | undefined,
  w: number,
  h: number,
  pts: Pt[],
  radius: number,
  value: 0 | 1,
): RLECounts | null {
  const mask = counts ? decodeMask(counts, w * h) : new Uint8Array(w * h);
  stampStroke(mask, w, h, pts, radius, value);
  const out = encodeMask(mask);
  return isEmptyMask(out) ? null : out;
}
