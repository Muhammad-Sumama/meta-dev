import "server-only";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { ID_PATTERNS } from "@/lib/schemas/project";
import { getConfig } from "@/lib/server/config";

/**
 * All filesystem paths are derived here from validated identifiers, so no
 * request value can escape the data directory (no `..`, no absolute paths).
 *
 * Layout:
 *   data/projects/<projectId>/project.json
 *   data/projects/<projectId>/media/{source.ext,proxy.mp4,poster.jpg,filmstrip.jpg}
 *   data/projects/<projectId>/tracks/<trackId>.json
 *   data/projects/<projectId>/exports/<exportId>.<ext>
 *   data/projects/<projectId>/cache/…            (analysis caches, safe to delete)
 *   data/jobs/<jobId>.json
 *   data/tmp/…                                    (in-flight uploads)
 */

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertId(kind: keyof typeof ID_PATTERNS, id: string): string {
  if (!ID_PATTERNS[kind].test(id)) throw new AppError("NOT_FOUND");
  return id;
}

function safeSegment(seg: string): string {
  if (!SAFE_SEGMENT.test(seg) || seg.includes("..")) {
    throw new AppError("VALIDATION_ERROR", { message: "Invalid file reference." });
  }
  return seg;
}

export function dataDir() {
  return getConfig().dataDir;
}
export function projectsDir() {
  return path.join(dataDir(), "projects");
}
export function jobsDir() {
  return path.join(dataDir(), "jobs");
}
export function tmpDir() {
  return path.join(dataDir(), "tmp");
}

export function projectDir(projectId: string) {
  return path.join(projectsDir(), assertId("project", projectId));
}

export function projectPath(projectId: string, ...segments: string[]) {
  const full = path.join(projectDir(projectId), ...segments.map(safeSegment));
  const root = projectDir(projectId) + path.sep;
  if (!full.startsWith(root)) throw new AppError("VALIDATION_ERROR", { message: "Invalid file reference." });
  return full;
}

export const mediaPath = (projectId: string, file: string) => projectPath(projectId, "media", file);
export const trackPath = (projectId: string, trackId: string) =>
  projectPath(projectId, "tracks", `${assertId("track", trackId)}.json`);
export const exportsDir = (projectId: string) => projectPath(projectId, "exports");
export const cacheDir = (projectId: string) => projectPath(projectId, "cache");
export const jobPath = (jobId: string) => path.join(jobsDir(), `${assertId("job", jobId)}.json`);
