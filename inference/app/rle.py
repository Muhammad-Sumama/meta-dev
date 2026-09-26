"""Row-major run-length encoding shared with the Node app (lib/mask/rle.ts).

`counts` alternates background/foreground runs over the mask flattened in
row-major (C) order and always starts with a background run (possibly 0).
Note: this is NOT COCO's column-major RLE.
"""

from __future__ import annotations

import numpy as np


def encode(mask: np.ndarray) -> list[int]:
    flat = np.asarray(mask, dtype=bool).ravel(order="C")
    if flat.size == 0:
        return [0]
    # Indices where the value changes.
    change = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    bounds = np.concatenate(([0], change, [flat.size]))
    runs = np.diff(bounds).tolist()
    if flat[0]:
        runs = [0] + runs
    return [int(r) for r in runs]


def decode(counts: list[int], height: int, width: int) -> np.ndarray:
    total = height * width
    if sum(counts) != total or any(c < 0 for c in counts):
        raise ValueError("RLE does not match mask size")
    out = np.zeros(total, dtype=bool)
    pos = 0
    value = False
    for c in counts:
        if value:
            out[pos : pos + c] = True
        pos += c
        value = not value
    return out.reshape(height, width)
