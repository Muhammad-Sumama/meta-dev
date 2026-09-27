import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { getConfig } from "@/lib/server/config";
import { rangeResponse, serveFile, type ServeOptions } from "@/lib/server/files";
import { readJson, writeJsonAtomic } from "./fs";
import { getObjectStore } from "./objectStore";
import { assertId, projectPath, projectsDir } from "./paths";

/**
 * Project files (`media/…`, `exports/…`) across machines.
 *
 * MEDIA_STORE=local: DATA_DIR is the only copy; these helpers are plain file
 * access. MEDIA_STORE=s3: whoever produces a file publishes it; whoever needs
 * one on disk (FFmpeg, the inference upload) calls `ensureLocal`, which
 * downloads it into this machine's DATA_DIR cache (bounded by
 * MEDIA_CACHE_MAX_MB); the web server streams straight from the bucket when
 * it has no local copy.
 */

const FOLDERS = new Set(["media", "exports"]);
const NOT_READY = "That file isn't available (it may still be processing).";

function split(rel: string): [string, string] {
  const parts = rel.split("/");
  if (parts.length !== 2 || !FOLDERS.has(parts[0])) throw new AppError("VALIDATION_ERROR", { message: "Invalid file reference." });
  return [parts[0], parts[1]];
}

/** Path of a project file on this machine (validated: no traversal). */
export function localProjectFile(projectId: string, rel: string): string {
  return projectPath(projectId, ...split(rel));
}

function objectKey(projectId: string, rel: string) {
  split(rel);
  return `projects/${assertId("project", projectId)}/${rel}`;
}

/** Marks a cached file as recently used; false if it isn't here. */
async function touch(file: string): Promise<boolean> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return false;
    await fs.utimes(file, new Date(), st.mtime);
    return true;
  } catch {
    return false;
  }
}

/** Makes a file this machine produced durable (no-op with MEDIA_STORE=local). */
export async function publish(projectId: string, rel: string, contentType?: string) {
  const store = getObjectStore();
  if (!store) return;
  await store.putFile(objectKey(projectId, rel), localProjectFile(projectId, rel), contentType);
}

const downloads = new Map<string, Promise<string>>();

/** Local path of a project file, downloading it into the cache first if needed. */
export async function ensureLocal(projectId: string, rel: string): Promise<string> {
  const file = localProjectFile(projectId, rel);
  const store = getObjectStore();
  if (!store || (await touch(file))) return file;
  let pending = downloads.get(file);
  if (!pending) {
    pending = (async () => {
      if (!(await store.getToFile(objectKey(projectId, rel), file))) throw new AppError("NOT_FOUND", { message: NOT_READY });
      trimCache(file).catch((err) => console.warn("[media] cache trim failed", err));
      return file;
    })().finally(() => downloads.delete(file));
    downloads.set(file, pending);
  }
  return pending;
}

/** Serves a project file with Range support: the local copy if this machine has one, else from the bucket. */
export async function serveProjectFile(request: Request, projectId: string, rel: string, opts: ServeOptions): Promise<Response> {
  const file = localProjectFile(projectId, rel);
  const store = getObjectStore();
  if (!store || (await touch(file))) return serveFile(request, file, opts);
  const key = objectKey(projectId, rel);
  const info = await store.head(key);
  if (!info) throw new AppError("NOT_FOUND", { message: NOT_READY });
  return rangeResponse(
    request,
    {
      ...info,
      open: async (range) => {
        const body = await store.read(key, range);
        if (!body) throw new AppError("NOT_FOUND", { message: NOT_READY });
        return body;
      },
    },
    opts,
  );
}

export async function writeProjectJson(projectId: string, rel: string, value: unknown) {
  await writeJsonAtomic(localProjectFile(projectId, rel), value);
  await publish(projectId, rel, "application/json");
}

export async function readProjectJson<T>(projectId: string, rel: string): Promise<T | null> {
  const local = await readJson<T>(localProjectFile(projectId, rel));
  if (local !== null || !getObjectStore()) return local;
  try {
    return readJson<T>(await ensureLocal(projectId, rel));
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return null;
    throw err;
  }
}

/** Deletes a project's files from the bucket (the local copy is removed by the repository). */
export async function removePublishedFiles(projectId: string) {
  await getObjectStore()?.deletePrefix(`projects/${assertId("project", projectId)}/`);
}

/**
 * Keeps this machine's media cache under MEDIA_CACHE_MAX_MB by deleting the
 * least recently used files. Files used in the last hour are kept (a running
 * job may still read them); everything evicted is still in the bucket.
 */
export async function trimCache(keep?: string) {
  if (!getObjectStore()) return;
  const limit = getConfig().MEDIA_CACHE_MAX_MB * 1024 * 1024;
  const files: Array<{ file: string; size: number; used: number }> = [];
  let projects: string[] = [];
  try {
    projects = await fs.readdir(projectsDir());
  } catch {
    return;
  }
  for (const id of projects) {
    for (const folder of FOLDERS) {
      const dir = path.join(/*turbopackIgnore: true*/ projectsDir(), id, folder);
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(/*turbopackIgnore: true*/ dir, name);
        const st = await fs.stat(file).catch(() => null);
        if (st?.isFile()) files.push({ file, size: st.size, used: Math.max(st.atimeMs, st.mtimeMs) });
      }
    }
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  const cutoff = Date.now() - 3600_000;
  for (const f of files.sort((a, b) => a.used - b.used)) {
    if (total <= limit) break;
    if (f.file === keep || f.used > cutoff || f.file.endsWith(".part")) continue;
    await fs.rm(f.file, { force: true });
    total -= f.size;
  }
}
