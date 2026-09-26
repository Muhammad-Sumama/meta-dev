import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ID_PATTERNS } from "@/lib/schemas/project";
import type { Job } from "@/lib/schemas/job";
import { jobPath, jobsDir } from "../storage/paths";
import { readJson, writeJsonAtomic } from "../storage/fs";
import type { JobStore } from "./JobQueue";

/** Persists job state as JSON files (swap for a DB table in production). */
export class FileJobStore implements JobStore {
  async save(job: Job) {
    await writeJsonAtomic(jobPath(job.id), job);
  }

  async load(jobId: string) {
    if (!ID_PATTERNS.job.test(jobId)) return null;
    return readJson<Job>(jobPath(jobId));
  }

  async loadAll() {
    let files: string[] = [];
    try {
      files = await fs.readdir(jobsDir());
    } catch {
      return [];
    }
    const jobs = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJson<Job>(path.join(jobsDir(), f)).catch(() => null)),
    );
    return jobs.filter((j): j is Job => j !== null);
  }
}
