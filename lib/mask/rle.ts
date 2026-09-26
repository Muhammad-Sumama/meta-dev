/**
 * Uncompressed run-length encoding for binary masks (COCO-style ordering but
 * row-major). `counts` alternates background/foreground runs and always starts
 * with a background run (which may be 0).
 *
 * Shared between the server (providers, export) and the browser (overlay
 * rendering, brush editing), so it has no Node or DOM dependencies.
 */

export type RLECounts = number[];

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function encodeMask(mask: ArrayLike<number>): RLECounts {
  const counts: number[] = [];
  let current = 0;
  let run = 0;
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 1 : 0;
    if (v === current) {
      run++;
    } else {
      counts.push(run);
      current = v;
      run = 1;
    }
  }
  counts.push(run);
  return counts;
}

export function decodeMask(counts: RLECounts, length: number, out?: Uint8Array): Uint8Array {
  const mask = out ?? new Uint8Array(length);
  if (out) mask.fill(0);
  let pos = 0;
  let value = 0;
  for (let i = 0; i < counts.length && pos < length; i++) {
    const run = counts[i];
    const end = Math.min(length, pos + run);
    if (value) mask.fill(1, pos, end);
    pos = end;
    value ^= 1;
  }
  return mask;
}

export function maskArea(counts: RLECounts): number {
  let area = 0;
  for (let i = 1; i < counts.length; i += 2) area += counts[i];
  return area;
}

export function isEmptyMask(counts: RLECounts | undefined | null): boolean {
  if (!counts || counts.length < 2) return true;
  for (let i = 1; i < counts.length; i += 2) if (counts[i] > 0) return false;
  return true;
}

export function rleTotalLength(counts: RLECounts): number {
  let n = 0;
  for (const c of counts) n += c;
  return n;
}

/** Validates structure: non-negative integers summing to width*height. */
export function isValidRLE(counts: unknown, length: number): counts is RLECounts {
  if (!Array.isArray(counts) || counts.length === 0) return false;
  let total = 0;
  for (const c of counts) {
    if (typeof c !== "number" || !Number.isInteger(c) || c < 0) return false;
    total += c;
  }
  return total === length;
}

export function rleBBox(counts: RLECounts, width: number, height: number): BBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pos = 0;
  for (let i = 0; i < counts.length; i++) {
    const run = counts[i];
    if (i % 2 === 1 && run > 0) {
      const start = pos;
      const end = pos + run - 1;
      const y0 = Math.floor(start / width);
      const y1 = Math.floor(end / width);
      if (y0 < minY) minY = y0;
      if (y1 > maxY) maxY = y1;
      if (y0 === y1) {
        const x0 = start % width;
        const x1 = end % width;
        if (x0 < minX) minX = x0;
        if (x1 > maxX) maxX = x1;
      } else {
        minX = 0;
        maxX = width - 1;
      }
    }
    pos += run;
  }
  if (maxX < 0) return null;
  void height;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function bboxOfMask(mask: Uint8Array, width: number, height: number): BBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Contiguous frame ranges (inclusive) that contain a non-empty mask.
 * Frames are keyed by stringified frame index.
 */
export function coverageRanges(frames: Record<string, RLECounts>, maxGap = 1): Array<[number, number]> {
  const indices = Object.keys(frames)
    .filter((k) => !isEmptyMask(frames[k]))
    .map(Number)
    .sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const idx of indices) {
    const last = ranges[ranges.length - 1];
    if (last && idx - last[1] <= maxGap) last[1] = idx;
    else ranges.push([idx, idx]);
  }
  return ranges;
}

/**
 * Returns the mask for `frame`, falling back to the nearest analyzed frame at
 * or before it (within `maxLookback`). Supports tracks analyzed with a stride.
 */
export function maskForFrame(
  frames: Record<string, RLECounts>,
  frame: number,
  maxLookback = 2,
): { frame: number; counts: RLECounts } | null {
  for (let f = frame; f >= Math.max(0, frame - maxLookback); f--) {
    const counts = frames[f];
    if (counts) return { frame: f, counts };
  }
  return null;
}
