import "server-only";
import { getConfig } from "@/lib/server/config";
import type { JobType } from "@/lib/schemas/job";
import { registerWorkers } from "@/workers";
import { FileJobStore } from "./FileJobStore";
import { JobQueue } from "./JobQueue";
import { RedisJobQueue } from "./redis/RedisJobQueue";
import type { JobQueuePort } from "./types";

const g = globalThis as unknown as { __opensamQueue?: JobQueuePort };

export function workerJobTypes(): JobType[] {
  return getConfig().WORKER_JOB_TYPES.split(",") as JobType[];
}

export function createRedisJobQueue(): RedisJobQueue {
  const c = getConfig();
  return new RedisJobQueue({
    url: c.REDIS_URL,
    prefix: c.JOB_QUEUE_PREFIX,
    concurrency: c.JOB_CONCURRENCY,
    retentionSeconds: c.JOB_RETENTION_HOURS * 3600,
  });
}

/**
 * Process-wide job queue (kept on globalThis so dev hot-reloads don't
 * duplicate it). JOB_BACKEND=memory runs handlers here; JOB_BACKEND=redis only
 * enqueues, and `npm run worker` processes run them — unless
 * RUN_WORKERS_IN_WEB=true also starts a worker in this process.
 */
export function getJobQueue(): JobQueuePort {
  const c = getConfig();
  if (c.JOB_BACKEND === "redis") {
    if (!(g.__opensamQueue instanceof RedisJobQueue)) {
      const queue = createRedisJobQueue();
      g.__opensamQueue = queue;
      if (c.RUN_WORKERS_IN_WEB) {
        registerWorkers(queue);
        queue.startWorkers(workerJobTypes()).catch((err) => console.error("[jobs] couldn't start in-process workers", err));
      }
    }
    return g.__opensamQueue;
  }
  if (!(g.__opensamQueue instanceof JobQueue)) g.__opensamQueue = new JobQueue(new FileJobStore(), c.JOB_CONCURRENCY);
  // Re-register on every access so dev hot-reloads pick up edited handlers.
  registerWorkers(g.__opensamQueue);
  return g.__opensamQueue;
}

/** For tests: drop the process-wide queue (closing a Redis one). */
export async function resetJobQueueForTesting() {
  const q = g.__opensamQueue;
  g.__opensamQueue = undefined;
  if (q instanceof RedisJobQueue) await q.close({ graceMs: 0 });
}
