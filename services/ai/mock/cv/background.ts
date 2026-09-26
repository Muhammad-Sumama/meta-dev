import { close, fillHoles, open } from "./morphology";
import { removeSmall } from "./components";

/**
 * Background model for locked-off (static camera) footage: a per-pixel
 * temporal median over sampled frames. Moving subjects differ from it, which
 * gives whole-object masks (head + shirt + legs), not just color patches.
 */
export interface BackgroundModel {
  width: number;
  height: number;
  /** rgb24 median background. */
  data: Uint8Array;
  /** Foreground threshold on max channel difference. */
  threshold: number;
  /** Median fraction of pixels flagged as foreground across samples. */
  foregroundRatio: number;
  /** False when the camera moves (background subtraction is meaningless). */
  motionReliable: boolean;
  /**
   * Color histogram (4096 bins, raw counts) of foreground pixels across all
   * samples — the colors of everything that moves in the clip. Trackers use it
   * to tell their object apart from other subjects.
   */
  fgColorCounts?: Float32Array;
  fgSamples?: number;
}

function quickSelect(arr: Uint8Array, k: number, n: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = arr[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) {
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return arr[k];
}

export function buildBackgroundModel(samples: Uint8Array[], width: number, height: number): BackgroundModel {
  const n = samples.length;
  const len = width * height * 3;
  const bg = new Uint8Array(len);
  const tmp = new Uint8Array(n);
  const mid = n >> 1;
  for (let p = 0; p < len; p++) {
    for (let s = 0; s < n; s++) tmp[s] = samples[s][p];
    bg[p] = quickSelect(tmp, mid, n);
  }

  // Noise estimate from a deterministic subset of pixels: median absolute deviation.
  const devs: number[] = [];
  const stride = Math.max(1, Math.floor((width * height) / 4000));
  for (let s = 0; s < n; s++) {
    const frame = samples[s];
    for (let i = (s * 7) % stride; i < width * height; i += stride) {
      const p = i * 3;
      devs.push(Math.max(Math.abs(frame[p] - bg[p]), Math.abs(frame[p + 1] - bg[p + 1]), Math.abs(frame[p + 2] - bg[p + 2])));
    }
  }
  devs.sort((a, b) => a - b);
  const mad = devs.length ? devs[devs.length >> 1] : 0;
  const threshold = Math.min(60, Math.max(24, mad * 1.4826 * 5));

  const ratios = samples.map((frame) => {
    let fg = 0;
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      const d = Math.max(Math.abs(frame[p] - bg[p]), Math.abs(frame[p + 1] - bg[p + 1]), Math.abs(frame[p + 2] - bg[p + 2]));
      if (d > threshold) fg++;
    }
    return fg / (width * height);
  });
  ratios.sort((a, b) => a - b);
  const foregroundRatio = ratios[ratios.length >> 1] ?? 1;
  const model: BackgroundModel = {
    width,
    height,
    data: bg,
    threshold,
    foregroundRatio,
    motionReliable: n >= 5 && foregroundRatio < 0.3,
  };
  if (model.motionReliable) {
    const counts = new Float32Array(4096);
    for (const frame of samples) {
      const fg = foregroundMask(frame, model);
      for (let i = 0, p = 0; i < fg.length; i++, p += 3) {
        if (fg[i]) counts[((frame[p] >> 4) << 8) | ((frame[p + 1] >> 4) << 4) | (frame[p + 2] >> 4)]++;
      }
    }
    model.fgColorCounts = counts;
    model.fgSamples = samples.length;
  }
  return model;
}

/**
 * Raw foreground mask with shadow suppression: a pixel darker than the
 * background by a moderate factor but with the same chromaticity is treated as
 * a cast shadow, not an object.
 */
export function rawForeground(frame: Uint8Array, model: BackgroundModel): Uint8Array {
  const { width, height, data: bg, threshold } = model;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 3) {
    const r = frame[p];
    const g = frame[p + 1];
    const b = frame[p + 2];
    const br = bg[p];
    const bgG = bg[p + 1];
    const bb = bg[p + 2];
    const d = Math.max(Math.abs(r - br), Math.abs(g - bgG), Math.abs(b - bb));
    if (d <= threshold) continue;
    const lum = r + g + b + 1;
    const blum = br + bgG + bb + 1;
    const ratio = lum / blum;
    if (ratio > 0.5 && ratio < 0.97) {
      const chroma =
        Math.abs(r / lum - br / blum) + Math.abs(g / lum - bgG / blum) + Math.abs(b / lum - bb / blum);
      if (chroma < 0.045) continue; // shadow
    }
    out[i] = 1;
  }
  return out;
}

/** Cleaned foreground: denoise, bridge small gaps, fill holes, drop specks. */
export function foregroundMask(frame: Uint8Array, model: BackgroundModel): Uint8Array {
  const { width: w, height: h } = model;
  let m = rawForeground(frame, model);
  m = open(m, w, h, 1);
  m = close(m, w, h, 2);
  m = fillHoles(m, w, h);
  return removeSmall(m, w, h, Math.max(12, Math.round(w * h * 0.0002)));
}
