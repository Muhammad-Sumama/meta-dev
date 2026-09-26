/**
 * End-to-end pipeline through the real route handlers, job queue and FFmpeg:
 *
 *   Upload → AI command → segmentation → tracking → preview media → export
 *
 * Uses the bundled demo clip and mock inference. Requires FFmpeg (bundled via
 * ffmpeg-static / @ffprobe-installer, or on PATH).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeMask } from "@/lib/mask/rle";
import { setConfigForTesting } from "@/lib/server/config";
import * as commandsRoute from "@/app/api/projects/[projectId]/commands/route";
import * as exportRoute from "@/app/api/projects/[projectId]/exports/[exportId]/route";
import * as exportsRoute from "@/app/api/projects/[projectId]/exports/route";
import * as mediaRoute from "@/app/api/projects/[projectId]/media/[asset]/route";
import * as projectRoute from "@/app/api/projects/[projectId]/route";
import * as segmentRoute from "@/app/api/projects/[projectId]/segment/route";
import * as trackRoute from "@/app/api/projects/[projectId]/track/route";
import * as trackItemRoute from "@/app/api/projects/[projectId]/tracks/[trackId]/route";
import * as healthRoute from "@/app/api/health/route";
import * as jobRoute from "@/app/api/jobs/[jobId]/route";
import { DEMO_VIDEO, GT_FILE, evaluateDemo } from "../helpers/evalDemo";
import { type Handler, call, ffprobeJson, upload, waitJob } from "../helpers/routes";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "opensam-it-"));
  setConfigForTesting({ DATA_DIR: dataDir, MIN_FREE_DISK_MB: 0, JOB_CONCURRENCY: 2 });
});

afterAll(() => {
  setConfigForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("health", () => {
  it("reports FFmpeg, encoders and providers", async () => {
    const { res, json } = await call(healthRoute.GET as Handler);
    expect(res.status).toBe(200);
    expect(json.ffmpeg.available).toBe(true);
    expect(json.formats.webm_vp9_alpha).toBe(true);
    expect(json.ai.segmentation.kind).toBe("mock");
    expect(JSON.stringify(json)).not.toMatch(/API_KEY|apiKey/);
  });
});

describe("upload validation", () => {
  it("rejects disguised, corrupted and oversized files with friendly errors", async () => {
    const txt = await upload(GT_FILE, "notes.txt");
    expect(txt.res.status).toBe(415);
    expect(txt.json.error.code).toBe("UNSUPPORTED_FORMAT");

    const disguised = await upload(GT_FILE, "totally-a-video.mp4");
    expect(disguised.res.status).toBe(415);
    expect(disguised.json.error.message).toMatch(/isn't a video format/);

    const truncated = await upload(DEMO_VIDEO, "truncated.mp4", 4095);
    expect(truncated.res.status).toBe(422);
    expect(truncated.json.error.code).toBe("CORRUPTED_VIDEO");
    expect(truncated.json.error.message).not.toMatch(/ffprobe|Error:|at /);

    setConfigForTesting({ MAX_UPLOAD_MB: 0.1 as unknown as number });
    const big = await upload(DEMO_VIDEO, "big.mp4");
    setConfigForTesting({ MAX_UPLOAD_MB: 500 });
    expect(big.res.status).toBe(413);
    expect(big.json.error.code).toBe("UPLOAD_TOO_LARGE");
  });

  it("rejects path traversal and malformed ids", async () => {
    const { res } = await call(mediaRoute.GET as Handler, { params: { projectId: "../../etc", asset: "source" } });
    expect(res.status).toBe(404);
    const bad = await call(jobRoute.GET as Handler, { params: { jobId: "job_../../x" } });
    expect(bad.res.status).toBe(404);
  });
});

describe("full pipeline", () => {
  let projectId: string;
  let carTrackId: string;

  it("uploads a video, extracts metadata and prepares media", async () => {
    const { res, json } = await upload(DEMO_VIDEO, "My Street Clip.mp4");
    expect(res.status).toBe(201);
    projectId = json.project.id;
    expect(json.project.video).toMatchObject({ width: 960, height: 540, fps: 30, frameCount: 300, duration: 10, codec: "h264", originalName: "My Street Clip.mp4" });
    expect(json.project.analysis).toEqual({ width: 512, height: 288 });
    const ingest = await waitJob(json.job.id);
    expect(ingest.status).toBe("completed");

    const { json: bundle } = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(bundle.project.media.poster).toBe(true);
    expect(bundle.project.media.filmstrip).toMatchObject({ status: "ready", count: 20 });
  });

  it("streams preview media with HTTP range requests", async () => {
    const { res } = await call(mediaRoute.GET as Handler, { params: { projectId, asset: "preview" }, headers: { range: "bytes=100-199" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 100-199\/\d+$/);
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    const bad = await call(mediaRoute.GET as Handler, { params: { projectId, asset: "preview" }, headers: { range: "bytes=99999999-" } });
    expect(bad.res.status).toBe(416);
  });

  it("turns a natural-language command into a tracked mask", async () => {
    const { res, json } = await call(commandsRoute.POST as Handler, { method: "POST", body: { text: "Track the red car", frameIndex: 0 }, params: { projectId } });
    expect(res.status).toBe(202);
    expect(json.parsed.command).toMatchObject({ action: "track", target: { type: "vehicle", description: "red car" } });
    expect(json.plan.steps.map((s: { kind: string }) => s.kind)).toEqual(["locate", "segment", "track"]);
    const job = await waitJob(json.job.id);
    expect(job.status).toBe("completed");
    carTrackId = job.result.trackId;
    expect(job.result.maskedFrames).toBeGreaterThan(250);

    const { json: t } = await call(trackItemRoute.GET as Handler, { params: { projectId, trackId: carTrackId } });
    expect(t.track).toMatchObject({ name: "Red car", source: "ai", provider: "mock", width: 512, height: 288 });
    // Compare with ground truth on a few frames.
    const gt = JSON.parse(readFileSync(GT_FILE, "utf8"));
    for (const f of [40, 120, 200]) {
      const truth = decodeMask(gt.subjects.red_car[f], 512 * 288);
      const pred = decodeMask(t.track.frames[f], 512 * 288);
      let inter = 0;
      let uni = 0;
      for (let i = 0; i < truth.length; i++) {
        inter += truth[i] & pred[i];
        uni += truth[i] | pred[i];
      }
      expect(inter / uni).toBeGreaterThan(0.8);
    }

    const { json: bundle } = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(bundle.project.commands.at(-1)).toMatchObject({ status: "completed", trackId: carTrackId, source: "rules" });
  });

  it("applies an effect command to the selection without re-segmenting", async () => {
    const { res, json } = await call(commandsRoute.POST as Handler, {
      method: "POST",
      body: { text: "Remove the background", frameIndex: 0, selectedTrackId: carTrackId },
      params: { projectId },
    });
    expect(res.status).toBe(200);
    expect(json.job).toBeNull();
    const { json: bundle } = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(bundle.project.composite).toMatchObject({ effect: "remove_background", subjectTrackIds: [carTrackId] });
  });

  it("reports unclear or impossible commands in plain language", async () => {
    const noSel = await call(commandsRoute.POST as Handler, { method: "POST", body: { text: "Blur the background", frameIndex: 0 }, params: { projectId } });
    expect(noSel.res.status).toBe(422);
    expect(noSel.json.error.code).toBe("NO_SELECTION");

    const gibberish = await call(commandsRoute.POST as Handler, { method: "POST", body: { text: "zxqv plorb", frameIndex: 0 }, params: { projectId } });
    expect(gibberish.json.error.code).toBe("COMMAND_NOT_UNDERSTOOD");

    const { json } = await call(commandsRoute.POST as Handler, { method: "POST", body: { text: "Track the purple elephant", frameIndex: 0 }, params: { projectId } });
    const job = await waitJob(json.job.id);
    expect(job.status).toBe("failed");
    expect(job.error.code).toBe("TARGET_NOT_FOUND");
    expect(job.error.message).toMatch(/purple elephant/);
  });

  it("segments from a click and tracks from a keyframe mask", async () => {
    // The dog at frame 150 (see generate-demo.ts: x = 900 - 2.4f - 110, feet at y≈522).
    const { res, json } = await call(segmentRoute.POST as Handler, {
      method: "POST",
      body: { frameIndex: 150, points: [{ x: 430 / 960, y: 480 / 540, label: 1 }] },
      params: { projectId },
    });
    expect(res.status).toBe(200);
    const mask = decodeMask(json.counts, json.width * json.height);
    const area = mask.reduce((a, b) => a + b, 0);
    expect(area).toBeGreaterThan(200);
    expect(area).toBeLessThan(3000);

    const tr = await call(trackRoute.POST as Handler, {
      method: "POST",
      body: { name: "Dog", keyframes: [{ frameIndex: 150, mask: json.counts }], range: { start: 100, end: 200 } },
      params: { projectId },
    });
    expect(tr.res.status).toBe(202);
    const job = await waitJob(tr.json.job.id);
    expect(job.status).toBe("completed");
    expect(job.result.maskedFrames).toBeGreaterThan(90);

    const invalid = await call(segmentRoute.POST as Handler, { method: "POST", body: { frameIndex: 5 }, params: { projectId } });
    expect(invalid.res.status).toBe(400);
  });

  async function exportAndDownload(settings: Record<string, unknown>, composite?: Record<string, unknown>) {
    const { res, json } = await call(exportsRoute.POST as Handler, {
      method: "POST",
      body: { settings, ...(composite ? { composite } : {}) },
      params: { projectId },
    });
    expect(res.status).toBe(202);
    const job = await waitJob(json.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    const dl = await call(exportRoute.GET as Handler, { params: { projectId, exportId: json.exportId } });
    expect(dl.res.status).toBe(200);
    expect(dl.res.headers.get("content-disposition")).toMatch(/attachment/);
    const file = path.join(dataDir, "dl-" + json.exportId + "." + String(job.result.fileName).split(".").slice(1).join("."));
    const bytes = Buffer.from(await dl.res.arrayBuffer());
    writeFileSync(file, bytes);
    return { job, file, bytes };
  }

  const composite = { effect: "remove_background", subjectTrackIds: [] as string[], backgroundColor: "#00b140", blurStrength: 0.5, dim: 0.6, feather: 2, expand: 0 };

  it("exports transparent WebM (real alpha channel)", async () => {
    const { file, job } = await exportAndDownload({ kind: "video", format: "webm_vp9_alpha", resolution: "480", fps: "source", quality: "low", range: { start: 100, end: 129 } }, { ...composite, subjectTrackIds: [carTrackId] });
    expect(job.result).toMatchObject({ frames: 30, width: 854, height: 480 });
    const v = ffprobeJson(file).streams[0] as { codec_name: string; tags?: Record<string, string>; nb_read_packets: string };
    expect(v.codec_name).toBe("vp9");
    expect(v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE).toBe("1");
    expect(Number(v.nb_read_packets)).toBe(30);
  });

  it("exports an RGBA PNG sequence as a zip", async () => {
    const { bytes, job } = await exportAndDownload({ kind: "png_sequence", format: "png_zip", resolution: "360", fps: "source", quality: "high", range: { start: 0, end: 9 } }, composite);
    expect(job.result.frames).toBe(10);
    const names = bytes.toString("latin1").match(/frames\/frame_\d{6}\.png/g) ?? [];
    expect(new Set(names).size).toBe(10);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("exports a matte video at a different frame rate", async () => {
    const { file, job } = await exportAndDownload({ kind: "mask", format: "mask_mp4", resolution: "360", fps: "24", quality: "medium", range: { start: 0, end: 59 } });
    expect(job.result.frames).toBe(48);
    const v = ffprobeJson(file).streams[0] as { codec_name: string; nb_read_packets: string };
    expect(v.codec_name).toBe("h264");
    expect(Number(v.nb_read_packets)).toBe(48);
  });

  it("warns honestly when the format can't store transparency", async () => {
    const { job } = await exportAndDownload({ kind: "video", format: "mp4_h264", resolution: "360", fps: "source", quality: "low", range: { start: 0, end: 4 } }, composite);
    expect(job.result.warnings[0]).toMatch(/can't store transparency/);
  });

  it("removes an object using a clean plate", async () => {
    const { job } = await exportAndDownload(
      { kind: "video", format: "mp4_h264", resolution: "360", fps: "source", quality: "low", range: { start: 60, end: 69 } },
      { ...composite, effect: "remove_object", subjectTrackIds: [carTrackId] },
    );
    expect(job.status).toBe("completed");
  });

  it("exports the project as JSON with masks and command history", async () => {
    const { bytes } = await exportAndDownload({ kind: "project", format: "project_json" });
    const doc = JSON.parse(bytes.toString("utf8"));
    expect(doc.format).toBe("opensam-project");
    expect(doc.tracks.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["Red car", "Dog"]));
    expect(doc.project.commands.length).toBeGreaterThan(0);
  });

  it("cancels a running export", async () => {
    const { json } = await call(exportsRoute.POST as Handler, {
      method: "POST",
      body: { settings: { kind: "video", format: "webm_vp9_alpha", resolution: "source", fps: "source", quality: "high" }, composite: { ...composite, subjectTrackIds: [carTrackId] } },
      params: { projectId },
    });
    await new Promise((r) => setTimeout(r, 300));
    const cancel = await call(jobRoute.DELETE as Handler, { method: "DELETE", params: { jobId: json.job.id } });
    expect(cancel.res.status).toBe(200);
    const job = await waitJob(json.job.id);
    expect(job.status).toBe("cancelled");
    const dl = await call(exportRoute.GET as Handler, { params: { projectId, exportId: json.exportId } });
    expect(dl.res.status).toBe(409);
  });

  it("deletes the project and its files", async () => {
    const { res } = await call(projectRoute.DELETE as Handler, { method: "DELETE", params: { projectId } });
    expect(res.status).toBe(200);
    const gone = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(gone.res.status).toBe(404);
  });
});

describe("mock inference quality (regression)", () => {
  it("tracks every demo subject from its natural-language description", async () => {
    const report = await evaluateDemo();
    const by = Object.fromEntries(report.map((r) => [r.subject, r]));
    expect(by.red_car.meanIoU).toBeGreaterThan(0.9);
    expect(by.man_blue_shirt.meanIoU).toBeGreaterThan(0.85);
    expect(by.dog.meanIoU).toBeGreaterThan(0.75);
    expect(by.man_red_shirt.meanIoU).toBeGreaterThan(0.7);
  });
});
