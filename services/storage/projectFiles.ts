import "server-only";
import { promises as fs } from "node:fs";
import { ensureDir } from "./fs";
import { projectDir, projectPath } from "./paths";

/** On-disk folders every project needs for media, exports and caches (whatever stores its metadata). */
export async function prepareProjectDirs(projectId: string) {
  await Promise.all(["media", "exports", "cache"].map((d) => ensureDir(projectPath(projectId, d))));
}

/** Removes a project's files from DATA_DIR. */
export async function removeProjectFiles(projectId: string) {
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}
