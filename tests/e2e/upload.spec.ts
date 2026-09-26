import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { type Page, expect, test } from "@playwright/test";

/**
 * A real upload in a real browser: a portrait, variable-frame-rate HEVC .mov
 * (what phones record), which no browser here can play directly. The app has
 * to build a preview proxy (H.264, then VP9 if the browser lacks H.264), show
 * it upright, and keep masks on the exact picture being shown — checked by
 * comparing the decoded video pixels with the mask overlay's pixels.
 */

function ffmpeg(args: string[]) {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const bin = process.env.FFMPEG_PATH || (req("ffmpeg-static") as string);
  const out = spawnSync(bin, ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
}

/** 2 s white square moving over dark grey; every fifth frame dropped (VFR); tagged as rotated 90°. */
function makePhoneClip() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opensam-e2e-"));
  const tmp = path.join(dir, "tmp.mov");
  const clip = path.join(dir, "IMG_0042.MOV");
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x202020:s=320x180:r=30:d=2",
    "-f", "lavfi", "-i", "color=c=white:s=40x40:r=30:d=2",
    "-filter_complex", "[0][1]overlay=x='10+4*n':y=70:shortest=1,select='not(eq(mod(n\\,5)\\,2))',format=yuv420p[v]",
    "-map", "[v]", "-fps_mode", "vfr",
    "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1",
    tmp,
  ]);
  ffmpeg(["-display_rotation:v:0", "90", "-i", tmp, "-c", "copy", clip]);
  return clip;
}

type Blob = { n: number; x: number; y: number };

/** Bright pixels of the decoded video frame vs. painted pixels of the mask overlay, in video pixels. */
function measure(page: Page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    const overlay = document.querySelector<HTMLCanvasElement>('canvas[data-layer="masks"]');
    if (!video || !overlay || video.readyState < 2 || video.seeking) return null;
    const W = video.videoWidth;
    const H = video.videoHeight;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(video, 0, 0, W, H);
    const pic = g.getImageData(0, 0, W, H).data;
    g.clearRect(0, 0, W, H);
    g.drawImage(overlay, 0, 0, W, H);
    const mask = g.getImageData(0, 0, W, H).data;
    const a = { n: 0, x: 0, y: 0 };
    const b = { n: 0, x: 0, y: 0 };
    let inter = 0;
    let union = 0;
    for (let i = 0, p = 0; i < pic.length; i += 4, p++) {
      const x = p % W;
      const y = (p - x) / W;
      const inPic = pic[i] > 160 && pic[i + 1] > 160 && pic[i + 2] > 160;
      const inMask = mask[i + 3] > 0;
      if (inPic) Object.assign(a, { n: a.n + 1, x: a.x + x, y: a.y + y });
      if (inMask) Object.assign(b, { n: b.n + 1, x: b.x + x, y: b.y + y });
      if (inPic && inMask) inter++;
      if (inPic || inMask) union++;
    }
    const norm = (o: { n: number; x: number; y: number }) => ({ n: o.n, x: o.x / Math.max(1, o.n), y: o.y / Math.max(1, o.n) });
    return { w: W, h: H, picture: norm(a), mask: norm(b), iou: union ? inter / union : 0 };
  });
}

const drift = (a: Blob, b: Blob) => Math.hypot(a.x - b.x, a.y - b.y);

test("upload a rotated VFR phone clip → preview proxy → click-track → masks stay on the picture", async ({ page }) => {
  const clip = makePhoneClip();
  await page.goto("/editor");
  await page.getByLabel("Choose a video file").setInputFiles(clip);
  await page.waitForURL(/\/editor\/prj_/, { timeout: 60_000 });

  // Preview proxy built, decodable by this browser, and upright (portrait).
  await expect
    .poll(() => page.evaluate(() => {
      const v = document.querySelector("video");
      return v && v.readyState >= 2 ? [v.videoWidth, v.videoHeight] : null;
    }), { timeout: 90_000 })
    .toEqual([180, 320]);
  const stage = await page.getByRole("application").boundingBox();
  expect(stage!.height).toBeGreaterThan(stage!.width);

  const first = await measure(page);
  expect(first?.picture.n).toBeGreaterThan(1200);

  // Track tool: click the square once to select and track it through the clip.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("t");
  await expect(page.getByRole("application")).toHaveAccessibleName(/track tool/);
  await page.mouse.click(stage!.x + (first!.picture.x / first!.w) * stage!.width, stage!.y + (first!.picture.y / first!.h) * stage!.height);
  await expect(page.getByText("48 fr", { exact: true })).toBeVisible({ timeout: 90_000 });

  // Step through frames, including ones next to dropped frames: the overlay
  // must sit on the square actually on screen, not a neighbouring frame.
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  const visits: Array<[number, string]> = [[1, "ArrowRight"], [2, "ArrowRight"], [3, "ArrowRight"], [13, "Shift+ArrowRight"], [23, "Shift+ArrowRight"], [33, "Shift+ArrowRight"], [43, "Shift+ArrowRight"], [44, "ArrowRight"]];
  for (const [frame, key] of visits) {
    await page.keyboard.press(key);
    const tc = `00:00:${String(Math.floor(frame / 24)).padStart(2, "0")}:${String(frame % 24).padStart(2, "0")}`;
    await expect(page.getByLabel("Current timecode")).toHaveText(tc);
    // Rendering settles within a few frames; a one-frame offset never would.
    await expect
      .poll(async () => {
        const m = await measure(page);
        return m && m.mask.n > 0 ? drift(m.picture, m.mask) : Infinity;
      }, { message: `frame ${frame}: mask centroid vs picture (px)`, timeout: 10_000 })
      .toBeLessThan(2);
    expect((await measure(page))!.iou, `frame ${frame}: IoU`).toBeGreaterThan(0.8);
  }

  // Pausing mid-playback parks on a frame whose mask matches the picture.
  await page.keyboard.press("Home");
  await page.keyboard.press(" ");
  await page.waitForTimeout(700);
  await page.keyboard.press(" ");
  await expect.poll(async () => (await measure(page))?.mask.n ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const paused = (await measure(page))!;
  expect(drift(paused.picture, paused.mask)).toBeLessThan(2);
});
