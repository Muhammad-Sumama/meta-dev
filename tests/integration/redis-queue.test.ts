/**
 * RedisJobQueue against a real redis-server. Separate queue instances stand
 * in for separate processes: `web` only enqueues/observes, `worker` instances
 * run handlers. (tests/integration/worker-process.test.ts runs a real worker
 * process through the whole pipeline.)
 */
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { Job, JobType } from "@/lib/schemas/job";
import { RedisJobQueue, type RedisQueueTimings } from "@/services/jobs/redis/RedisJobQueue";
import type { JobHandler } from "@/services/jobs/types";
import { redisAvailable, startRedis } from "../helpers/redis";

type Input = { mode: "ok" | "fail" | "slow" | "hang" | "crash"; n?: number };

const FAST: Partial<RedisQueueTimings> = { heartbeatMs: 200, heartbeatTtlMs: 600, lockDurationMs: 1_000, stalledIntervalMs: 500, janitorMs: 60_000, progressFlushMs: 30 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!redisAvailable)("RedisJobQueue", () => {
  let redis: { url: string; stop(): Promise<void> };
  let prefix: string;
  const open: RedisJobQueue[] = [];
  const calls: Record<string, number> = {};

  const handler: JobHandler<Input> = async ({ job, signal, progress }) => {
    calls[job.id] = (calls[job.id] ?? 0) + 1;
    const { mode, n = 0 } = job.input;
    if (mode === "fail") throw new AppError("EXPORT_FAILED", { message: "The encoder gave up." });
    if (mode === "crash") throw new Error("segfault-ish");
    if (mode === "hang") return new Promise(() => undefined); // ignores the signal, like a wedged process
    const steps = mode === "slow" ? 200 : 5;
    for (let i = 1; i <= steps; i++) {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      progress({ stage: "work", message: `Step ${i}`, current: i, total: steps });
      await sleep(mode === "slow" ? 20 : 5);
    }
    return { doubled: n * 2 };
  };

  function makeQueue(opts: { worker?: JobType[]; timings?: Partial<RedisQueueTimings>; handle?: JobHandler<Input> } = {}) {
    const q = new RedisJobQueue({ url: redis.url, prefix, concurrency: 2, retentionSeconds: 3600, timings: { ...FAST, ...opts.timings } });
    open.push(q);
    if (opts.worker) {
      for (const t of opts.worker) q.register(t, opts.handle ?? handler);
      return q.startWorkers(opts.worker).then(() => q);
    }
    return Promise.resolve(q);
  }

  const enqueue = (q: RedisJobQueue, input: Input, type: JobType = "export") =>
    q.enqueue({ type, projectId: "prj_aaaaaaaaaaaa", label: input.mode, input });

  async function waitForStatus(q: RedisJobQueue, id: string, status: Job["status"], timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await q.get(id))?.status === status) return;
      await sleep(25);
    }
    throw new Error(`job ${id} never reached ${status} (is ${(await q.get(id))?.status})`);
  }

  beforeAll(async () => {
    redis = await startRedis();
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((q) => q.close({ graceMs: 0, abortGraceMs: 200 })));
  });
  afterAll(async () => {
    await redis?.stop();
  });

  beforeEach(() => {
    prefix = `t${randomBytes(4).toString("hex")}`;
  });

  it("runs a job in another process, streaming progress and the result", async () => {
    const web = await makeQueue();
    await makeQueue({ worker: ["export"] });
    const events: Job[] = [];
    web.subscribe((j) => events.push(j));
    const job = await enqueue(web, { mode: "ok", n: 21 });
    expect(job).toMatchObject({ status: "queued", progress: { message: "Waiting for a worker…" } });

    const done = await web.waitFor(job.id, 10_000);
    expect(done).toMatchObject({ status: "completed", result: { doubled: 42 }, progress: { fraction: 1 } });
    expect(done.startedAt && done.finishedAt).toBeTruthy();

    const statuses = events.filter((e) => e.id === job.id).map((e) => e.status);
    expect(statuses).toContain("processing");
    expect(statuses.at(-1)).toBe("completed");
    const fractions = events.filter((e) => e.status === "processing").map((e) => e.progress.fraction);
    expect(fractions.some((f) => f > 0 && f < 1)).toBe(true);

    expect((await web.list({ projectId: "prj_aaaaaaaaaaaa" })).map((j) => j.id)).toEqual([job.id]);
    expect(await web.list({ activeOnly: true })).toEqual([]);
    const stats = await web.stats();
    expect(stats).toMatchObject({ backend: "redis", running: 0, queued: 0 });
    expect(stats.workers?.export).toBe(1);
    expect(stats.workers?.segment).toBe(0);
  });

  it("records handler errors with their user-facing message", async () => {
    const web = await makeQueue();
    await makeQueue({ worker: ["export"] });
    const failed = await web.waitFor((await enqueue(web, { mode: "fail" })).id, 10_000);
    expect(failed).toMatchObject({ status: "failed", error: { code: "EXPORT_FAILED", message: "The encoder gave up." } });
    const crashed = await web.waitFor((await enqueue(web, { mode: "crash" })).id, 10_000);
    expect(crashed).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(crashed.error?.message).not.toMatch(/segfault/);
  });

  it("cancels a queued job so no worker ever runs it", async () => {
    const web = await makeQueue();
    const job = await enqueue(web, { mode: "ok" }, "ingest"); // nobody takes ingest yet
    const cancelled = await web.cancel(job.id);
    expect(cancelled.status).toBe("cancelled");
    await makeQueue({ worker: ["ingest"] });
    await sleep(400);
    expect(calls[job.id]).toBeUndefined();
    expect((await web.get(job.id))?.status).toBe("cancelled");
  });

  it("cancels a running job in another process", async () => {
    const web = await makeQueue();
    await makeQueue({ worker: ["export"] });
    const job = await enqueue(web, { mode: "slow" });
    await waitForStatus(web, job.id, "processing");
    await sleep(100);
    const res = await web.cancel(job.id);
    expect(res.status).toBe("processing"); // stopping is asynchronous
    const final = await web.waitFor(job.id, 5_000);
    expect(final.status).toBe("cancelled");
    expect(final.progress.fraction).toBeLessThan(1);
  });

  it("still records a job as interrupted when its handler ignores the shutdown abort", async () => {
    const web = await makeQueue();
    const worker = await makeQueue({ worker: ["export"] });
    const job = await enqueue(web, { mode: "hang" });
    await waitForStatus(web, job.id, "processing");
    await worker.close({ graceMs: 50, abortGraceMs: 100 });
    expect(await web.get(job.id)).toMatchObject({ status: "failed", error: { code: "JOB_INTERRUPTED" } });
  });

  it("aborts running handlers on shutdown and records them as interrupted", async () => {
    const web = await makeQueue();
    const worker = await makeQueue({ worker: ["export"] });
    const job = await enqueue(web, { mode: "slow" });
    await waitForStatus(web, job.id, "processing");
    await worker.close({ graceMs: 50 });
    expect(await web.get(job.id)).toMatchObject({ status: "failed", error: { code: "JOB_INTERRUPTED", retryable: true } });
  });

  it("re-runs a job whose worker died without shutting down", async () => {
    const web = await makeQueue();
    let firstAttempt = true;
    const dying = await makeQueue({
      worker: ["export"],
      handle: async (ctx) => {
        if (firstAttempt) {
          firstAttempt = false;
          return new Promise(() => undefined); // never finishes: the process "dies" below
        }
        return handler(ctx);
      },
    });
    const job = await enqueue(web, { mode: "ok", n: 5 });
    await waitForStatus(web, job.id, "processing");
    // Simulate a crash: the worker stops renewing its BullMQ lock without finishing or recording anything.
    for (const w of (dying as unknown as { workers: Array<{ close(force: boolean): Promise<void> }> }).workers) await w.close(true);

    await makeQueue({ worker: ["export"], handle: (ctx) => handler(ctx) });
    const final = await web.waitFor(job.id, 15_000);
    expect(final).toMatchObject({ status: "completed", result: { doubled: 10 } });
    expect(calls[job.id]).toBe(1); // the first attempt never reached the shared handler
  });

  it("fails orphaned jobs that no worker will finish", async () => {
    const web = await makeQueue();
    const job = await enqueue(web, { mode: "ok" }, "segment");
    // A "processing" record whose worker is gone and whose BullMQ job no longer exists.
    const raw = new Redis(redis.url, { maxRetriesPerRequest: null });
    const bull = new Queue("segment", { connection: raw, prefix: `${prefix}:bull` });
    await bull.remove(job.id);
    await bull.close();
    const record = JSON.parse((await raw.get(`${prefix}:job:${job.id}`))!) as Job;
    record.status = "processing";
    record.startedAt = new Date(Date.now() - 60_000).toISOString();
    await raw.set(`${prefix}:job:${job.id}`, JSON.stringify(record));
    await raw.quit();

    await web.reapOrphans();
    expect(await web.get(job.id)).toMatchObject({ status: "failed", error: { code: "JOB_INTERRUPTED" } });
    expect(await web.list({ activeOnly: true })).toEqual([]);
  });

  it("refuses new jobs when too many are active", async () => {
    const web = await makeQueue();
    const raw = new Redis(redis.url);
    await raw.sadd(`${prefix}:active`, ...Array.from({ length: 50 }, (_, i) => `job_fake${String(i).padStart(8, "0")}`));
    await raw.quit();
    await expect(enqueue(web, { mode: "ok" })).rejects.toMatchObject({ code: "INSUFFICIENT_RESOURCES" });
  });

  it("returns null/404 for unknown and malformed job ids", async () => {
    const web = await makeQueue();
    expect(await web.get("job_doesnotexist")).toBeNull();
    expect(await web.get("../../etc")).toBeNull();
    await expect(web.cancel("job_doesnotexist")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
