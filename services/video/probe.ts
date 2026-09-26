import "server-only";
import { AppError } from "@/lib/errors";
import type { ContainerKind } from "@/lib/validation/upload";
import { mapFFmpegError, runFFprobe } from "./ffmpeg";

export interface ProbeResult {
  container: string;
  codec: string;
  pixelFormat?: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  fps: number;
  frameCount: number;
  duration: number;
  hasAudio: boolean;
  audioCodec?: string;
  bitRate?: number;
}

interface FFprobeStream {
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  nb_read_packets?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number | string }>;
  disposition?: { attached_pic?: number };
}

interface FFprobeOutput {
  streams?: FFprobeStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}

export function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) return null;
  const v = n / d;
  return v > 0 && v < 1000 ? v : null;
}

function normalizeRotation(raw: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

/** Pure parser (exported for tests). */
export function parseProbeOutput(json: FFprobeOutput): ProbeResult {
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video || !video.width || !video.height) {
    throw new AppError("CORRUPTED_VIDEO", { message: "This file doesn't contain a video track we can read." });
  }
  const audio = streams.find((s) => s.codec_type === "audio");
  const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
  if (!fps) throw new AppError("CORRUPTED_VIDEO", { message: "We couldn't determine this video's frame rate." });

  const duration = Number(video.duration) || Number(json.format?.duration) || 0;
  if (!(duration > 0)) throw new AppError("CORRUPTED_VIDEO", { message: "We couldn't determine this video's length." });

  let frameCount = Number(video.nb_read_packets) || Number(video.nb_frames) || 0;
  if (!(frameCount > 0)) frameCount = Math.max(1, Math.round(duration * fps));

  let rotation: 0 | 90 | 180 | 270 = 0;
  const sideRot = video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation;
  if (sideRot !== undefined) rotation = normalizeRotation(Number(sideRot));
  else if (video.tags?.rotate) rotation = normalizeRotation(Number(video.tags.rotate));

  // FFmpeg and browsers both auto-rotate on decode, so store display dimensions.
  const swap = rotation === 90 || rotation === 270;
  return {
    container: json.format?.format_name ?? "unknown",
    codec: video.codec_name ?? "unknown",
    pixelFormat: video.pix_fmt,
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    rotation,
    fps,
    frameCount,
    duration,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name,
    bitRate: Number(json.format?.bit_rate) || undefined,
  };
}

export async function probeVideo(file: string, opts: { countFrames?: boolean; signal?: AbortSignal } = {}): Promise<ProbeResult> {
  let stdout: Buffer;
  try {
    ({ stdout } = await runFFprobe(
      [
        "-v", "error",
        ...(opts.countFrames ? ["-count_packets"] : []),
        "-print_format", "json",
        "-show_format", "-show_streams",
        file,
      ],
      { timeoutMs: 60_000, signal: opts.signal },
    ));
  } catch (err) {
    throw mapFFmpegError(err, "CORRUPTED_VIDEO");
  }
  let json: FFprobeOutput;
  try {
    json = JSON.parse(stdout.toString("utf8"));
  } catch (err) {
    throw new AppError("CORRUPTED_VIDEO", { cause: err });
  }
  return parseProbeOutput(json);
}

const PLAYABLE: Record<ContainerKind, string[]> = {
  mp4: ["h264", "av1", "vp9"],
  mov: [],
  webm: ["vp8", "vp9", "av1"],
  mkv: [],
};

/** Whether browsers can play the file directly (otherwise we create an H.264 proxy). */
export function isBrowserPlayable(kind: ContainerKind, probe: ProbeResult): boolean {
  if (!PLAYABLE[kind].includes(probe.codec)) return false;
  if (probe.pixelFormat && !["yuv420p", "yuvj420p"].includes(probe.pixelFormat)) return false;
  return probe.width <= 4096 && probe.height <= 4096;
}
