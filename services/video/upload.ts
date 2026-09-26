import "server-only";
import { randomBytes } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { DEFAULT_COMPOSITE, type Project } from "@/lib/schemas/project";
import { getConfig } from "@/lib/server/config";
import { newId } from "@/lib/utils/ids";
import {
  ALLOWED_EXTENSIONS,
  MIME_BY_CONTAINER,
  extensionOf,
  projectNameFromFile,
  sanitizeFileName,
  sniffContainer,
  type ContainerKind,
} from "@/lib/validation/upload";
import { getProjectRepository } from "../projects";
import { assertDiskSpace, ensureDir } from "../storage/fs";
import { mediaPath, projectDir, tmpDir } from "../storage/paths";
import { resolveBinaries } from "./ffmpeg";
import { fitWithin } from "./ingest";
import { isBrowserPlayable, probeVideo } from "./probe";

export interface ReceivedUpload {
  tmpPath: string;
  size: number;
  container: ContainerKind;
}

/**
 * Streams a request body to a temp file, enforcing the size limit while
 * streaming (the body is never buffered in memory), then sniffs the header.
 */
export async function receiveUpload(
  body: ReadableStream<Uint8Array> | null,
  opts: { originalName: string; declaredSize?: number; signal?: AbortSignal },
): Promise<ReceivedUpload> {
  const cfg = getConfig();
  const maxBytes = cfg.MAX_UPLOAD_MB * 1024 * 1024;
  if (!body) throw new AppError("UPLOAD_FAILED", { message: "No file was received." });

  const ext = extensionOf(opts.originalName);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) throw new AppError("UNSUPPORTED_FORMAT");
  if (opts.declaredSize !== undefined && opts.declaredSize > maxBytes) {
    throw new AppError("UPLOAD_TOO_LARGE", {
      message: `This file is larger than the ${cfg.MAX_UPLOAD_MB} MB limit.`,
      details: { maxMb: cfg.MAX_UPLOAD_MB },
    });
  }

  await assertDiskSpace(tmpDir(), Math.ceil((opts.declaredSize ?? 0) / 1024 / 1024) * 2);
  await ensureDir(tmpDir());
  const tmpPath = path.join(tmpDir(), `${randomBytes(12).toString("hex")}.upload`);
  const out = createWriteStream(tmpPath, { flags: "wx" });
  const reader = body.getReader();
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new AppError("UPLOAD_FAILED", { message: "The upload was cancelled." });
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new AppError("UPLOAD_TOO_LARGE", {
          message: `This file is larger than the ${cfg.MAX_UPLOAD_MB} MB limit.`,
          details: { maxMb: cfg.MAX_UPLOAD_MB },
        });
      }
      if (head.length < 512) head = Buffer.concat([head, Buffer.from(value.subarray(0, 512 - head.length))]);
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    reader.cancel().catch(() => undefined);
    out.destroy();
    await fs.rm(tmpPath, { force: true });
    if (err instanceof AppError) throw err;
    throw new AppError("UPLOAD_FAILED", { cause: err });
  }

  if (size === 0) {
    await fs.rm(tmpPath, { force: true });
    throw new AppError("UPLOAD_FAILED", { message: "The uploaded file was empty." });
  }
  const container = sniffContainer(head);
  if (!container) {
    await fs.rm(tmpPath, { force: true });
    throw new AppError("UNSUPPORTED_FORMAT", {
      message: "This file isn't a video format we support, even though its name says it is.",
    });
  }
  return { tmpPath, size, container };
}

/**
 * Validates a received file with ffprobe and turns it into a project.
 * The file is moved (not copied) into the project directory.
 */
export async function createProjectFromFile(
  file: { path: string; size: number; container: ContainerKind; originalName: string; keepSource?: boolean },
  opts: { isDemo?: boolean; name?: string } = {},
): Promise<Project> {
  const cfg = getConfig();
  resolveBinaries(); // throws FFMPEG_UNAVAILABLE with a clear message

  let probe;
  try {
    probe = await probeVideo(file.path, { countFrames: file.size < 400 * 1024 * 1024 });
  } catch (err) {
    if (!file.keepSource) await fs.rm(file.path, { force: true });
    throw err;
  }

  const fail = async (err: AppError) => {
    if (!file.keepSource) await fs.rm(file.path, { force: true });
    throw err;
  };
  if (probe.duration > cfg.MAX_VIDEO_DURATION_SECONDS) {
    await fail(
      new AppError("VIDEO_TOO_LONG", {
        message: `This video is ${Math.round(probe.duration)}s long. The limit is ${cfg.MAX_VIDEO_DURATION_SECONDS}s.`,
        details: { maxSeconds: cfg.MAX_VIDEO_DURATION_SECONDS },
      }),
    );
  }
  if (Math.max(probe.width, probe.height) > cfg.MAX_VIDEO_DIMENSION) {
    await fail(new AppError("VIDEO_TOO_LARGE", { details: { maxDimension: cfg.MAX_VIDEO_DIMENSION } }));
  }

  const id = newId("prj");
  const ext = file.container === "mkv" ? ".mkv" : file.container === "webm" ? ".webm" : file.container === "mov" ? ".mov" : ".mp4";
  const fileName = `source${ext}`;
  const browserPlayable = isBrowserPlayable(file.container, probe);
  const analysis = fitWithin(probe.width, probe.height, cfg.ANALYSIS_MAX_SIZE);
  const now = new Date().toISOString();
  const originalName = sanitizeFileName(file.originalName);

  const project: Project = {
    schemaVersion: 1,
    id,
    name: opts.name ?? projectNameFromFile(originalName),
    isDemo: Boolean(opts.isDemo),
    createdAt: now,
    updatedAt: now,
    video: {
      originalName,
      fileName,
      sizeBytes: file.size,
      mimeType: MIME_BY_CONTAINER[file.container],
      container: file.container,
      codec: probe.codec,
      pixelFormat: probe.pixelFormat,
      width: probe.width,
      height: probe.height,
      rotation: probe.rotation,
      fps: probe.fps,
      frameCount: probe.frameCount,
      duration: probe.duration,
      hasAudio: probe.hasAudio,
      audioCodec: probe.audioCodec,
      bitRate: probe.bitRate,
      browserPlayable,
    },
    media: {
      proxy: { status: browserPlayable ? "not_needed" : "pending" },
      vp9Proxy: { status: "none" },
      poster: false,
      filmstrip: { status: "pending", count: 0, tileWidth: 0, tileHeight: 0 },
    },
    analysis,
    composite: { ...DEFAULT_COMPOSITE },
    commands: [],
    jobIds: [],
  };

  const repo = getProjectRepository();
  await repo.create(project);
  const dest = mediaPath(id, fileName);
  try {
    if (file.keepSource) await fs.copyFile(file.path, dest);
    else await fs.rename(file.path, dest).catch(async () => {
      await fs.copyFile(file.path, dest);
      await fs.rm(file.path, { force: true });
    });
  } catch (err) {
    await fs.rm(projectDir(id), { recursive: true, force: true });
    throw new AppError("UPLOAD_FAILED", { cause: err });
  }
  return project;
}
