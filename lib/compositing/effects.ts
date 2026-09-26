import type { EffectType } from "@/lib/schemas/command";

/**
 * Per-frame compositing on RGBA buffers (pure). The browser preview renders
 * the same effects with Canvas 2D; export uses these functions so the output
 * matches the preview.
 */

export interface EffectParams {
  effect: EffectType;
  backgroundColor: string;
  blurStrength: number;
  dim: number;
  /** For "none": tint the subject so the export shows the mask. */
  overlayColor?: string;
  /** Clean plate (RGBA, same size) for remove_object. */
  plate?: Uint8Array | null;
  /** Whether the output format stores alpha. */
  keepAlpha: boolean;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Blur radius in output pixels for a 0..1 strength (relative to frame height). */
export function blurRadiusFor(strength: number, H: number): number {
  return Math.max(1, Math.round(H * (0.004 + 0.03 * strength)));
}

/**
 * Gaussian-like blur of the RGB channels of an RGBA frame, computed at reduced
 * resolution (blur is low-frequency, so this is visually lossless) and
 * bilinearly upsampled.
 *
 * With `weight` (0..255 per pixel) it performs normalized convolution:
 * blur(frame·w) / blur(w). Used for background blur so the subject's colors
 * don't bleed into the blurred background as a halo.
 */
export function blurRGBA(frame: Uint8Array, W: number, H: number, radius: number, weight?: Uint8Array): Uint8Array {
  const f = radius >= 12 ? 4 : 2;
  const sw = Math.max(1, Math.ceil(W / f));
  const sh = Math.max(1, Math.ceil(H / f));
  const channels = weight ? 4 : 3;
  const planes: Float32Array[] = [];
  for (let c = 0; c < channels; c++) planes.push(new Float32Array(sw * sh));

  // Box downsample (optionally premultiplied by weight).
  const counts = new Float32Array(sw * sh);
  const colIdx = new Int32Array(W);
  for (let x = 0; x < W; x++) colIdx[x] = (x / f) | 0;
  for (let y = 0; y < H; y++) {
    const rowBase = ((y / f) | 0) * sw;
    for (let x = 0; x < W; x++) {
      const j = rowBase + colIdx[x];
      const q = (y * W + x) * 4;
      const wgt = weight ? weight[y * W + x] / 255 : 1;
      planes[0][j] += frame[q] * wgt;
      planes[1][j] += frame[q + 1] * wgt;
      planes[2][j] += frame[q + 2] * wgt;
      if (weight) planes[3][j] += wgt;
      counts[j]++;
    }
  }
  const r = radius / f;
  for (let c = 0; c < channels; c++) {
    const plane = planes[c];
    for (let j = 0; j < plane.length; j++) plane[j] /= counts[j];
    boxBlurFloat(plane, sw, sh, r, 3);
  }

  // Precomputed bilinear tables.
  const x0s = new Int32Array(W);
  const x1s = new Int32Array(W);
  const wxs = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const fx = Math.max(0, (x + 0.5) / f - 0.5);
    x0s[x] = Math.min(sw - 1, Math.floor(fx));
    x1s[x] = Math.min(sw - 1, x0s[x] + 1);
    wxs[x] = fx - x0s[x];
  }
  const out = new Uint8Array(W * H * 4);
  const [R, G, B, Wt] = planes;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, (y + 0.5) / f - 0.5);
    const y0 = Math.min(sh - 1, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    const r0 = y0 * sw;
    const r1 = y1 * sw;
    for (let x = 0; x < W; x++) {
      const a = r0 + x0s[x];
      const b2 = r0 + x1s[x];
      const c = r1 + x0s[x];
      const d = r1 + x1s[x];
      const wx = wxs[x];
      const k00 = (1 - wx) * (1 - wy);
      const k01 = wx * (1 - wy);
      const k10 = (1 - wx) * wy;
      const k11 = wx * wy;
      let rr = R[a] * k00 + R[b2] * k01 + R[c] * k10 + R[d] * k11;
      let gg = G[a] * k00 + G[b2] * k01 + G[c] * k10 + G[d] * k11;
      let bb = B[a] * k00 + B[b2] * k01 + B[c] * k10 + B[d] * k11;
      if (Wt) {
        const ww = Wt[a] * k00 + Wt[b2] * k01 + Wt[c] * k10 + Wt[d] * k11;
        if (ww > 0.01) {
          rr /= ww;
          gg /= ww;
          bb /= ww;
        }
      }
      const q = (y * W + x) * 4;
      out[q] = rr;
      out[q + 1] = gg;
      out[q + 2] = bb;
      out[q + 3] = 255;
    }
  }
  return out;
}

/** Separable box blur on a float plane (in place); 3 passes ≈ Gaussian. */
export function boxBlurFloat(data: Float32Array, W: number, H: number, radius: number, passes = 3) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return;
  const tmp = new Float32Array(W * H);
  const div = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += data[row + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = acc / div;
        acc += data[row + Math.min(W - 1, x + r + 1)] - data[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        data[y * W + x] = acc / div;
        acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
  }
}

/**
 * Applies the effect in place on `frame` (RGBA) using `alpha` (0..255 per pixel).
 */
export function applyEffect(frame: Uint8Array, alpha: Uint8Array, W: number, H: number, p: EffectParams): Uint8Array {
  const n = W * H;
  switch (p.effect) {
    case "none": {
      const [r, g, b] = hexToRgb(p.overlayColor ?? "#c6f432");
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const a = (alpha[i] / 255) * 0.5;
        if (a <= 0) continue;
        frame[q] += (r - frame[q]) * a;
        frame[q + 1] += (g - frame[q + 1]) * a;
        frame[q + 2] += (b - frame[q + 2]) * a;
      }
      return frame;
    }
    case "remove_background": {
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const a = alpha[i];
        if (p.keepAlpha) {
          frame[q + 3] = a;
        } else {
          const k = a / 255;
          frame[q] *= k;
          frame[q + 1] *= k;
          frame[q + 2] *= k;
          frame[q + 3] = 255;
        }
      }
      return frame;
    }
    case "replace_background": {
      const [r, g, b] = hexToRgb(p.backgroundColor);
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const k = alpha[i] / 255;
        frame[q] = frame[q] * k + r * (1 - k);
        frame[q + 1] = frame[q + 1] * k + g * (1 - k);
        frame[q + 2] = frame[q + 2] * k + b * (1 - k);
        frame[q + 3] = 255;
      }
      return frame;
    }
    case "blur_background":
    case "blur_object": {
      const bgBlur = p.effect === "blur_background";
      let weight: Uint8Array | undefined;
      if (bgBlur) {
        weight = new Uint8Array(n);
        for (let i = 0; i < n; i++) weight[i] = 255 - alpha[i];
      }
      const blurred = blurRGBA(frame, W, H, blurRadiusFor(p.blurStrength, H), weight);
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const k = bgBlur ? alpha[i] / 255 : 1 - alpha[i] / 255;
        frame[q] = frame[q] * k + blurred[q] * (1 - k);
        frame[q + 1] = frame[q + 1] * k + blurred[q + 1] * (1 - k);
        frame[q + 2] = frame[q + 2] * k + blurred[q + 2] * (1 - k);
      }
      return frame;
    }
    case "highlight": {
      const dim = 1 - p.dim * 0.85;
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const k = alpha[i] / 255;
        if (k >= 1) continue;
        const lum = 0.299 * frame[q] + 0.587 * frame[q + 1] + 0.114 * frame[q + 2];
        for (let c = 0; c < 3; c++) {
          const bg = (frame[q + c] * 0.35 + lum * 0.65) * dim;
          frame[q + c] = frame[q + c] * k + bg * (1 - k);
        }
      }
      return frame;
    }
    case "remove_object": {
      const plate = p.plate;
      if (!plate) return frame;
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        const k = alpha[i] / 255;
        if (k <= 0) continue;
        frame[q] = plate[q] * k + frame[q] * (1 - k);
        frame[q + 1] = plate[q + 1] * k + frame[q + 1] * (1 - k);
        frame[q + 2] = plate[q + 2] * k + frame[q + 2] * (1 - k);
      }
      return frame;
    }
  }
}

/** Grayscale matte frame (white = subject) for mask exports. */
export function alphaToGray(alpha: Uint8Array): Uint8Array {
  return alpha;
}
