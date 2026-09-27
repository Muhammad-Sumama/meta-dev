/**
 * Standalone job worker (JOB_BACKEND=redis).
 *
 *   npm run worker                                # all job types
 *   WORKER_JOB_TYPES=segment npm run worker       # e.g. only on GPU machines
 *
 * Reads the same environment/.env files as the web app. Runs handlers from
 * ./index.ts against the Redis queue; SIGTERM/SIGINT stop taking new jobs,
 * give running ones WORKER_SHUTDOWN_GRACE_MS (default 25 s) to finish, and
 * record the rest as interrupted so users can re-run them.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main() {
  // Imported after the environment is loaded: config is read on first use.
  const { getConfig } = await import("@/lib/server/config");
  const { createRedisJobQueue, workerJobTypes } = await import("@/services/jobs/runtime");
  const { registerWorkers } = await import("./index");

  const config = getConfig();
  if (config.JOB_BACKEND !== "redis") {
    console.error("[worker] JOB_BACKEND must be \"redis\" to run a separate worker (memory mode runs jobs inside the web server).");
    process.exit(2);
  }
  const types = workerJobTypes();
  const queue = createRedisJobQueue();
  registerWorkers(queue);
  await queue.startWorkers(types);
  console.log(`[worker] ${queue.workerName} ready · jobs: ${types.join(", ")} · concurrency ${config.JOB_CONCURRENCY} · data ${config.dataDir}`);

  const graceMs = Number(process.env.WORKER_SHUTDOWN_GRACE_MS ?? 25_000);
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      console.log(`[worker] ${signal} again — exiting now`);
      process.exit(1);
    }
    stopping = true;
    console.log(`[worker] ${signal}: finishing running jobs (up to ${Math.round(graceMs / 1000)} s)…`);
    queue
      .close({ graceMs })
      .then(() => {
        console.log("[worker] stopped");
        process.exit(0);
      })
      .catch((err) => {
        console.error("[worker] shutdown failed", err);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] failed to start", err);
  process.exit(1);
});
