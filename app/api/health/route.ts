import { json, route } from "@/lib/server/api";
import { publicConfig } from "@/lib/server/config";
import { getAIServices } from "@/services/ai/registry";
import { getJobQueue } from "@/services/jobs/runtime";
import { getFFmpegCapabilities } from "@/services/video/ffmpeg";
import { FORMAT_SPECS, isFormatAvailable } from "@/services/export/formats";

export const runtime = "nodejs";

/** System status for the Settings panel: FFmpeg, AI providers, limits, queue. */
export const GET = route(async () => {
  const ai = getAIServices();
  const [ffmpeg, language, segmentation] = await Promise.all([
    getFFmpegCapabilities(),
    ai.language.health(),
    ai.segmentation.health(),
  ]);
  const formats = Object.fromEntries(Object.values(FORMAT_SPECS).map((s) => [s.format, isFormatAvailable(s, ffmpeg)]));
  return json({
    ok: ffmpeg.available,
    ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, encoders: ffmpeg.encoders, source: ffmpeg.source ?? null },
    formats,
    ai: {
      language: { ...ai.language.info, health: language },
      segmentation: { ...ai.segmentation.info, health: segmentation },
    },
    config: publicConfig(),
    queue: getJobQueue().stats,
  });
});
