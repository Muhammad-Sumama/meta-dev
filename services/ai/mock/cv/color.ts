import type { ColorName } from "@/lib/schemas/command";

/** RGB (0..255) → HSV (h 0..360, s 0..1, v 0..1). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

/** Coarse named-color classification used for text grounding in mock mode. */
export function classifyColor(r: number, g: number, b: number): ColorName | null {
  const [h, s, v] = rgbToHsv(r, g, b);
  if (v < 0.2) return "black";
  if (s < 0.14) return v > 0.82 ? "white" : "gray";
  if (s < 0.25 && v > 0.55) return v > 0.85 ? "white" : "gray";
  if (s < 0.32 && v < 0.42) return v < 0.3 ? "black" : "gray";
  if (h < 14 || h >= 340) return s < 0.45 && v > 0.7 ? "pink" : v < 0.45 ? "brown" : "red";
  if (h < 42) return v < 0.72 || (s > 0.6 && v < 0.8) ? "brown" : "orange";
  if (h < 68) return v < 0.5 ? "brown" : "yellow";
  if (h < 165) return "green";
  if (h < 250) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

/** Perceptually weighted RGB distance (roughly "redmean"). */
export function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((((512 + rm) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rm) * db * db) >> 8)) / 3;
}

/** 12-bit color quantization (4 bits per channel) for histograms. */
export function colorBin(r: number, g: number, b: number): number {
  return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
}

export const HIST_BINS = 4096;

export function colorHistogram(frame: Uint8Array, mask: Uint8Array, smoothing = 0): Float32Array {
  const hist = new Float32Array(HIST_BINS).fill(smoothing);
  let total = smoothing * HIST_BINS;
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    if (!mask[i]) continue;
    hist[colorBin(frame[p], frame[p + 1], frame[p + 2])] += 1;
    total += 1;
  }
  if (total > 0) for (let i = 0; i < HIST_BINS; i++) hist[i] /= total;
  return hist;
}

/**
 * 3×3×3 box blur over the 16³ color grid so colors one quantization step away
 * (compression noise, soft shading) still count as "seen".
 */
export function smoothHistogram(hist: Float32Array): Float32Array {
  const out = new Float32Array(HIST_BINS);
  for (let r = 0; r < 16; r++) {
    for (let g = 0; g < 16; g++) {
      for (let b = 0; b < 16; b++) {
        let s = 0;
        for (let dr = -1; dr <= 1; dr++) {
          const rr = r + dr;
          if (rr < 0 || rr > 15) continue;
          for (let dg = -1; dg <= 1; dg++) {
            const gg = g + dg;
            if (gg < 0 || gg > 15) continue;
            for (let db = -1; db <= 1; db++) {
              const bb = b + db;
              if (bb < 0 || bb > 15) continue;
              s += hist[(rr << 8) | (gg << 4) | bb];
            }
          }
        }
        out[(r << 8) | (g << 4) | b] = s / 27;
      }
    }
  }
  return out;
}

/** Fraction of mask pixels (optionally within a row band) classified as each color. */
export function colorFractions(
  frame: Uint8Array,
  labels: Int32Array,
  label: number,
  w: number,
  rowRange?: [number, number],
): Partial<Record<ColorName, number>> {
  const counts: Partial<Record<ColorName, number>> = {};
  let total = 0;
  const y0 = rowRange ? rowRange[0] : 0;
  const y1 = rowRange ? rowRange[1] : Math.floor(labels.length / w) - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (labels[i] !== label) continue;
      const p = i * 3;
      const c = classifyColor(frame[p], frame[p + 1], frame[p + 2]);
      total++;
      if (c) counts[c] = (counts[c] ?? 0) + 1;
    }
  }
  if (!total) return {};
  for (const k of Object.keys(counts) as ColorName[]) counts[k] = counts[k]! / total;
  return counts;
}
