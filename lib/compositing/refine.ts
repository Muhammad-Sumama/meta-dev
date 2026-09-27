/**
 * Edge-aware alpha refinement: a colour guided filter (He, Sun & Tang,
 * "Guided Image Filtering", 2010) with the video frame as the guide.
 *
 * Masks come from segmentation at analysis resolution (≤ 512 px by default),
 * so after upscaling to 1080p their edges are a few pixels soft and may sit
 * a pixel or two off the real object boundary. The guided filter models the
 * alpha as locally linear in the frame's colours, so transitions move onto
 * the image's own edges (hair, fur and silhouettes against the background)
 * while flat regions keep the mask's value. It is the classical, CPU-only
 * counterpart of a matting network, and runs only over the subject's
 * bounding box (the output is exactly 0 elsewhere).
 */

export interface RefineOptions {
  /** Window radius in output pixels (see refineRadiusFor). */
  radius: number;
  /** Regularization (guide in 0..1): smaller follows image edges more closely. */
  eps?: number;
  /**
   * Local colour variance (sum over RGB, guide in 0..1) at which the refined
   * alpha is fully trusted. Where the frame is flatter (the subject's colour
   * matches the background) there's no edge to follow and a guided filter
   * would only blur the matte, so the result fades back to the input alpha.
   */
  confidentVariance?: number;
}

/**
 * Suggested radius: ~4 analysis-mask pixels in output pixels (tuned on the
 * demo clip against full-resolution ground truth: every subject improved;
 * much larger windows start to blur thin parts), and at least the feather.
 */
export function refineRadiusFor(maskHeight: number, outputHeight: number, featherOutPx = 0) {
  return Math.max(2, Math.round(Math.max((4 * outputHeight) / maskHeight, featherOutPx)));
}

/** Mean over a (2r+1)² window clipped at the borders, via running sums. */
function boxMean(src: Float32Array, w: number, h: number, r: number, out: Float32Array, tmp: Float32Array) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) acc += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r);
      const hi = Math.min(w - 1, x + r);
      tmp[row + x] = acc / (hi - lo + 1);
      if (x + r + 1 < w) acc += src[row + x + r + 1];
      if (x - r >= 0) acc -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r);
      const hi = Math.min(h - 1, y + r);
      out[y * w + x] = acc / (hi - lo + 1);
      if (y + r + 1 < h) acc += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) acc -= tmp[(y - r) * w + x];
    }
  }
}

/**
 * Returns a refined copy of `alpha` (W×H, 0..255) using `rgba` (W×H×4) as the
 * guide. Pixels outside the alpha's bounding box (grown by 2·radius) are 0.
 *
 * Fast guided filter (He & Sun, 2015): the per-pixel linear coefficients are
 * computed on a grid subsampled by `s` (≈ radius/4) and upsampled bilinearly,
 * then applied to the full-resolution frame — so edges still follow the
 * full-resolution image, at a fraction of the cost.
 */
export function refineAlpha(alpha: Uint8Array, rgba: Uint8Array | Uint8ClampedArray, W: number, H: number, opts: RefineOptions & { subsample?: number }): Uint8Array {
  const r = Math.max(1, Math.round(opts.radius));
  const eps = opts.eps ?? 1e-3;
  const tau = opts.confidentVariance ?? 4e-3;
  const s = Math.max(1, Math.round(opts.subsample ?? r / 4));
  const rl = Math.max(1, Math.round(r / s));
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (alpha[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const out = new Uint8Array(W * H);
  if (maxX < 0) return out;
  const x0 = Math.max(0, minX - 2 * r);
  const y0 = Math.max(0, minY - 2 * r);
  const x1 = Math.min(W - 1, maxX + 2 * r);
  const y1 = Math.min(H - 1, maxY + 2 * r);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;

  // Guide and input, block-averaged onto the coarse grid.
  const lw = Math.ceil(w / s);
  const lh = Math.ceil(h / s);
  const n = lw * lh;
  const f = () => new Float32Array(n);
  const Ir = f(), Ig = f(), Ib = f(), P = f();
  for (let ly = 0; ly < lh; ly++) {
    const ys = y0 + ly * s;
    const ye = Math.min(y0 + h, ys + s);
    for (let lx = 0; lx < lw; lx++) {
      const xs = x0 + lx * s;
      const xe = Math.min(x0 + w, xs + s);
      let sr = 0, sg = 0, sb = 0, sp = 0;
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const j = y * W + x;
          sr += rgba[j * 4];
          sg += rgba[j * 4 + 1];
          sb += rgba[j * 4 + 2];
          sp += alpha[j];
        }
      }
      const k = 1 / ((ye - ys) * (xe - xs) * 255);
      const i = ly * lw + lx;
      Ir[i] = sr * k;
      Ig[i] = sg * k;
      Ib[i] = sb * k;
      P[i] = sp * k;
    }
  }

  const tmp = f();
  const scratch = f();
  const mean = (src: Float32Array) => {
    const m = f();
    boxMean(src, lw, lh, rl, m, tmp);
    return m;
  };
  const meanOfProduct = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < n; i++) scratch[i] = a[i] * b[i];
    return mean(scratch);
  };
  const mR = mean(Ir), mG = mean(Ig), mB = mean(Ib), mP = mean(P);
  const mRR = meanOfProduct(Ir, Ir), mRG = meanOfProduct(Ir, Ig), mRB = meanOfProduct(Ir, Ib);
  const mGG = meanOfProduct(Ig, Ig), mGB = meanOfProduct(Ig, Ib), mBB = meanOfProduct(Ib, Ib);
  const mRP = meanOfProduct(Ir, P), mGP = meanOfProduct(Ig, P), mBP = meanOfProduct(Ib, P);

  // Per coarse pixel: a = (Σ + εU)⁻¹ cov(I, p),  b = mean(p) − a·mean(I)
  const aR = f(), aG = f(), aB = f(), b = f(), conf = f();
  for (let i = 0; i < n; i++) {
    const vrr = mRR[i] - mR[i] * mR[i] + eps;
    const vrg = mRG[i] - mR[i] * mG[i];
    const vrb = mRB[i] - mR[i] * mB[i];
    const vgg = mGG[i] - mG[i] * mG[i] + eps;
    const vgb = mGB[i] - mG[i] * mB[i];
    const vbb = mBB[i] - mB[i] * mB[i] + eps;
    const cr = mRP[i] - mR[i] * mP[i];
    const cg = mGP[i] - mG[i] * mP[i];
    const cb = mBP[i] - mB[i] * mP[i];
    // Inverse of the symmetric 3×3 matrix via cofactors.
    const i00 = vgg * vbb - vgb * vgb;
    const i01 = vgb * vrb - vrg * vbb;
    const i02 = vrg * vgb - vgg * vrb;
    const i11 = vrr * vbb - vrb * vrb;
    const i12 = vrb * vrg - vrr * vgb;
    const i22 = vrr * vgg - vrg * vrg;
    const det = vrr * i00 + vrg * i01 + vrb * i02;
    const inv = det > 1e-12 ? 1 / det : 0;
    aR[i] = (i00 * cr + i01 * cg + i02 * cb) * inv;
    aG[i] = (i01 * cr + i11 * cg + i12 * cb) * inv;
    aB[i] = (i02 * cr + i12 * cg + i22 * cb) * inv;
    b[i] = mP[i] - aR[i] * mR[i] - aG[i] * mG[i] - aB[i] * mB[i];
    conf[i] = Math.min(1, (vrr + vgg + vbb - 3 * eps) / tau);
  }
  const maR = mean(aR), maG = mean(aG), maB = mean(aB), mb = mean(b), mc = mean(conf);

  // Upsample the coefficients bilinearly and apply them to the full-resolution guide.
  const colX0 = new Int32Array(w), colX1 = new Int32Array(w), colWx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / s - 0.5));
    colX0[x] = Math.floor(fx);
    colX1[x] = Math.min(lw - 1, colX0[x] + 1);
    colWx[x] = fx - colX0[x];
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / s - 0.5));
    const ly0 = Math.floor(fy);
    const ly1 = Math.min(lh - 1, ly0 + 1);
    const wy = fy - ly0;
    const r0 = ly0 * lw;
    const r1 = ly1 * lw;
    const orow = (y + y0) * W + x0;
    for (let x = 0; x < w; x++) {
      const a = r0 + colX0[x], bI = r0 + colX1[x], c = r1 + colX0[x], d = r1 + colX1[x];
      const wx = colWx[x];
      const w00 = (1 - wx) * (1 - wy), w01 = wx * (1 - wy), w10 = (1 - wx) * wy, w11 = wx * wy;
      const j = (orow + x) * 4;
      const refined =
        (maR[a] * w00 + maR[bI] * w01 + maR[c] * w10 + maR[d] * w11) * (rgba[j] / 255) +
        (maG[a] * w00 + maG[bI] * w01 + maG[c] * w10 + maG[d] * w11) * (rgba[j + 1] / 255) +
        (maB[a] * w00 + maB[bI] * w01 + maB[c] * w10 + maB[d] * w11) * (rgba[j + 2] / 255) +
        (mb[a] * w00 + mb[bI] * w01 + mb[c] * w10 + mb[d] * w11);
      const k = mc[a] * w00 + mc[bI] * w01 + mc[c] * w10 + mc[d] * w11;
      const q = k * refined + (1 - k) * (alpha[orow + x] / 255);
      out[orow + x] = q <= 0 ? 0 : q >= 1 ? 255 : Math.round(q * 255);
    }
  }
  return out;
}
