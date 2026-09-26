import { describe, expect, it } from "vitest";
import {
  bboxOfMask,
  coverageRanges,
  decodeMask,
  encodeMask,
  isEmptyMask,
  isValidRLE,
  maskArea,
  maskForFrame,
  rleBBox,
} from "@/lib/mask/rle";
import { applyStrokeToCounts, stampStroke } from "@/lib/mask/edit";

function randomMask(n: number, density: number, seed = 1) {
  let s = seed;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    m[i] = s / 0x7fffffff < density ? 1 : 0;
  }
  return m;
}

describe("RLE masks", () => {
  it("round-trips arbitrary masks", () => {
    for (const density of [0, 0.01, 0.5, 1]) {
      const m = randomMask(64 * 48, density, 7);
      const counts = encodeMask(m);
      expect(decodeMask(counts, m.length)).toEqual(m);
      expect(maskArea(counts)).toBe(m.reduce((a, b) => a + b, 0));
      expect(isValidRLE(counts, m.length)).toBe(true);
    }
  });

  it("always starts with a background run", () => {
    const m = new Uint8Array([1, 1, 0, 1]);
    expect(encodeMask(m)).toEqual([0, 2, 1, 1]);
  });

  it("rejects malformed RLE", () => {
    expect(isValidRLE([1, 2, 3], 10)).toBe(false);
    expect(isValidRLE([5, -1, 6], 10)).toBe(false);
    expect(isValidRLE([5, 2.5, 2.5], 10)).toBe(false);
    expect(isValidRLE("nope", 10)).toBe(false);
  });

  it("computes bounding boxes from RLE and raw masks", () => {
    const w = 10;
    const h = 8;
    const m = new Uint8Array(w * h);
    for (let y = 2; y <= 5; y++) for (let x = 3; x <= 6; x++) m[y * w + x] = 1;
    expect(bboxOfMask(m, w, h)).toEqual({ x: 3, y: 2, w: 4, h: 4 });
    expect(rleBBox(encodeMask(m), w, h)).toEqual({ x: 3, y: 2, w: 4, h: 4 });
    expect(rleBBox(encodeMask(new Uint8Array(w * h)), w, h)).toBeNull();
  });

  it("finds coverage ranges and nearest analyzed frame", () => {
    const full = encodeMask(new Uint8Array([0, 1]));
    const empty = encodeMask(new Uint8Array([0, 0]));
    const frames = { "0": full, "1": full, "2": full, "5": full, "6": empty, "9": full };
    expect(coverageRanges(frames)).toEqual([
      [0, 2],
      [5, 5],
      [9, 9],
    ]);
    expect(maskForFrame(frames, 4, 1)).toBeNull();
    expect(maskForFrame(frames, 4, 2)?.frame).toBe(2);
    expect(maskForFrame(frames, 7, 2)?.frame).toBe(6);
    expect(isEmptyMask(empty)).toBe(true);
  });
});

describe("brush / eraser strokes", () => {
  it("paints and erases along a path", () => {
    const w = 40;
    const h = 20;
    const painted = applyStrokeToCounts(null, w, h, [{ x: 5, y: 10 }, { x: 35, y: 10 }], 3, 1)!;
    const m = decodeMask(painted, w * h);
    expect(m[10 * w + 20]).toBe(1);
    expect(m[2 * w + 20]).toBe(0);
    const erased = applyStrokeToCounts(painted, w, h, [{ x: 20, y: 0 }, { x: 20, y: 19 }], 2, 0)!;
    const e = decodeMask(erased, w * h);
    expect(e[10 * w + 20]).toBe(0);
    expect(e[10 * w + 5]).toBe(1);
    expect(applyStrokeToCounts(painted, w, h, [{ x: 20, y: 10 }], 50, 0)).toBeNull();
  });

  it("clips strokes at the image border", () => {
    const m = new Uint8Array(10 * 10);
    stampStroke(m, 10, 10, [{ x: -5, y: -5 }, { x: 2, y: 2 }], 3, 1);
    expect(m[0]).toBe(1);
    expect(m.length).toBe(100);
  });
});
