/**
 * Clean-plate reconstruction for "remove object" (pure).
 *
 * For each pixel, take the median of that pixel across sampled frames where
 * the object mask does NOT cover it — i.e. what the scene looks like without
 * the object. This is exact for locked-off shots with a moving subject. Pixels
 * the object covers in every sample are filled from their surroundings with
 * a push-pull (pyramid) fill.
 *
 * It is not generative inpainting: a moving camera or a subject that never
 * moves will leave smeared fills. A video inpainting model (e.g. ProPainter)
 * is the production replacement — see README "Roadmap".
 */
export interface PlateSample {
  /** RGBA frame. */
  rgba: Uint8Array;
  /** Alpha matte (0..255), same size. */
  alpha: Uint8Array;
}

export function computeCleanPlate(samples: PlateSample[], W: number, H: number, alphaThreshold = 24): { plate: Uint8Array; holeFraction: number } {
  const n = W * H;
  const plate = new Uint8Array(n * 4);
  const known = new Uint8Array(n);
  const vals = new Uint8Array(samples.length);
  let holes = 0;
  for (let i = 0, q = 0; i < n; i++, q += 4) {
    for (let c = 0; c < 3; c++) {
      let k = 0;
      for (const s of samples) if (s.alpha[i] < alphaThreshold) vals[k++] = s.rgba[q + c];
      if (k === 0) break;
      const sub = vals.subarray(0, k);
      sub.sort();
      plate[q + c] = sub[k >> 1];
      if (c === 2) known[i] = 1;
    }
    plate[q + 3] = 255;
    if (!known[i]) holes++;
  }
  if (holes > 0) pushPullFill(plate, known, W, H);
  return { plate, holeFraction: holes / n };
}

/** Fills unknown pixels by averaging known ones across a resolution pyramid. */
export function pushPullFill(rgba: Uint8Array, known: Uint8Array, W: number, H: number) {
  if (W <= 1 && H <= 1) return;
  const w2 = Math.max(1, (W + 1) >> 1);
  const h2 = Math.max(1, (H + 1) >> 1);
  const small = new Uint8Array(w2 * h2 * 4);
  const smallKnown = new Uint8Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx;
          const sy = y * 2 + dy;
          if (sx >= W || sy >= H) continue;
          const i = sy * W + sx;
          if (!known[i]) continue;
          r += rgba[i * 4];
          g += rgba[i * 4 + 1];
          b += rgba[i * 4 + 2];
          c++;
        }
      }
      const j = y * w2 + x;
      if (c) {
        small[j * 4] = r / c;
        small[j * 4 + 1] = g / c;
        small[j * 4 + 2] = b / c;
        smallKnown[j] = 1;
      }
      small[j * 4 + 3] = 255;
    }
  }
  let missing = false;
  for (let j = 0; j < smallKnown.length; j++) if (!smallKnown[j]) missing = true;
  if (missing && (w2 > 1 || h2 > 1)) pushPullFill(small, smallKnown, w2, h2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (known[i]) continue;
      const j = Math.min(h2 - 1, y >> 1) * w2 + Math.min(w2 - 1, x >> 1);
      rgba[i * 4] = small[j * 4];
      rgba[i * 4 + 1] = small[j * 4 + 1];
      rgba[i * 4 + 2] = small[j * 4 + 2];
      rgba[i * 4 + 3] = 255;
    }
  }
}
