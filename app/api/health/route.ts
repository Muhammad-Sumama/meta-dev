import { json, route } from "@/lib/server/api";
import { publicConfig } from "@/lib/server/config";
import { getAIServices } from "@/services/ai/registry";
import { getJobQueue } from "@/services/jobs/runtime";
import { getProjectRepository } from "@/services/projects";
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
  const jobs = getJobQueue();
  const queue = await Promise.race([
    jobs.stats(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
  ]).catch(() => ({ backend: jobs.backend, error: "The job queue (Redis) is unreachable, so videos can't be processed." }));
  const repo = getProjectRepository();
  const storage = { backend: repo.backend, ...(await repo.health()) };
  return json({
    ok: ffmpeg.available && !("error" in queue) && storage.ok,
    storage,
    ffmpeg: { available: ffmpeg.available, version: ffmpeg.version, encoders: ffmpeg.encoders, source: ffmpeg.source ?? null },
    formats,
    ai: {
      language: { ...ai.language.info, health: language },
      segmentation: { ...ai.segmentation.info, health: segmentation },
    },
    config: publicConfig(),
    queue,
  });
});
