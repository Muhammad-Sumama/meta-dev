import "server-only";
import { mapFFmpegError, runFFmpeg } from "./ffmpeg";

/** Fits (w,h) inside maxSide preserving aspect; returns even dimensions. */
export function fitWithin(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const even = (v: number) => Math.max(2, Math.round((v * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

export async function generatePoster(source: string, out: string, opts: { signal?: AbortSignal } = {}) {
  try {
    await runFFmpeg(
      ["-loglevel", "error", "-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", out],
      { timeoutMs: 60_000, signal: opts.signal },
    );
  } catch (err) {
    throw mapFFmpegError(err, "CORRUPTED_VIDEO");
  }
}

export const FILMSTRIP_TILE_HEIGHT = 54;

export function filmstripLayout(duration: number, width: number, height: number) {
  const count = Math.max(8, Math.min(120, Math.round(duration * 2)));
  const tileHeight = FILMSTRIP_TILE_HEIGHT;
  const tileWidth = Math.max(2, Math.round((tileHeight * (width / height)) / 2) * 2);
  return { count, tileWidth, tileHeight };
}

/** A single horizontal sprite of evenly spaced thumbnails for the timeline. */
export async function generateFilmstrip(
  source: string,
  out: string,
  meta: { duration: number; width: number; height: number },
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
) {
  const layout = filmstripLayout(meta.duration, meta.width, meta.height);
  const rate = layout.count / meta.duration;
  try {
    await runFFmpeg(
      [
        "-loglevel", "error",
        "-i", source,
        "-map", "0:v:0",
        "-vf", `fps=${rate.toFixed(6)},scale=${layout.tileWidth}:${layout.tileHeight},tile=${layout.count}x1`,
        "-frames:v", "1",
        "-q:v", "4",
        "-progress", "pipe:1", "-nostats",
        out,
      ],
      {
        timeoutMs: 10 * 60_000,
        signal: opts.signal,
        onProgress: (f) => {
          const us = Number(f.out_time_us ?? f.out_time_ms);
          if (Number.isFinite(us) && us > 0) opts.onProgress?.(Math.min(1, us / 1e6 / meta.duration));
        },
      },
    );
  } catch (err) {
    throw mapFFmpegError(err, "CORRUPTED_VIDEO");
  }
  return layout;
}

/**
 * Browser-friendly H.264 proxy for sources browsers can't play (ProRes, HEVC
 * in MOV, MKV…). Timestamps are passed through so proxy frame N == source
 * frame N, which keeps masks aligned.
 */
export async function generateProxy(
  source: string,
  out: string,
  meta: { duration: number; codec: string; container: string; hasAudio: boolean },
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
) {
  const canCopy = meta.codec === "h264";
  const args = [
    "-loglevel", "error",
    "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...(canCopy
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-vf", "scale='min(1920,iw)':-2"]),
    "-fps_mode", "passthrough",
    ...(meta.hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : []),
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    out,
  ];
  try {
    await runFFmpeg(args, {
      timeoutMs: 60 * 60_000,
      signal: opts.signal,
      onProgress: (f) => {
        const us = Number(f.out_time_us ?? f.out_time_ms);
        if (Number.isFinite(us) && us > 0) opts.onProgress?.(Math.min(1, us / 1e6 / meta.duration));
      },
    });
  } catch (err) {
    throw mapFFmpegError(err, "CORRUPTED_VIDEO");
  }
}

/**
 * VP9/WebM preview proxy (≤ 1280px) for browsers that can't decode H.264.
 * Uses realtime VP9 settings — it's a preview, not a deliverable.
 */
export async function generateVp9Proxy(
  source: string,
  out: string,
  meta: { duration: number; hasAudio: boolean },
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
) {
  try {
    await runFFmpeg(
      [
        "-loglevel", "error",
        "-i", source,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1",
        "-crf", "34", "-b:v", "0", "-pix_fmt", "yuv420p",
        "-vf", "scale='min(1280,iw)':-2",
        "-fps_mode", "passthrough",
        ...(meta.hasAudio ? ["-c:a", "libopus", "-b:a", "128k"] : ["-an"]),
        "-progress", "pipe:1", "-nostats",
        out,
      ],
      {
        timeoutMs: 60 * 60_000,
        signal: opts.signal,
        onProgress: (f) => {
          const us = Number(f.out_time_us ?? f.out_time_ms);
          if (Number.isFinite(us) && us > 0) opts.onProgress?.(Math.min(1, us / 1e6 / meta.duration));
        },
      },
    );
  } catch (err) {
    throw mapFFmpegError(err, "CORRUPTED_VIDEO");
  }
}
