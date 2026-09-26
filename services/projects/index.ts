import "server-only";
import { AppError } from "@/lib/errors";
import { FileSystemProjectRepository } from "./FileSystemProjectRepository";
import type { ProjectRepository } from "./ProjectRepository";

const g = globalThis as unknown as { __opensamProjects?: ProjectRepository };

export function getProjectRepository(): ProjectRepository {
  // Rebuild if the class was hot-reloaded in development.
  if (!(g.__opensamProjects instanceof FileSystemProjectRepository)) g.__opensamProjects = new FileSystemProjectRepository();
  return g.__opensamProjects;
}

export async function requireProject(projectId: string) {
  const project = await getProjectRepository().get(projectId);
  if (!project) throw new AppError("NOT_FOUND", { message: "This project doesn't exist or was deleted." });
  return project;
}

export type { ProjectRepository };
