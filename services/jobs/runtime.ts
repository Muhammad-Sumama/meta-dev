import "server-only";
import { getConfig } from "@/lib/server/config";
import { registerWorkers } from "@/workers";
import { FileJobStore } from "./FileJobStore";
import { JobQueue } from "./JobQueue";

const g = globalThis as unknown as { __opensamQueue?: JobQueue };

/** Process-wide job queue (kept on globalThis so dev hot-reloads don't duplicate it). */
export function getJobQueue(): JobQueue {
  if (!g.__opensamQueue) g.__opensamQueue = new JobQueue(new FileJobStore(), getConfig().JOB_CONCURRENCY);
  // Re-register on every access so dev hot-reloads pick up edited handlers.
  registerWorkers(g.__opensamQueue);
  return g.__opensamQueue;
}
