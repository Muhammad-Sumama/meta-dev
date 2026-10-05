"""Post-processing that OpenSAM Studio applies on top of the model's masks.

* ``guided_refine`` — the colour guided filter from lib/compositing/refine.ts
  (He & Sun fast guided filter with a confidence blend), ported to NumPy so the
  benchmark scores exactly what the web app exports.
* ``temporal_smooth`` — per-pixel median of soft alphas over a small window,
  applied only near the boundary, to remove frame-to-frame edge flicker.

Both work on float alphas in 0..1 and are pure functions (no torch needed).
"""

from __future__ import annotations

import numpy as np


def _box_mean(src: np.ndarray, r: int) -> np.ndarray:
    """Mean over a (2r+1)² window clipped at the borders (running sums)."""
    h, w = src.shape[:2]
    pad = ((1, 0), (1, 0)) + ((0, 0),) * (src.ndim - 2)
    c = np.pad(src, pad).cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w)
    x1 = np.clip(np.arange(w) + r + 1, 0, w)
    s = c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]
    area = ((y1 - y0)[:, None] * (x1 - x0)[None, :]).astype(src.dtype)
    return s / (area if src.ndim == 2 else area[..., None])


def refine_radius_for(mask_height: int, output_height: int, feather_out_px: float = 0) -> int:
    return max(2, round(max(4 * output_height / mask_height, feather_out_px)))


def guided_refine(
    alpha: np.ndarray,
    rgb: np.ndarray,
    radius: int,
    eps: float = 1e-3,
    confident_variance: float = 4e-3,
    subsample: int | None = None,
) -> np.ndarray:
    """Refines a soft alpha (H×W, 0..1) using the frame (H×W×3 uint8) as guide."""
    h, w = alpha.shape
    r = max(1, int(round(radius)))
    s = max(1, int(round(subsample if subsample is not None else r / 4)))
    rl = max(1, int(round(r / s)))
    ys, xs = np.nonzero(alpha > 0)
    out = np.zeros_like(alpha, dtype=np.float32)
    if ys.size == 0:
        return out
    y0, y1 = max(0, ys.min() - 2 * r), min(h, ys.max() + 2 * r + 1)
    x0, x1 = max(0, xs.min() - 2 * r), min(w, xs.max() + 2 * r + 1)
    I = rgb[y0:y1, x0:x1].astype(np.float32) / 255.0
    P = alpha[y0:y1, x0:x1].astype(np.float32)
    ch, cw = P.shape
    lh, lw = -(-ch // s), -(-cw // s)
    # Block-average onto the coarse grid (edge-pad to a multiple of s).
    Ip = np.pad(I, ((0, lh * s - ch), (0, lw * s - cw), (0, 0)), mode="edge").reshape(lh, s, lw, s, 3).mean((1, 3))
    Pp = np.pad(P, ((0, lh * s - ch), (0, lw * s - cw)), mode="edge").reshape(lh, s, lw, s).mean((1, 3))

    mI = _box_mean(Ip, rl)
    mP = _box_mean(Pp, rl)
    mIP = _box_mean(Ip * Pp[..., None], rl)
    cov = mIP - mI * mP[..., None]
    # Σ per pixel (3×3), regularised.
    outer = Ip[..., :, None] * Ip[..., None, :]
    sigma = _box_mean(outer.reshape(lh, lw, 9), rl).reshape(lh, lw, 3, 3) - mI[..., :, None] * mI[..., None, :]
    sigma_reg = sigma + eps * np.eye(3, dtype=np.float32)
    a = np.linalg.solve(sigma_reg, cov[..., None])[..., 0]
    b = mP - (a * mI).sum(-1)
    conf = np.minimum(1.0, (sigma[..., 0, 0] + sigma[..., 1, 1] + sigma[..., 2, 2]) / confident_variance)
    ma, mb, mc = _box_mean(a, rl), _box_mean(b, rl), _box_mean(conf, rl)

    # Bilinear upsample of the coefficients (pixel-centre aligned).
    fy = np.clip((np.arange(ch) + 0.5) / s - 0.5, 0, lh - 1)
    fx = np.clip((np.arange(cw) + 0.5) / s - 0.5, 0, lw - 1)
    y0i, x0i = np.floor(fy).astype(int), np.floor(fx).astype(int)
    y1i, x1i = np.minimum(lh - 1, y0i + 1), np.minimum(lw - 1, x0i + 1)
    wy, wx = (fy - y0i)[:, None], (fx - x0i)[None, :]

    def up(m: np.ndarray) -> np.ndarray:
        if m.ndim == 3:
            return np.stack([up(m[..., k]) for k in range(m.shape[-1])], -1)
        top = m[y0i][:, x0i] * (1 - wx) + m[y0i][:, x1i] * wx
        bot = m[y1i][:, x0i] * (1 - wx) + m[y1i][:, x1i] * wx
        return top * (1 - wy) + bot * wy

    refined = (up(ma) * I).sum(-1) + up(mb)
    k = up(mc)
    q = k * refined + (1 - k) * P
    out[y0:y1, x0:x1] = np.clip(q, 0, 1)
    return out


def temporal_smooth(alphas: list[np.ndarray], window: int = 1, band: int = 3) -> list[np.ndarray]:
    """Median over frames t−window…t+window, only where any frame in the window is uncertain."""
    if window <= 0 or len(alphas) < 3:
        return alphas
    out = []
    n = len(alphas)
    for t in range(n):
        lo, hi = max(0, t - window), min(n, t + window + 1)
        stack = np.stack(alphas[lo:hi])
        med = np.median(stack, axis=0)
        unsure = (stack.max(0) > 0.5) != (stack.min(0) > 0.5)
        if band > 0:
            unsure = _box_mean(unsure.astype(np.float32), band) > 0
        out.append(np.where(unsure, med, alphas[t]).astype(np.float32))
    return out
