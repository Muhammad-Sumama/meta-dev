import "server-only";
import { AppError } from "@/lib/errors";
import { killProcess, spawnFFmpeg } from "./ffmpeg";

/**
 * Streams decoded frames from FFmpeg as raw pixel buffers.
 *
 * Frames are produced lazily (async generator) so at most a few frames are
 * held in memory regardless of video length.
 *
 * Frame `i` is defined on an absolute grid: the picture on screen at time
 * `(i + 0.5) / fps`, i.e. the latest decoded frame whose timestamp rounds to
 * slot ≤ i. That is what a browser shows after seeking to mid-frame (see
 * lib/client/video.ts), and for constant-frame-rate video it is simply the
 * i-th frame. The grid is enforced with the `fps` filter anchored at 0, and
 * seeks keep the frames before the seek point (`-noaccurate_seek`) so the
 * filter can pick the right one — so a single-frame read, a stream from 0 and
 * a stream from the middle all agree, even on variable-frame-rate phone video.
 */

export type PixelFormat = "rgb24" | "rgba" | "gray";

const BYTES_PER_PIXEL: Record<PixelFormat, number> = { rgb24: 3, rgba: 4, gray: 1 };

export interface FrameReadOptions {
  width: number;
  height: number;
  pixelFormat?: PixelFormat;
  /** Source frame rate — needed to convert `startFrame` to a timestamp. */
  fps: number;
  startFrame?: number;
  /** Maximum frames to read. */
  count?: number;
  /** Resample to this frame rate (export). Frame indices then refer to the output rate. */
  outputFps?: number;
  signal?: AbortSignal;
}

export interface DecodedFrame {
  index: number;
  data: Buffer;
}

export function frameByteLength(width: number, height: number, fmt: PixelFormat): number {
  return width * height * BYTES_PER_PIXEL[fmt];
}

/** Start of grid slot `index`; `readFrames` seeks here and re-anchors the grid at 0. */
export function seekTimeForFrame(index: number, fps: number): number {
  return index <= 0 ? 0 : index / fps;
}

export async function* readFrames(file: string, opts: FrameReadOptions): AsyncGenerator<DecodedFrame> {
  const fmt = opts.pixelFormat ?? "rgb24";
  const frameSize = frameByteLength(opts.width, opts.height, fmt);
  const start = Math.max(0, opts.startFrame ?? 0);
  const filters = [
    `fps=${opts.outputFps ?? opts.fps}:start_time=0`,
    `scale=${opts.width}:${opts.height}:flags=area`,
    `format=${fmt}`,
  ];
  const args = [
    ...(start > 0 ? ["-noaccurate_seek", "-ss", seekTimeForFrame(start, opts.fps).toFixed(6)] : []),
    "-i", file,
    "-map", "0:v:0",
    "-an", "-sn",
    "-vf", filters.join(","),
    "-fps_mode", "passthrough",
    ...(opts.count !== undefined ? ["-frames:v", String(Math.max(1, Math.floor(opts.count)))] : []),
    "-f", "rawvideo",
    "-pix_fmt", fmt,
    "pipe:1",
  ];

  if (opts.signal?.aborted) throw abortError();
  const proc = spawnFFmpeg(args, { stdin: false, stdout: true });
  let stderr = "";
  proc.stderr!.on("data", (c: Buffer) => {
    if (stderr.length < 8000) stderr += c.toString();
  });
  const exited = new Promise<number | null>((resolve) => proc.on("close", (code) => resolve(code)));
  const spawnError = new Promise<never>((_, reject) => proc.on("error", reject));
  spawnError.catch(() => undefined);
  const onAbort = () => killProcess(proc);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let index = start;
  let completed = false;
  try {
    for await (const chunk of proc.stdout! as AsyncIterable<Buffer>) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= frameSize) {
        const all = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
        const frame = Buffer.from(all.subarray(0, frameSize));
        const rest = all.subarray(frameSize);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
        if (opts.signal?.aborted) throw abortError();
        yield { index: index++, data: frame };
      }
    }
    const code = await Promise.race([exited, spawnError]);
    if (opts.signal?.aborted) throw abortError();
    if (code !== 0 && index === start) {
      throw new AppError("CORRUPTED_VIDEO", {
        message: "We couldn't decode frames from this video.",
        cause: new Error(stderr.slice(-2000)),
      });
    }
    completed = true;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (!completed) killProcess(proc);
  }
}

export async function readFrameAt(file: string, index: number, opts: Omit<FrameReadOptions, "startFrame" | "count">) {
  for await (const frame of readFrames(file, { ...opts, startFrame: index, count: 1 })) {
    return frame.data;
  }
  throw new AppError("SEGMENTATION_FAILED", { message: "We couldn't read that frame of the video." });
}

/** Reads a contiguous range into memory (use for small chunks only). */
export async function readFrameRange(
  file: string,
  start: number,
  count: number,
  opts: Omit<FrameReadOptions, "startFrame" | "count">,
): Promise<DecodedFrame[]> {
  const out: DecodedFrame[] = [];
  for await (const f of readFrames(file, { ...opts, startFrame: start, count })) out.push(f);
  return out;
}

function abortError() {
  const e = new Error("Operation cancelled");
  e.name = "AbortError";
  return e;
}
