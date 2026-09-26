import "server-only";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { getConfig } from "@/lib/server/config";

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Write-then-rename so readers never observe a half-written file. */
export async function writeFileAtomic(file: string, data: string | Buffer) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function writeJsonAtomic(file: string, value: unknown) {
  await writeFileAtomic(file, JSON.stringify(value));
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function freeDiskMb(dir: string): Promise<number | null> {
  try {
    await ensureDir(dir);
    const st = await fs.statfs(dir);
    return (st.bavail * st.bsize) / 1024 / 1024;
  } catch {
    return null;
  }
}

/** Throws INSUFFICIENT_RESOURCES when free space is below the configured floor. */
export async function assertDiskSpace(dir: string, extraMb = 0) {
  const free = await freeDiskMb(dir);
  if (free === null) return;
  const need = getConfig().MIN_FREE_DISK_MB + extraMb;
  if (free < need) {
    throw new AppError("INSUFFICIENT_RESOURCES", {
      message: "The server is running low on disk space.",
      hint: "Delete old projects or exports, then try again.",
      details: { freeMb: Math.round(free) },
    });
  }
}

/** Serializes async operations per key (e.g. read-modify-write of project.json). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
