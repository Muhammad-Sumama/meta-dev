import "server-only";
import { AppError } from "@/lib/errors";
import { getConfig } from "@/lib/server/config";
import { getProjectRepository } from "@/services/projects";

/**
 * The job's project. When it's missing in a separate worker process, the
 * likely cause (besides a deletion) is a deployment where this worker can't
 * see the web server's projects — say so in the log.
 */
export async function requireJobProject(projectId: string) {
  const project = await getProjectRepository().get(projectId);
  if (project) return project;
  const c = getConfig();
  if (c.JOB_BACKEND === "redis" && c.PROJECT_STORE === "file") {
    console.warn(
      `[worker] project ${projectId} not found. If it wasn't just deleted, this worker doesn't share the web server's projects: ` +
        `use PROJECT_STORE=postgres, or give both the same DATA_DIR (currently ${c.dataDir}).`,
    );
  }
  throw new AppError("NOT_FOUND", { message: "This project doesn't exist or was deleted." });
}
