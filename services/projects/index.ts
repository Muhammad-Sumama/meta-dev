import "server-only";
import { AppError } from "@/lib/errors";
import { getConfig } from "@/lib/server/config";
import { FileSystemProjectRepository } from "./FileSystemProjectRepository";
import { PostgresProjectRepository } from "./postgres/PostgresProjectRepository";
import type { ProjectRepository } from "./ProjectRepository";

const g = globalThis as unknown as { __opensamProjects?: ProjectRepository };

/** Process-wide repository for PROJECT_STORE (file | postgres). */
export function getProjectRepository(): ProjectRepository {
  const c = getConfig();
  if (c.PROJECT_STORE === "postgres") {
    // Rebuild if the class was hot-reloaded in development.
    if (!(g.__opensamProjects instanceof PostgresProjectRepository)) {
      g.__opensamProjects = new PostgresProjectRepository(c.DATABASE_URL!, { poolSize: c.DATABASE_POOL_SIZE });
    }
  } else if (!(g.__opensamProjects instanceof FileSystemProjectRepository)) {
    g.__opensamProjects = new FileSystemProjectRepository();
  }
  return g.__opensamProjects;
}

/** For tests: drop the process-wide repository (closing a database pool). */
export async function resetProjectRepositoryForTesting() {
  const repo = g.__opensamProjects;
  g.__opensamProjects = undefined;
  if (repo instanceof PostgresProjectRepository) await repo.close();
}

export async function requireProject(projectId: string) {
  const project = await getProjectRepository().get(projectId);
  if (!project) throw new AppError("NOT_FOUND", { message: "This project doesn't exist or was deleted." });
  return project;
}

export type { ProjectRepository };
