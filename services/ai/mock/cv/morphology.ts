/**
 * Binary mask morphology on Uint8Array masks (0 / 1), row-major width×height.
 * All operations are O(n) using running sums, independent of radius.
 */

export type Mask = Uint8Array;

/** Square dilation with radius r (structuring element (2r+1)²). */
export function dilate(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < Math.min(r, w); x++) count += mask[row + x];
    for (let x = 0; x < w; x++) {
      const add = x + r;
      if (add < w) count += mask[row + add];
      const rem = x - r - 1;
      if (rem >= 0) count -= mask[row + rem];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, h); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const add = y + r;
      if (add < h) count += tmp[add * w + x];
      const rem = y - r - 1;
      if (rem >= 0) count -= tmp[rem * w + x];
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

export function invert(mask: Mask): Mask {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 1;
  return out;
}

export function erode(mask: Mask, w: number, h: number, r: number): Mask {
  if (r <= 0) return mask.slice();
  return invert(dilate(invert(mask), w, h, r));
}

export function open(mask: Mask, w: number, h: number, r: number): Mask {
  return dilate(erode(mask, w, h, r), w, h, r);
}

export function close(mask: Mask, w: number, h: number, r: number): Mask {
  return erode(dilate(mask, w, h, r), w, h, r);
}

/** Fills background regions that are not connected to the image border. */
export function fillHoles(mask: Mask, w: number, h: number): Mask {
  const n = w * h;
  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!mask[i] && !reached[i]) {
      reached[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = mask[i] || !reached[i] ? 1 : 0;
  return out;
}

export function union(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

export function intersect(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

export function subtract(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  return out;
}

export function area(mask: Mask): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i] ? 1 : 0;
  return n;
}

export function translate(mask: Mask, w: number, h: number, dx: number, dy: number): Mask {
  const out = new Uint8Array(w * h);
  const ix = Math.round(dx);
  const iy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - ix;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = mask[sy * w + sx];
    }
  }
  return out;
}

export function centroid(mask: Mask, w: number): { x: number; y: number; area: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      sx += i % w;
      sy += (i / w) | 0;
      n++;
    }
  }
  return n ? { x: sx / n, y: sy / n, area: n } : null;
}

export function iou(a: Mask, b: Mask): number {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0;
    const y = b[i] ? 1 : 0;
    inter += x & y;
    uni += x | y;
  }
  return uni ? inter / uni : 0;
}

/** Rectangle mask (inclusive-exclusive pixel bounds, clamped). */
export function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask {
  const out = new Uint8Array(w * h);
  const ax = Math.max(0, Math.floor(x0));
  const ay = Math.max(0, Math.floor(y0));
  const bx = Math.min(w, Math.ceil(x1));
  const by = Math.min(h, Math.ceil(y1));
  for (let y = ay; y < by; y++) out.fill(1, y * w + ax, y * w + bx);
  return out;
}

/** Stamps a filled circle into the mask (value 1 or 0). */
export function stampCircle(mask: Mask, w: number, h: number, cx: number, cy: number, r: number, value: 0 | 1) {
  const r2 = r * r;
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const span = Math.sqrt(Math.max(0, r2 - dy * dy));
    const x0 = Math.max(0, Math.floor(cx - span));
    const x1 = Math.min(w - 1, Math.ceil(cx + span));
    if (x1 >= x0) mask.fill(value, y * w + x0, y * w + x1 + 1);
  }
}
