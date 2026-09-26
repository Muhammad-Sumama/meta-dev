import { describe, expect, it } from "vitest";
import { buildAlpha, growMask, upscaleMask } from "@/lib/compositing/alpha";
import { computeCleanPlate } from "@/lib/compositing/cleanPlate";
import { applyEffect, blurRGBA } from "@/lib/compositing/effects";
import { encoderArgs, FORMAT_SPECS, outputDimensions } from "@/services/export/formats";

const W = 8;
const H = 8;

function solid(r: number, g: number, b: number) {
  const f = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) f.set([r, g, b, 255], i * 4);
  return f;
}

function halfAlpha() {
  const a = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) a[y * W + x] = 255;
  return a;
}

describe("alpha mattes", () => {
  it("upscales masks bilinearly and only within the mask bounds", () => {
    const m = new Uint8Array(4 * 4);
    m[5] = m[6] = m[9] = m[10] = 1;
    const a = upscaleMask(m, 4, 4, 16, 16);
    expect(a[7 * 16 + 7]).toBe(255);
    expect(a[4 * 16 + 4]).toBeGreaterThan(0);
    expect(a[4 * 16 + 4]).toBeLessThan(255);
    expect(a[0]).toBe(0);
    expect(a[15 * 16 + 15]).toBe(0);
  });

  it("grows and shrinks masks", () => {
    const m = new Uint8Array(10 * 10);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) m[y * 10 + x] = 1;
    expect(growMask(m, 10, 10, 1).reduce((a, b) => a + b, 0)).toBe(36);
    expect(growMask(m, 10, 10, -1).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("feathers edges into soft alpha", () => {
    const m = new Uint8Array(32 * 32);
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) m[y * 32 + x] = 1;
    const hard = buildAlpha([m], 32, 32, 64, 64, { expand: 0, feather: 0, sourceHeight: 64 });
    const soft = buildAlpha([m], 32, 32, 64, 64, { expand: 0, feather: 6, sourceHeight: 64 });
    const softValues = new Set(soft);
    expect(softValues.size).toBeGreaterThan(new Set(hard).size);
    expect(soft[32 * 64 + 32]).toBe(255);
  });
});

describe("effects", () => {
  it("removes the background into the alpha channel", () => {
    const out = applyEffect(solid(200, 100, 50), halfAlpha(), W, H, { effect: "remove_background", backgroundColor: "#000000", blurStrength: 0, dim: 0, keepAlpha: true });
    expect(out[3]).toBe(255);
    expect(out[(W - 1) * 4 + 3]).toBe(0);
  });

  it("blacks out the background when the format has no alpha", () => {
    const out = applyEffect(solid(200, 100, 50), halfAlpha(), W, H, { effect: "remove_background", backgroundColor: "#000000", blurStrength: 0, dim: 0, keepAlpha: false });
    expect([...out.slice((W - 1) * 4, W * 4)]).toEqual([0, 0, 0, 255]);
  });

  it("replaces the background with a color", () => {
    const out = applyEffect(solid(200, 100, 50), halfAlpha(), W, H, { effect: "replace_background", backgroundColor: "#00b140", blurStrength: 0, dim: 0, keepAlpha: false });
    expect([...out.slice(0, 3)]).toEqual([200, 100, 50]);
    expect([...out.slice((W - 1) * 4, (W - 1) * 4 + 3)]).toEqual([0, 177, 64]);
  });

  it("dims the background for highlight", () => {
    const out = applyEffect(solid(200, 200, 200), halfAlpha(), W, H, { effect: "highlight", backgroundColor: "#000000", blurStrength: 0, dim: 1, keepAlpha: false });
    expect(out[0]).toBe(200);
    expect(out[(W - 1) * 4]).toBeLessThan(60);
  });

  it("blurs without bleeding the subject into the background (normalized convolution)", () => {
    const Wb = 64;
    const f = new Uint8Array(Wb * Wb * 4);
    const alpha = new Uint8Array(Wb * Wb);
    for (let i = 0; i < Wb * Wb; i++) {
      const x = i % Wb;
      const subject = x < 32;
      f.set(subject ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
      alpha[i] = subject ? 255 : 0;
    }
    const weight = alpha.map((a) => 255 - a);
    const bg = blurRGBA(f, Wb, Wb, 12, weight);
    // Just outside the subject the blurred background stays blue, not purple.
    const q = (32 * Wb + 34) * 4;
    expect(bg[q]).toBeLessThan(30);
    expect(bg[q + 2]).toBeGreaterThan(200);
  });

  it("fills a removed object from the clean plate", () => {
    const plate = solid(10, 20, 30);
    const out = applyEffect(solid(200, 200, 200), halfAlpha(), W, H, { effect: "remove_object", backgroundColor: "#000000", blurStrength: 0, dim: 0, keepAlpha: false, plate });
    expect([...out.slice(0, 3)]).toEqual([10, 20, 30]);
    expect(out[(W - 1) * 4]).toBe(200);
  });
});

describe("clean plate", () => {
  it("reconstructs the background behind a moving object", () => {
    const bgColor = [40, 80, 120];
    const samples = [0, 3, 6].map((pos) => {
      const rgba = solid(bgColor[0], bgColor[1], bgColor[2]);
      const alpha = new Uint8Array(W * H);
      for (let y = 2; y < 5; y++)
        for (let x = pos; x < pos + 2; x++) {
          rgba.set([250, 250, 0, 255], (y * W + x) * 4);
          alpha[y * W + x] = 255;
        }
      return { rgba, alpha };
    });
    const { plate, holeFraction } = computeCleanPlate(samples, W, H);
    expect(holeFraction).toBe(0);
    for (let i = 0; i < W * H; i++) expect([...plate.slice(i * 4, i * 4 + 3)]).toEqual(bgColor);
  });

  it("fills pixels the object always covers from their surroundings", () => {
    const rgba = solid(90, 90, 90);
    const alpha = new Uint8Array(W * H);
    alpha[3 * W + 3] = 255;
    const { plate, holeFraction } = computeCleanPlate([{ rgba, alpha }], W, H);
    expect(holeFraction).toBeGreaterThan(0);
    expect([...plate.slice((3 * W + 3) * 4, (3 * W + 3) * 4 + 3)]).toEqual([90, 90, 90]);
  });
});

describe("export formats", () => {
  it("computes even output dimensions without upscaling", () => {
    expect(outputDimensions({ resolution: "source" }, { width: 961, height: 541 })).toEqual({ width: 962, height: 542 });
    expect(outputDimensions({ resolution: "720" }, { width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(outputDimensions({ resolution: "2160" }, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
  });

  it("uses alpha-capable pixel formats for transparent video", () => {
    expect(encoderArgs(FORMAT_SPECS.webm_vp9_alpha, "high")).toContain("yuva420p");
    expect(encoderArgs(FORMAT_SPECS.mov_prores4444, "high")).toContain("yuva444p10le");
    expect(encoderArgs(FORMAT_SPECS.mp4_h264, "low")).toContain("26");
    expect(FORMAT_SPECS.mp4_h264.alpha).toBe(false);
    expect(FORMAT_SPECS.png_zip.alpha).toBe(true);
  });
});
