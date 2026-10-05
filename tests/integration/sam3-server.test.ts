/**
 * The web app's segmentation client (SEGMENTATION_PROVIDER=sam3) against the
 * real Python inference server running Sam3Backend — with tiny randomly
 * initialised SAM 3 models (inference/tests/tiny_sam3.py), so every call goes
 * through the real transformers SAM 3 code without weights or a GPU. Masks
 * are noise; this checks the full chain: upload → text grounding → segment →
 * NDJSON tracking.
 *
 * Runs when OPENSAM_SAM3_PYTHON points at a Python with torch, torchvision and
 * transformers>=5.18 (plus inference/requirements-dev.txt); skipped otherwise.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VideoSource } from "@/services/ai/types";
import { SAM2Provider } from "@/services/sam2/SAM2Provider";
import { DEMO_VIDEO, ffmpegPath } from "../helpers/evalDemo";
import { freePort } from "../helpers/redis";

const PYTHON = process.env.OPENSAM_SAM3_PYTHON ?? "";
const available = !!PYTHON && existsSync(PYTHON);

describe.skipIf(!available)("SAM 3 inference server (tiny model) end to end", () => {
  let proc: ChildProcess;
  let url = "";
  const source: VideoSource = {
    projectId: "prj_sam3sam3sam3",
    filePath: DEMO_VIDEO,
    version: "v1",
    width: 960,
    height: 540,
    fps: 30,
    frameCount: 300,
    maskWidth: 64,
    maskHeight: 36,
  };

  beforeAll(async () => {
    const port = await freePort();
    proc = spawn(PYTHON, ["-m", "uvicorn", "tests.tiny_sam3_server:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
      cwd: path.join(process.cwd(), "inference"),
      stdio: "ignore",
      env: { ...process.env, FFMPEG_PATH: process.env.FFMPEG_PATH ?? ffmpegPath(), SAM3_FRAME_MAX_SIDE: "224" },
    });
    url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 1800; i++) {
      if (proc.exitCode !== null) throw new Error("inference server exited");
      if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("inference server didn't start");
  }, 200_000); // importing torch can be slow on a cold disk

  afterAll(() => {
    if (proc?.exitCode === null) proc.kill("SIGKILL");
  });

  it("runs text grounding, segmentation and tracking through SAM 3", async () => {
    const provider = new SAM2Provider({ baseUrl: url, timeoutMs: 120_000, sharedStorage: false, family: "sam3" });
    expect(provider.info.name).toBe("SAM 3");
    expect(await provider.health()).toMatchObject({ status: "ready", details: { grounding: true } });

    const session = await provider.initializeVideo(source);
    const dets = await provider.locateObjects(session, [0, 150], {
      description: "red car",
      noun: "car",
      category: "vehicle",
      colors: ["red"],
      clothing: [],
    });
    expect(dets.length).toBeGreaterThan(0);
    for (const d of dets) {
      expect([0, 150]).toContain(d.frameIndex);
      expect(d.box.x0).toBeGreaterThanOrEqual(0);
      expect(d.box.x1).toBeLessThanOrEqual(1);
    }

    const seg = await provider.segmentFrame(session, { frameIndex: 10, points: [{ x: 0.3, y: 0.6, label: 1 }], box: dets[0].box });
    expect(seg.mask.length).toBe(64 * 36);

    const frames: number[] = [];
    await provider.trackObject(session, { keyframes: [{ frameIndex: 5, points: [], mask: seg.mask }], startFrame: 0, endFrame: 11, direction: "both" }, {
      onFrame: (f) => void frames.push(f),
    });
    expect([...frames].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  }, 300_000);
});
