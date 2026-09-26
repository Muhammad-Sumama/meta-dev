/**
 * Inputs browsers can't play directly, through the real ingest → segment →
 * track → export path:
 *
 *   - ProRes 422 in QuickTime with PCM audio (editing-suite export)
 *   - H.264 with B-frames in Matroska with AAC audio (screen recorders, OBS)
 *   - HEVC .mov, variable frame rate, rotated 90° (what phones record)
 *
 * The clips show a white square moving at a known speed, so a frame's content
 * identifies its timestamp. The key invariant: the browser preview (proxy)
 * shows exactly the frame the masks were computed on, in the orientation the
 * user sees — otherwise overlays drift or appear sideways.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeMask } from "@/lib/mask/rle";
import { setConfigForTesting } from "@/lib/server/config";
import * as exportRoute from "@/app/api/projects/[projectId]/exports/[exportId]/route";
import * as exportsRoute from "@/app/api/projects/[projectId]/exports/route";
import * as previewProxyRoute from "@/app/api/projects/[projectId]/preview-proxy/route";
import * as projectRoute from "@/app/api/projects/[projectId]/route";
import * as segmentRoute from "@/app/api/projects/[projectId]/segment/route";
import * as trackRoute from "@/app/api/projects/[projectId]/tracks/[trackId]/route";
import * as trackJobRoute from "@/app/api/projects/[projectId]/track/route";
import { readFrameAt } from "@/services/video/frames";
import { type Handler, call, ffmpeg, ffprobeJson, upload, waitJob } from "../helpers/routes";

const W = 320;
const H = 180;
const FPS = 30;
const FRAMES = 60;
const SQUARE = 40;

let dir: string;
let clips: Clip;

/** 2 s of a white square moving 4 px/frame over dark grey, plus a tone. */
function lavfiInputs() {
  return [
    "-f", "lavfi", "-i", `color=c=0x202020:s=${W}x${H}:r=${FPS}:d=${FRAMES / FPS}`,
    "-f", "lavfi", "-i", `color=c=white:s=${SQUARE}x${SQUARE}:r=${FPS}:d=${FRAMES / FPS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${FRAMES / FPS}`,
  ];
}
const MOVING_SQUARE = `[0][1]overlay=x='10+4*n':y=${(H - SQUARE) / 2}:shortest=1`;

function makeClips() {
  const prores = path.join(dir, "edit-export.mov");
  ffmpeg([
    ...lavfiInputs(),
    "-filter_complex", `${MOVING_SQUARE},format=yuv422p10le[v]`,
    "-map", "[v]", "-map", "2:a",
    "-c:v", "prores_ks", "-profile:v", "2", "-c:a", "pcm_s16le",
    prores,
  ]);

  const mkv = path.join(dir, "screen-recording.mkv");
  ffmpeg([
    ...lavfiInputs(),
    "-filter_complex", `${MOVING_SQUARE},format=yuv420p[v]`,
    "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-preset", "veryfast", "-bf", "3", "-g", "15", "-c:a", "aac",
    mkv,
  ]);

  // Phone: drop every fifth frame (timestamps kept → VFR), HEVC, then tag a
  // 90° display rotation without re-encoding, like a portrait recording.
  const phoneTmp = path.join(dir, "phone-unrotated.mov");
  ffmpeg([
    ...lavfiInputs().slice(0, 8),
    "-filter_complex", `${MOVING_SQUARE},select='not(eq(mod(n\\,5)\\,2))',format=yuv420p[v]`,
    "-map", "[v]", "-fps_mode", "vfr",
    "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-tag:v", "hvc1",
    phoneTmp,
  ]);
  const phone = path.join(dir, "IMG_0042.MOV");
  ffmpeg(["-display_rotation:v:0", "90", "-i", phoneTmp, "-c", "copy", phone]);

  return { prores, mkv, phone };
}

type Clip = ReturnType<typeof makeClips>;

type Case = {
  name: string;
  clip: keyof Clip;
  upload: string;
  codec: string;
  display: [number, number];
  analysis: [number, number];
  vfr?: boolean;
  audio?: { exportFormat: "mp4_h264" | "webm_vp9"; codec: string };
};

const CASES: Case[] = [
  { name: "ProRes 422 .mov with PCM audio", clip: "prores", upload: "edit-export.mov", codec: "prores", display: [320, 180], analysis: [320, 180], audio: { exportFormat: "mp4_h264", codec: "aac" } },
  { name: "H.264 (B-frames) .mkv with AAC audio", clip: "mkv", upload: "screen-recording.mkv", codec: "h264", display: [320, 180], analysis: [320, 180], audio: { exportFormat: "webm_vp9", codec: "opus" } },
  { name: "rotated variable-frame-rate HEVC .mov", clip: "phone", upload: "IMG_0042.MOV", codec: "hevc", display: [180, 320], analysis: [180, 320], vfr: true },
];

/** White pixels of a decoded analysis frame (the ground truth for masks). */
function whiteMask(gray: Uint8Array) {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] > 128 ? 1 : 0;
  return m;
}

function centroid(mask: Uint8Array, width: number) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    n++;
    sx += x;
    sy += y;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { n, x: sx / n, y: sy / n, box: { x0, y0, x1, y1 } };
}

function iou(a: Uint8Array, b: Uint8Array) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    inter += a[i] & b[i];
    union += a[i] | b[i];
  }
  return union ? inter / union : 0;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "opensam-formats-"));
  clips = makeClips();
  setConfigForTesting({ DATA_DIR: path.join(dir, "data"), MIN_FREE_DISK_MB: 0, JOB_CONCURRENCY: 2 });
});

afterAll(() => {
  setConfigForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe.each(CASES)("$name", (c) => {
  let projectId: string;
  let project: {
    video: { fps: number; frameCount: number; fileName: string };
    analysis: { width: number; height: number };
  };
  let trackId: string;
  const media = (file: string) => path.join(dir, "data", "projects", projectId, "media", file);
  const [AW, AH] = c.analysis;
  const truthAt = async (file: string, frame: number) =>
    whiteMask(new Uint8Array(await readFrameAt(file, frame, { width: AW, height: AH, fps: project.video.fps, pixelFormat: "gray" })));

  it("ingests and builds an H.264 preview proxy", async () => {
    const { res, json } = await upload(clips[c.clip], c.upload);
    expect(res.status, JSON.stringify(json)).toBe(201);
    projectId = json.project.id;
    project = json.project;
    expect(json.project.video).toMatchObject({ codec: c.codec, width: c.display[0], height: c.display[1], browserPlayable: false, hasAudio: !!c.audio });
    expect(json.project.analysis).toEqual({ width: AW, height: AH });
    if (c.vfr) {
      expect(project.video.frameCount).toBe(48);
    } else {
      expect(project.video).toMatchObject({ fps: FPS, frameCount: FRAMES });
    }

    expect((await waitJob(json.job.id)).status).toBe("completed");
    const { json: bundle } = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(bundle.project.media.proxy.status).toBe("ready");

    // What the browser gets: upright, same size, same number of frames, no
    // leftover rotation tag that would make players rotate it twice.
    const proxy = ffprobeJson(media("proxy.mp4")).streams.find((s) => s.codec_type === "video")!;
    expect(proxy).toMatchObject({ codec_name: "h264", width: c.display[0], height: c.display[1], pix_fmt: "yuv420p" });
    expect(Number(proxy.nb_read_packets)).toBe(project.video.frameCount);
    const rotation = ((proxy.side_data_list as Array<{ rotation?: number }> | undefined) ?? []).find((d) => d.rotation !== undefined)?.rotation ?? 0;
    expect(rotation).toBe(0);
  });

  it("shows the same frame in the preview as the one masks are computed on", async () => {
    for (const f of [0, 1, 17, 30, project.video.frameCount - 1]) {
      const src = centroid(await truthAt(media(project.video.fileName), f), AW);
      const prev = centroid(await truthAt(media("proxy.mp4"), f), AW);
      expect(src.n).toBeGreaterThan(0.6 * SQUARE * SQUARE * (AW / c.display[0]) ** 2);
      expect(Math.abs(prev.x - src.x), `frame ${f}`).toBeLessThan(1);
      expect(Math.abs(prev.y - src.y), `frame ${f}`).toBeLessThan(1);
    }
  });

  if (c.display[0] < c.display[1]) {
    it("analyses rotated video upright (horizontal motion becomes vertical)", async () => {
      const a = centroid(await truthAt(media(project.video.fileName), 2), AW);
      const b = centroid(await truthAt(media(project.video.fileName), 40), AW);
      expect(Math.abs(b.y - a.y)).toBeGreaterThan(100);
      expect(Math.abs(b.x - a.x)).toBeLessThan(2);
    });

    it("builds an aligned VP9 preview for browsers without H.264", async () => {
      const { res, json } = await call(previewProxyRoute.POST as Handler, { method: "POST", params: { projectId } });
      expect(res.status).toBe(202);
      expect((await waitJob(json.job.id)).status).toBe("completed");
      const vp9 = ffprobeJson(media("proxy-vp9.webm")).streams.find((s) => s.codec_type === "video")!;
      expect(vp9).toMatchObject({ codec_name: "vp9", width: c.display[0], height: c.display[1] });
      for (const f of [0, 21, project.video.frameCount - 1]) {
        const src = centroid(await truthAt(media(project.video.fileName), f), AW);
        const prev = centroid(await truthAt(media("proxy-vp9.webm"), f), AW);
        expect(Math.abs(prev.x - src.x) + Math.abs(prev.y - src.y), `frame ${f}`).toBeLessThan(1.5);
      }
    });
  }

  it("segments from a box and tracks the object through the clip", async () => {
    const source = media(project.video.fileName);
    const truth20 = await truthAt(source, 20);
    const { box } = centroid(truth20, AW);
    const pad = 6;
    const seg = await call(segmentRoute.POST as Handler, {
      method: "POST",
      params: { projectId },
      body: {
        frameIndex: 20,
        box: { x0: Math.max(0, box.x0 - pad) / AW, y0: Math.max(0, box.y0 - pad) / AH, x1: Math.min(AW, box.x1 + pad) / AW, y1: Math.min(AH, box.y1 + pad) / AH },
      },
    });
    expect(seg.res.status, JSON.stringify(seg.json)).toBe(200);
    expect([seg.json.width, seg.json.height]).toEqual([AW, AH]);
    expect(iou(decodeMask(seg.json.counts, AW * AH), truth20)).toBeGreaterThan(0.8);

    const tr = await call(trackJobRoute.POST as Handler, {
      method: "POST",
      params: { projectId },
      body: { name: "Square", keyframes: [{ frameIndex: 20, mask: seg.json.counts }] },
    });
    expect(tr.res.status).toBe(202);
    const job = await waitJob(tr.json.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    trackId = job.result.trackId;

    const { json } = await call(trackRoute.GET as Handler, { params: { projectId, trackId } });
    const last = project.video.frameCount - 1;
    for (const f of [2, 20, 33, last - 1]) {
      const pred = decodeMask(json.track.frames[f], AW * AH);
      expect(iou(pred, await truthAt(source, f)), `frame ${f}`).toBeGreaterThan(0.7);
    }
  });

  it("exports in display orientation with every frame" + (c.audio ? " and the audio track" : ""), async () => {
    const format = c.audio?.exportFormat ?? "mp4_h264";
    const { res, json } = await call(exportsRoute.POST as Handler, {
      method: "POST",
      params: { projectId },
      body: {
        settings: { kind: "video", format, resolution: "source", fps: "source", quality: "low" },
        composite: { effect: "blur_background", subjectTrackIds: [trackId] },
      },
    });
    expect(res.status, JSON.stringify(json)).toBe(202);
    const job = await waitJob(json.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    expect(job.result).toMatchObject({ frames: project.video.frameCount, width: c.display[0], height: c.display[1] });

    const dl = await call(exportRoute.GET as Handler, { params: { projectId, exportId: json.exportId } });
    expect(dl.res.status).toBe(200);
    const out = path.join(dir, `${projectId}-${job.result.fileName}`);
    writeFileSync(out, Buffer.from(await dl.res.arrayBuffer()));
    const probe = ffprobeJson(out);
    const video = probe.streams.find((s) => s.codec_type === "video")!;
    expect(video).toMatchObject({ width: c.display[0], height: c.display[1] });
    expect(Number(video.nb_read_packets)).toBe(project.video.frameCount);
    const audio = probe.streams.find((s) => s.codec_type === "audio");
    if (c.audio) {
      expect(audio?.codec_name).toBe(c.audio.codec);
      expect(Number(probe.format.duration)).toBeCloseTo(FRAMES / FPS, 1);
    } else {
      expect(audio).toBeUndefined();
    }
  });
});
