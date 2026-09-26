import "server-only";
import { once } from "node:events";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import yazl from "yazl";
import { buildAlpha } from "@/lib/compositing/alpha";
import { computeCleanPlate, type PlateSample } from "@/lib/compositing/cleanPlate";
import { applyEffect } from "@/lib/compositing/effects";
import { AppError } from "@/lib/errors";
import { decodeMask, maskForFrame } from "@/lib/mask/rle";
import type { JobProgress } from "@/lib/schemas/job";
import type { Composite, ExportSettings, Project, Track } from "@/lib/schemas/project";
import { getProjectRepository } from "../projects";
import { assertDiskSpace, ensureDir, writeFileAtomic } from "../storage/fs";
import { exportsDir, mediaPath } from "../storage/paths";
import { getFFmpegCapabilities, killProcess, mapFFmpegError, spawnFFmpeg } from "../video/ffmpeg";
import { readFrameAt, readFrames } from "../video/frames";
import { audioArgs, encoderArgs, FORMAT_SPECS, FORMATS_BY_KIND, isFormatAvailable, outputDimensions } from "./formats";

export interface ExportJobInput {
  exportId: string;
  settings: ExportSettings;
  composite: Composite;
}

export interface ExportResult {
  exportId: string;
  fileName: string;
  downloadName: string;
  sizeBytes: number;
  format: string;
  mime: string;
  frames: number;
  width: number;
  height: number;
  fps: number;
  warnings: string[];
}

interface Ctx {
  signal: AbortSignal;
  progress(update: Partial<JobProgress>): void;
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "opensam"
  );
}

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
}

export async function loadSubjectTracks(project: Project, composite: Composite): Promise<Track[]> {
  const repo = getProjectRepository();
  const summaries = await repo.listTracks(project.id);
  const wanted = composite.subjectTrackIds.length
    ? summaries.filter((t) => composite.subjectTrackIds.includes(t.id))
    : summaries.filter((t) => t.visible);
  const tracks = await Promise.all(wanted.map((t) => repo.getTrack(project.id, t.id)));
  return tracks.filter((t): t is Track => t !== null);
}

export async function runExport(project: Project, input: ExportJobInput, ctx: Ctx): Promise<ExportResult> {
  const { settings, composite, exportId } = input;
  const spec = FORMAT_SPECS[settings.format];
  if (!FORMATS_BY_KIND[settings.kind].includes(settings.format)) {
    throw new AppError("VALIDATION_ERROR", { message: "That format doesn't match the export type." });
  }
  const dir = exportsDir(project.id);
  await ensureDir(dir);
  const fileName = `${exportId}.${spec.extension}`;
  // Runtime data lives under DATA_DIR; exclude it from build-time file tracing.
  const outPath = path.join(/*turbopackIgnore: true*/ dir, fileName);
  const kindLabel = settings.kind === "png_sequence" ? "png-sequence" : settings.kind;
  const downloadName = `${slug(project.name)}-${kindLabel}.${spec.extension}`;
  const warnings: string[] = [];

  // --- Project export (no rendering) ----------------------------------------
  if (spec.format === "project_json") {
    ctx.progress({ stage: "packaging", message: "Packaging project…", fraction: 0.3 });
    const repo = getProjectRepository();
    const tracks = (await Promise.all((await repo.listTracks(project.id)).map((t) => repo.getTrack(project.id, t.id)))).filter(Boolean);
    const payload = { format: "opensam-project", formatVersion: 1, exportedAt: new Date().toISOString(), project, tracks };
    await writeFileAtomic(outPath, JSON.stringify(payload, null, 2));
    const st = await fs.stat(/*turbopackIgnore: true*/ outPath);
    return { exportId, fileName, downloadName, sizeBytes: st.size, format: spec.format, mime: spec.mime, frames: 0, width: 0, height: 0, fps: 0, warnings };
  }

  const caps = await getFFmpegCapabilities();
  if (!caps.available) throw new AppError("FFMPEG_UNAVAILABLE");
  if (!isFormatAvailable(spec, caps)) throw new AppError("FORMAT_UNAVAILABLE", { message: `${spec.label} isn't available on this server's FFmpeg build.` });

  const tracks = await loadSubjectTracks(project, composite);
  const effect = spec.matte ? "none" : composite.effect;
  if (!tracks.length && (spec.matte || spec.alpha || effect !== "none")) {
    throw new AppError("NO_SELECTION", {
      message: "There's no mask to export yet.",
      hint: "Select an object with the Select tool or ask the AI to track one first.",
    });
  }
  if (!spec.alpha && !spec.matte && effect === "remove_background") {
    warnings.push(`${spec.label} can't store transparency, so the removed background is black. Use WebM VP9 with transparency, ProRes 4444, or a PNG sequence for a transparent result.`);
  }

  const { width: W, height: H } = outputDimensions(settings, project.video);
  const srcFps = project.video.fps;
  const outFps = settings.fps === "source" ? srcFps : Number(settings.fps);
  const fpsChange = Math.abs(outFps - srcFps) > 0.001;
  const start = Math.min(settings.range?.start ?? 0, project.video.frameCount - 1);
  const end = Math.min(settings.range?.end ?? project.video.frameCount - 1, project.video.frameCount - 1);
  const srcCount = end - start + 1;
  const outCount = fpsChange ? Math.max(1, Math.floor((srcCount * outFps) / srcFps)) : srcCount;
  const srcIndexFor = (j: number) => Math.min(end, start + (fpsChange ? Math.round((j * srcFps) / outFps) : j));
  const sourcePath = mediaPath(project.id, project.video.fileName);

  const bytesPerFrame = W * H * (spec.matte ? 1 : 4);
  await assertDiskSpace(dir, Math.ceil((spec.sequence ? bytesPerFrame * outCount * 0.6 : bytesPerFrame * outCount * 0.05) / 1024 / 1024));

  // --- Alpha per source frame -----------------------------------------------
  const mw = project.analysis.width;
  const mh = project.analysis.height;
  const decoded = tracks.map(() => new Uint8Array(mw * mh));
  let cachedIdx = -1;
  let cachedAlpha: Uint8Array = new Uint8Array(W * H);
  const alphaFor = (srcIdx: number): Uint8Array => {
    if (srcIdx === cachedIdx) return cachedAlpha;
    const masks: Uint8Array[] = [];
    tracks.forEach((t, k) => {
      if (t.width !== mw || t.height !== mh) return;
      const hit = maskForFrame(t.frames, srcIdx, 0);
      if (hit) masks.push(decodeMask(hit.counts, mw * mh, decoded[k]));
    });
    cachedAlpha = masks.length
      ? buildAlpha(masks, mw, mh, W, H, { expand: composite.expand, feather: composite.feather, sourceHeight: project.video.height })
      : new Uint8Array(W * H);
    cachedIdx = srcIdx;
    return cachedAlpha;
  };

  // --- Clean plate for object removal ---------------------------------------
  let plate: Uint8Array | null = null;
  if (effect === "remove_object") {
    ctx.progress({ stage: "plate", message: "Building a clean plate…", fraction: 0.02 });
    const k = Math.max(5, Math.min(24, Math.floor((180 * 1024 * 1024) / (W * H * 5)), srcCount));
    const samples: PlateSample[] = [];
    for (let s = 0; s < k; s++) {
      abortIfNeeded(ctx.signal);
      const idx = start + Math.floor(((s + 0.5) * srcCount) / k);
      const rgba = new Uint8Array(await readFrameAt(sourcePath, idx, { width: W, height: H, fps: srcFps, pixelFormat: "rgba", signal: ctx.signal }));
      samples.push({ rgba, alpha: alphaFor(idx).slice() });
      ctx.progress({ stage: "plate", message: `Building a clean plate (${s + 1}/${k})…`, fraction: 0.02 + (0.08 * (s + 1)) / k });
    }
    const res = computeCleanPlate(samples, W, H);
    plate = res.plate;
    if (res.holeFraction > 0.002) {
      warnings.push("Part of the object never moved out of the way, so some of the removed area is filled approximately. Object removal works best on static-camera shots where the subject moves.");
    }
    cachedIdx = -1;
  }

  // --- Encoder ----------------------------------------------------------------
  const seqDir = spec.sequence ? path.join(dir, `${exportId}_frames`) : null;
  if (seqDir) await ensureDir(seqDir);
  const pipeFmt = spec.matte ? "gray" : "rgba";
  const withAudio = spec.audio && settings.includeAudio && project.video.hasAudio && !spec.matte;
  const args = [
    "-f", "rawvideo", "-pix_fmt", pipeFmt, "-s", `${W}x${H}`, "-r", String(outFps), "-i", "pipe:0",
    ...(withAudio ? ["-ss", (start / srcFps).toFixed(6), "-t", (srcCount / srcFps).toFixed(6), "-i", sourcePath, "-map", "0:v:0", "-map", "1:a:0?"] : ["-map", "0:v:0"]),
    ...encoderArgs(spec, settings.quality),
    ...(withAudio ? [...audioArgs(spec), "-shortest"] : ["-an"]),
    ...(seqDir ? ["-start_number", "0", path.join(seqDir, "frame_%06d.png")] : [outPath]),
  ];
  const encoder = spawnFFmpeg(args, { stdin: true, stdout: false });
  let encoderErr = "";
  encoder.stderr!.on("data", (c: Buffer) => {
    if (encoderErr.length < 16_000) encoderErr += c.toString();
  });
  const encoderExit = new Promise<number | null>((resolve) => encoder.on("close", (code) => resolve(code)));
  let encoderFailed = false;
  encoder.stdin!.on("error", () => {
    encoderFailed = true;
  });
  const onAbort = () => killProcess(encoder);
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  const write = async (buf: Uint8Array) => {
    if (encoderFailed) throw new AppError("EXPORT_FAILED", { cause: new Error(encoderErr.slice(-2000)) });
    if (!encoder.stdin!.write(buf)) await Promise.race([once(encoder.stdin!, "drain"), encoderExit]);
  };

  const effectParams = {
    effect,
    backgroundColor: composite.backgroundColor,
    blurStrength: composite.blurStrength,
    dim: composite.dim,
    overlayColor: tracks[0]?.color,
    plate,
    keepAlpha: spec.alpha,
  };

  const report = (j: number) =>
    ctx.progress({
      stage: "rendering",
      message: `Processing frame ${j + 1} / ${outCount}`,
      current: j + 1,
      total: outCount,
      fraction: (plate ? 0.1 : 0) + (plate ? 0.85 : 0.95) * ((j + 1) / outCount),
    });

  try {
    if (spec.matte) {
      for (let j = 0; j < outCount; j++) {
        abortIfNeeded(ctx.signal);
        await write(alphaFor(srcIndexFor(j)));
        report(j);
        if (j % 8 === 0) await new Promise<void>((r) => setImmediate(r));
      }
    } else {
      let j = 0;
      for await (const frame of readFrames(sourcePath, {
        width: W,
        height: H,
        pixelFormat: "rgba",
        fps: srcFps,
        startFrame: start,
        count: outCount,
        ...(fpsChange ? { outputFps: outFps } : {}),
        signal: ctx.signal,
      })) {
        if (j >= outCount) break;
        const rgba = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        if (tracks.length) applyEffect(rgba, alphaFor(srcIndexFor(j)), W, H, effectParams);
        await write(rgba);
        report(j);
        j++;
        if (j % 4 === 0) await new Promise<void>((r) => setImmediate(r));
      }
      if (j === 0) throw new AppError("EXPORT_FAILED", { message: "No frames could be read from the video." });
    }
    encoder.stdin!.end();
    const code = await encoderExit;
    abortIfNeeded(ctx.signal);
    if (code !== 0) {
      console.error(`[export] ffmpeg exited ${code}: ${encoderErr.slice(-2000)}`);
      throw mapFFmpegError(Object.assign(new Error("encoder failed"), { name: "ProcessError" }), "EXPORT_FAILED");
    }

    if (seqDir) {
      ctx.progress({ stage: "packaging", message: "Packaging the sequence…", fraction: 0.97 });
      await zipDirectory(seqDir, outPath, {
        readme: [
          `OpenSAM Studio export — ${project.name}`,
          `${spec.label}, ${W}x${H}, ${outFps.toFixed(3)} fps, ${outCount} frames.`,
          spec.matte ? "White = subject, black = background." : "RGBA PNGs; transparency is preserved where the effect removes pixels.",
        ].join("\n"),
      });
    }
  } catch (err) {
    killProcess(encoder);
    await fs.rm(outPath, { force: true });
    if (err instanceof AppError) throw err;
    throw mapFFmpegError(err, "EXPORT_FAILED");
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
    if (seqDir) await fs.rm(seqDir, { recursive: true, force: true });
  }

  const st = await fs.stat(/*turbopackIgnore: true*/ outPath);
  return { exportId, fileName, downloadName, sizeBytes: st.size, format: spec.format, mime: spec.mime, frames: outCount, width: W, height: H, fps: outFps, warnings };
}

async function zipDirectory(dir: string, outFile: string, opts: { readme?: string } = {}) {
  const zip = new yazl.ZipFile();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
  for (const f of files) zip.addFile(path.join(dir, f), `frames/${f}`, { compress: false });
  if (opts.readme) zip.addBuffer(Buffer.from(opts.readme + "\n"), "README.txt");
  zip.end();
  const out = createWriteStream(outFile);
  zip.outputStream.pipe(out);
  await once(out, "close");
}
