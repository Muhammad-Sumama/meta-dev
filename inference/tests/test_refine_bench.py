"""Edge refinement, temporal smoothing and the benchmark's metrics (NumPy only)."""

from __future__ import annotations

import numpy as np

from app.refine import guided_refine, temporal_smooth
from bench.sam3_bench import f_score, j_score


def _scene(seed=0):
    rng = np.random.default_rng(seed)
    h, w = 120, 200
    yy, xx = np.mgrid[0:h, 0:w]
    truth = ((xx - 90) ** 2 / 50**2 + (yy - 60) ** 2 / 35**2) < 1
    rgb = np.where(truth[..., None], [200, 60, 40], [40, 120, 200]).astype(np.float32) + rng.normal(0, 6, (h, w, 3))
    coarse = ((xx - 93) ** 2 / 53**2 + (yy - 58) ** 2 / 33**2) < 1  # a slightly-off model mask
    return np.clip(rgb, 0, 255).astype(np.uint8), truth, coarse


def test_refine_snaps_mask_to_image_edges():
    rgb, truth, coarse = _scene()
    refined = guided_refine(coarse.astype(np.float32), rgb, 8) > 0.5
    assert j_score(refined, truth) > j_score(coarse, truth) + 0.04
    assert f_score(refined, truth) > f_score(coarse, truth)


def test_refine_keeps_flat_regions_and_empty_masks():
    rgb = np.full((60, 80, 3), 128, np.uint8)  # no edges to follow
    a = np.zeros((60, 80), np.float32)
    a[20:40, 20:60] = 1
    assert np.abs(guided_refine(a, rgb, 6) - a).max() < 1e-3
    assert not guided_refine(np.zeros((60, 80), np.float32), rgb, 6).any()


def test_temporal_smooth_removes_single_frame_flicker():
    base = np.zeros((40, 40), np.float32)
    base[10:30, 10:30] = 1
    flicker = base.copy()
    flicker[10:30, 30:34] = 1  # a one-frame bulge
    out = temporal_smooth([base, base, flicker, base, base], window=1)
    assert np.array_equal(out[2] > 0.5, base > 0.5)
    assert np.array_equal(out[0], base)


def test_metrics():
    a = np.zeros((50, 50), bool)
    a[10:40, 10:40] = True
    assert j_score(a, a) == 1.0 and f_score(a, a) == 1.0
    b = np.roll(a, 20, axis=1)
    assert j_score(a, b) < 0.3 and f_score(a, b) < 0.6
    assert j_score(np.zeros_like(a), np.zeros_like(a)) == 1.0
