import { describe, expect, it } from "vitest";
import { buildBackgroundModel, foregroundMask } from "@/services/ai/mock/cv/background";
import { classifyColor } from "@/services/ai/mock/cv/color";
import { labelComponents } from "@/services/ai/mock/cv/components";
import { close, dilate, erode, fillHoles, iou } from "@/services/ai/mock/cv/morphology";
import { regionGrow, segmentBoxByColor } from "@/services/ai/mock/cv/segment";
import { MaskTracker } from "@/services/ai/mock/cv/tracker";
import { applyPersistencePrior, MockSegmentationProvider } from "@/services/ai/mock/MockSegmentationProvider";
import type { FrameSource } from "@/services/ai/frameSource";

const W = 96;
const H = 64;

/** Synthetic clip: gray background, a red square moving right, a blue bar moving left. */
function frameAt(f: number): Uint8Array {
  const d = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const y = Math.floor(i / W);
    d[i * 3] = 110 + (y % 7);
    d[i * 3 + 1] = 115;
    d[i * 3 + 2] = 120;
  }
  const paint = (x0: number, y0: number, w: number, h: number, c: [number, number, number]) => {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const p = (y * W + x) * 3;
        [d[p], d[p + 1], d[p + 2]] = c;
      }
  };
  paint(4 + f * 2, 20, 14, 14, [220, 40, 40]);
  paint(80 - f, 8, 6, 22, [40, 70, 210]);
  return d;
}

/** Visible part of the red square (the blue bar passes in front of it from frame ~21). */
function truthSquare(f: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let y = 20; y < 34; y++) {
    for (let x = 4 + f * 2; x < 18 + f * 2; x++) {
      const underBar = x >= 80 - f && x < 86 - f && y >= 8 && y < 30;
      if (x < W && !underBar) m[y * W + x] = 1;
    }
  }
  return m;
}

const FRAMES = Array.from({ length: 30 }, (_, f) => frameAt(f));
const source: FrameSource = {
  async readFrame(i) {
    return FRAMES[i];
  },
  async *stream(start, count) {
    for (let i = start; i < Math.min(FRAMES.length, start + count); i++) yield { index: i, data: FRAMES[i] };
  },
};
const videoSource = { projectId: "prj_test00000000", filePath: "/dev/null", version: "1", width: W, height: H, fps: 30, frameCount: FRAMES.length, maskWidth: W, maskHeight: H };

describe("morphology & components", () => {
  it("dilates, erodes, closes and fills holes", () => {
    const m = new Uint8Array(W * H);
    m[10 * W + 10] = 1;
    expect(dilate(m, W, H, 2).reduce((a, b) => a + b, 0)).toBe(25);
    expect(erode(dilate(m, W, H, 2), W, H, 2)[10 * W + 10]).toBe(1);
    const ring = new Uint8Array(W * H);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) ring[y * W + x] = y === 5 || y === 14 || x === 5 || x === 14 ? 1 : 0;
    expect(fillHoles(ring, W, H)[10 * W + 10]).toBe(1);
    const gap = new Uint8Array(W * H);
    gap[20 * W + 20] = gap[20 * W + 22] = 1;
    expect(close(gap, W, H, 1)[20 * W + 21]).toBe(1);
  });

  it("labels 8-connected components with stats", () => {
    const m = new Uint8Array(W * H);
    m[0] = m[W + 1] = 1; // diagonal = connected
    m[50] = 1;
    const lab = labelComponents(m, W, H);
    expect(lab.components).toHaveLength(2);
    expect(lab.components[0].area).toBe(2);
  });

  it("classifies named colors", () => {
    expect(classifyColor(214, 58, 47)).toBe("red");
    expect(classifyColor(47, 102, 201)).toBe("blue");
    expect(classifyColor(168, 105, 47)).toBe("brown");
    expect(classifyColor(20, 20, 22)).toBe("black");
    expect(classifyColor(240, 240, 240)).toBe("white");
    expect(classifyColor(60, 170, 80)).toBe("green");
  });
});

describe("segmentation primitives", () => {
  it("region-grows a uniform object from a click", () => {
    const m = regionGrow(FRAMES[0], W, H, [{ x: 10, y: 26 }]);
    expect(iou(m, truthSquare(0))).toBeGreaterThan(0.9);
  });

  it("segments an object inside a loose box by color", () => {
    const m = segmentBoxByColor(FRAMES[0], W, H, { x0: 1, y0: 16, x1: 22, y1: 38 });
    expect(iou(m, truthSquare(0))).toBeGreaterThan(0.85);
  });

  it("builds a background model and finds moving objects", () => {
    const model = buildBackgroundModel(FRAMES.filter((_, i) => i % 3 === 0), W, H);
    expect(model.motionReliable).toBe(true);
    const fg = foregroundMask(FRAMES[10], model);
    expect(iou(fg, truthSquare(10))).toBeLessThan(1); // includes the blue bar too
    expect(fg[27 * W + 30]).toBe(1);
  });

  it("tracks a moving object and ignores another subject", () => {
    const model = buildBackgroundModel(FRAMES.filter((_, i) => i % 3 === 0), W, H);
    const tracker = new MaskTracker(W, H, FRAMES[0], truthSquare(0), model);
    let worst = 1;
    for (let f = 1; f < 25; f++) worst = Math.min(worst, iou(tracker.step(FRAMES[f]), truthSquare(f)));
    expect(worst).toBeGreaterThan(0.8);
  });
});

describe("MockSegmentationProvider", () => {
  const provider = new MockSegmentationProvider({ frameSourceFactory: () => source, backgroundSamples: 10 });

  it("segments from a click, a box, and removes with a negative click", async () => {
    const s = await provider.initializeVideo(videoSource);
    const click = await provider.segmentFrame(s, { frameIndex: 5, points: [{ x: 20 / W, y: 26 / H, label: 1 }] });
    expect(iou(click.mask, truthSquare(5))).toBeGreaterThan(0.85);
    const box = await provider.segmentFrame(s, { frameIndex: 5, points: [], box: { x0: 10 / W, y0: 15 / H, x1: 32 / W, y1: 40 / H } });
    expect(iou(box.mask, truthSquare(5))).toBeGreaterThan(0.85);
    await expect(provider.segmentFrame(s, { frameIndex: 5, points: [{ x: 0.5, y: 0.9, label: 0 }] })).rejects.toMatchObject({ code: "SEGMENTATION_FAILED" });
  });

  it("refines an existing mask with positive and negative clicks", async () => {
    const s = await provider.initializeVideo(videoSource);
    const start = truthSquare(5);
    // Negative click inside the object carves it out; positive click on the blue bar adds it.
    const removed = await provider.refineMask(s, { frameIndex: 5, mask: start, points: [{ x: 20 / W, y: 26 / H, label: 0 }] });
    expect(removed.mask.reduce((a, b) => a + b, 0)).toBeLessThan(start.reduce((a, b) => a + b, 0) * 0.2);
    const added = await provider.refineMask(s, { frameIndex: 5, mask: start, points: [{ x: 77 / W, y: 15 / H, label: 1 }] });
    expect(added.mask[15 * W + 77]).toBe(1);
    expect(added.mask[26 * W + 20]).toBe(1);
  });

  it("locates a described object by color and shape", async () => {
    const s = await provider.initializeVideo(videoSource);
    const dets = await provider.locateObjects(s, [0, 10, 20], { description: "red box", category: "object", colors: ["red"], clothing: [] });
    const best = dets.sort((a, b) => b.score - a.score)[0];
    expect((best.box.x0 + best.box.x1) / 2).toBeLessThan(0.7);
    expect(best.box.y0).toBeGreaterThan(0.25);
  });

  it("tracks bidirectionally from a keyframe", async () => {
    const s = await provider.initializeVideo(videoSource);
    const masks = new Map<number, Uint8Array>();
    const progress: number[] = [];
    await provider.trackObject(
      s,
      { keyframes: [{ frameIndex: 12, points: [], mask: truthSquare(12) }], startFrame: 0, endFrame: 24, direction: "both" },
      { onFrame: (i, m) => void (m && masks.set(i, m)), onProgress: (d) => progress.push(d) },
    );
    expect(masks.size).toBe(25);
    for (const f of [0, 6, 18, 24]) expect(iou(masks.get(f)!, truthSquare(f))).toBeGreaterThan(0.8);
    expect(progress.at(-1)).toBe(25);
  });

  it("supports cancellation", async () => {
    const s = await provider.initializeVideo(videoSource);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      provider.trackObject(s, { keyframes: [{ frameIndex: 0, points: [], mask: truthSquare(0) }], startFrame: 0, endFrame: 29, direction: "forward" }, { signal: ctrl.signal, onFrame: () => {} }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("down-weights transient detections", () => {
    const box = (x: number, w: number) => ({ x0: x, y0: 0.5, x1: x + w, y1: 0.7 });
    const steady = [0, 1, 2, 3].map((f) => ({ frameIndex: f, box: box(0.1, 0.1), score: 0.8, label: "dog" }));
    const blip = { frameIndex: 2, box: box(0.5, 0.25), score: 0.9, label: "dog" };
    const out = applyPersistencePrior([...steady, blip], 4);
    expect(out.find((d) => d.box.x0 === 0.5)!.score).toBeLessThan(out[0].score);
  });
});
