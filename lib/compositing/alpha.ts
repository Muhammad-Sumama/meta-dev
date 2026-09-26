/**
 * Mask → alpha matte utilities (pure, used by server export and browser preview).
 */

/**
 * Bilinear upscale of a mask to an 8-bit alpha matte. Input values are either
 * 0/1 (`binary`) or 0..255. Only the (scaled) bounding box of non-zero input
 * is computed; the rest of the output is zero.
 */
export function upscaleMask(
  mask: Uint8Array,
  mw: number,
  mh: number,
  W: number,
  H: number,
  out?: Uint8Array,
  binary = true,
): Uint8Array {
  const alpha = out ?? new Uint8Array(W * H);
  if (out) alpha.fill(0);
  let minX = mw, minY = mh, maxX = -1, maxY = -1;
  for (let y = 0; y < mh; y++) {
    const row = y * mw;
    for (let x = 0; x < mw; x++) {
      if (mask[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return alpha;
  const sx = mw / W;
  const sy = mh / H;
  const unit = binary ? 255 : 1;
  const ox0 = Math.max(0, Math.floor((minX - 1) / sx));
  const ox1 = Math.min(W - 1, Math.ceil((maxX + 2) / sx));
  const oy0 = Math.max(0, Math.floor((minY - 1) / sy));
  const oy1 = Math.min(H - 1, Math.ceil((maxY + 2) / sy));
  const x0s = new Int32Array(ox1 - ox0 + 1);
  const x1s = new Int32Array(ox1 - ox0 + 1);
  const wxs = new Float32Array(ox1 - ox0 + 1);
  for (let x = ox0; x <= ox1; x++) {
    const fx = Math.max(0, (x + 0.5) * sx - 0.5);
    const i = x - ox0;
    x0s[i] = Math.min(mw - 1, Math.floor(fx));
    x1s[i] = Math.min(mw - 1, x0s[i] + 1);
    wxs[i] = fx - x0s[i];
  }
  for (let y = oy0; y <= oy1; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(mh - 1, Math.floor(fy));
    const y1 = Math.min(mh - 1, y0 + 1);
    const wy = fy - y0;
    const r0 = y0 * mw;
    const r1 = y1 * mw;
    const orow = y * W;
    for (let x = ox0; x <= ox1; x++) {
      const i = x - ox0;
      const wx = wxs[i];
      const top = mask[r0 + x0s[i]] * (1 - wx) + mask[r0 + x1s[i]] * wx;
      const bot = mask[r1 + x0s[i]] * (1 - wx) + mask[r1 + x1s[i]] * wx;
      alpha[orow + x] = (top * (1 - wy) + bot * wy) * unit + 0.5;
    }
  }
  return alpha;
}

/** In-place separable box blur of a single-channel image; two passes ≈ Gaussian. */
export function boxBlurChannel(data: Uint8Array, W: number, H: number, radius: number, passes = 2): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return data;
  const tmp = new Uint8Array(W * H);
  const div = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += data[row + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = (acc / div) | 0;
        acc += data[row + Math.min(W - 1, x + r + 1)] - data[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        data[y * W + x] = (acc / div) | 0;
        acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
      }
    }
  }
  return data;
}

/** Binary grow (+) / shrink (−) at mask resolution, before upscaling. */
export function growMask(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const r = Math.round(Math.abs(px));
  if (r === 0) return mask;
  const grow = px > 0;
  const src = grow ? mask : mask.map((v) => (v ? 0 : 1));
  // Square dilation via running sums (rows, then columns).
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < Math.min(r, w); x++) c += src[y * w + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) c += src[y * w + x + r];
      if (x - r - 1 >= 0) c -= src[y * w + x - r - 1];
      tmp[y * w + x] = c > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y < Math.min(r, h); y++) c += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) c += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) c -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = c > 0 ? 1 : 0;
    }
  }
  return grow ? out : out.map((v) => (v ? 0 : 1));
}

/**
 * Builds the final alpha matte at output resolution.
 * `expand` and `feather` are in source-video pixels. Feathering runs at mask
 * resolution before the bilinear upscale (equivalent result, far cheaper).
 */
export function buildAlpha(
  masks: Uint8Array[],
  mw: number,
  mh: number,
  W: number,
  H: number,
  opts: { expand: number; feather: number; sourceHeight: number },
): Uint8Array {
  const union = new Uint8Array(mw * mh);
  for (const m of masks) for (let i = 0; i < union.length; i++) if (m[i]) union[i] = 1;
  const toMask = mh / opts.sourceHeight;
  const grown = growMask(union, mw, mh, opts.expand * toMask);
  const featherMask = opts.feather * toMask;
  if (featherMask < 0.35) return upscaleMask(grown, mw, mh, W, H);
  const soft = new Uint8Array(mw * mh);
  for (let i = 0; i < soft.length; i++) soft[i] = grown[i] ? 255 : 0;
  boxBlurChannel(soft, mw, mh, Math.max(1, featherMask / 1.2), 2);
  return upscaleMask(soft, mw, mh, W, H, undefined, false);
}
