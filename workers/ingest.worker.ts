import "server-only";
import type { JobHandler } from "@/services/jobs/JobQueue";
import { getProjectRepository, requireProject } from "@/services/projects";
import { mediaPath } from "@/services/storage/paths";
import { generateFilmstrip, generatePoster, generateProxy, generateVp9Proxy } from "@/services/video/ingest";

export interface IngestInput {
  projectId: string;
  /** "full" (after upload) or "vp9_proxy" (on-demand preview for browsers without H.264). */
  task?: "full" | "vp9_proxy";
}

/**
 * Post-upload processing: poster frame, timeline filmstrip, and (only when the
 * browser can't play the source) an H.264 preview proxy. The editor opens
 * immediately; these assets appear as they finish.
 */
export const ingestWorker: JobHandler<IngestInput, { proxy: boolean }> = async ({ job, signal, progress }) => {
  const repo = getProjectRepository();
  const project = await requireProject(job.input.projectId);
  const source = mediaPath(project.id, project.video.fileName);

  if (job.input.task === "vp9_proxy") {
    progress({ stage: "proxy", message: "Creating a preview your browser can play…", fraction: 0.02 });
    try {
      await generateVp9Proxy(source, mediaPath(project.id, "proxy-vp9.webm"), project.video, {
        signal,
        onProgress: (f) => progress({ fraction: 0.02 + f * 0.97, message: `Creating a preview your browser can play… ${Math.round(f * 100)}%` }),
      });
      await repo.update(project.id, (p) => {
        p.media.vp9Proxy = { status: "ready", fileName: "proxy-vp9.webm" };
      });
    } catch (err) {
      await repo.update(project.id, (p) => {
        p.media.vp9Proxy = { status: "failed" };
      });
      throw err;
    }
    return { proxy: true };
  }

  progress({ stage: "poster", message: "Generating preview frame…", fraction: 0.05 });
  try {
    await generatePoster(source, mediaPath(project.id, "poster.jpg"), { signal });
    await repo.update(project.id, (p) => {
      p.media.poster = true;
    });
  } catch (err) {
    console.warn("[ingest] poster failed", err);
  }

  const needsProxy = project.media.proxy.status === "pending";
  const filmstripShare = needsProxy ? 0.3 : 0.9;

  progress({ stage: "filmstrip", message: "Generating timeline thumbnails…", fraction: 0.1 });
  try {
    const layout = await generateFilmstrip(source, mediaPath(project.id, "filmstrip.jpg"), project.video, {
      signal,
      onProgress: (f) => progress({ fraction: 0.1 + f * filmstripShare }),
    });
    await repo.update(project.id, (p) => {
      p.media.filmstrip = { status: "ready", ...layout };
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    console.warn("[ingest] filmstrip failed", err);
    await repo.update(project.id, (p) => {
      p.media.filmstrip.status = "failed";
    });
  }

  if (needsProxy) {
    progress({ stage: "proxy", message: "Creating a browser-friendly preview…", fraction: 0.45 });
    try {
      await generateProxy(source, mediaPath(project.id, "proxy.mp4"), project.video, {
        signal,
        onProgress: (f) => progress({ fraction: 0.45 + f * 0.54, message: `Creating a browser-friendly preview… ${Math.round(f * 100)}%` }),
      });
      await repo.update(project.id, (p) => {
        p.media.proxy = { status: "ready", fileName: "proxy.mp4" };
      });
    } catch (err) {
      await repo.update(project.id, (p) => {
        p.media.proxy = { status: "failed" };
      });
      throw err;
    }
  }
  return { proxy: needsProxy };
};
