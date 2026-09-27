import "server-only";
import os from "node:os";
import { Queue, Worker, type Job as BullJob } from "bullmq";
import { Redis } from "ioredis";
import { AppError, ERROR_CATALOG, toAppError, type ErrorCode } from "@/lib/errors";
import { isTerminal, JOB_TRANSITIONS, type Job, type JobStatus, type JobType } from "@/lib/schemas/job";
import { ID_PATTERNS } from "@/lib/schemas/project";
import { newId } from "@/lib/utils/ids";
import { InvalidTransitionError } from "../JobQueue";
import {
  MAX_ACTIVE_JOBS,
  type EnqueueOptions,
  type JobContext,
  type JobHandler,
  type JobQueuePort,
  type QueueStats,
} from "../types";

/**
 * Distributed job queue on Redis.
 *
 *   web:     enqueue ──► job record (Redis) + BullMQ job ──► publish event
 *   worker:  BullMQ picks job ──► handler(ctx) ──► progress/result into the record ──► publish
 *   web:     subscribe(events) → SSE / waitFor;   cancel → flag + publish ──► worker aborts
 *
 * BullMQ does dispatch, per-process concurrency and stalled-job recovery.
 * The job record — the `Job` the API returns — is a JSON string updated with
 * compare-and-set, so a web process cancelling a queued job and a worker
 * starting it can't both win. Running workers refresh a heartbeat key; a
 * janitor fails jobs whose worker vanished and that BullMQ won't re-run.
 *
 * Keys (P = JOB_QUEUE_PREFIX):
 *   P:job:<id>                job record JSON (expires after completion)
 *   P:project:<projectId>:jobs  ZSET of job ids by creation time
 *   P:active                  SET of queued/processing job ids
 *   P:cancel:<id>, P:hb:<id>  cancellation request, worker heartbeat
 *   P:events, P:cancels       pub/sub channels
 *   P:bull:<type>:…           BullMQ queues (one per job type)
 */

const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur ~= ARGV[1] then return 0 end
if ARGV[3] == '' then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 1`;

export const QUEUED_JOB_TYPES: readonly JobType[] = ["ingest", "segment", "export"];

const CANCEL = "cancel";
const SHUTDOWN = "shutdown";

export interface RedisQueueTimings {
  /** How often a running job's heartbeat is refreshed, and how long it lives. */
  heartbeatMs: number;
  heartbeatTtlMs: number;
  /** BullMQ lock: a crashed worker's job is re-queued after this long. */
  lockDurationMs: number;
  stalledIntervalMs: number;
  /** How often workers look for orphaned jobs. */
  janitorMs: number;
  /** Progress writes per job are coalesced to at most one per this interval. */
  progressFlushMs: number;
}

const DEFAULT_TIMINGS: RedisQueueTimings = {
  heartbeatMs: 5_000,
  heartbeatTtlMs: 20_000,
  lockDurationMs: 60_000,
  stalledIntervalMs: 30_000,
  janitorMs: 30_000,
  progressFlushMs: 250,
};

export interface RedisJobQueueOptions {
  url: string;
  prefix: string;
  /** Jobs each worker started by this instance runs at once (per job type). */
  concurrency: number;
  retentionSeconds: number;
  timings?: Partial<RedisQueueTimings>;
}

type Listener = (job: Job) => void;

function transition(job: Job, to: JobStatus) {
  if (!JOB_TRANSITIONS[job.status].includes(to)) throw new InvalidTransitionError(job.status, to);
  job.status = to;
  if (to === "processing") job.startedAt = new Date().toISOString();
  if (isTerminal(to)) job.finishedAt = new Date().toISOString();
}

function errorFields(code: ErrorCode, message?: string, hint?: string) {
  const entry = ERROR_CATALOG[code];
  return { code, message: message ?? entry.message, hint: hint ?? entry.hint, retryable: entry.retryable };
}

export class RedisJobQueue implements JobQueuePort {
  readonly backend = "redis" as const;
  readonly workerName = `${os.hostname()}:${process.pid}`;
  private readonly timings: RedisQueueTimings;
  private readonly redis: Redis;
  private readonly bullConnection: Redis;
  private sub: Redis | null = null;
  private subReady: Promise<void> | null = null;
  private readonly queues = new Map<JobType, Queue>();
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly listeners = new Set<Listener>();
  private readonly workers: Worker[] = [];
  private readonly running = new Map<string, AbortController>();
  /** Handler runs in this process (settle when the job record is final). */
  private readonly inFlight = new Set<Promise<void>>();
  private readonly connections: Redis[] = [];
  private janitor: ReturnType<typeof setInterval> | null = null;
  private closing: Promise<void> | null = null;

  constructor(private readonly opts: RedisJobQueueOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.redis = this.connect("commands", { maxRetriesPerRequest: 3 });
    this.bullConnection = this.connect("queues", { maxRetriesPerRequest: null });
  }

  // --- keys ------------------------------------------------------------------
  private readonly key = {
    job: (id: string) => `${this.opts.prefix}:job:${id}`,
    project: (projectId: string) => `${this.opts.prefix}:project:${projectId}:jobs`,
    active: () => `${this.opts.prefix}:active`,
    cancel: (id: string) => `${this.opts.prefix}:cancel:${id}`,
    heartbeat: (id: string) => `${this.opts.prefix}:hb:${id}`,
    events: () => `${this.opts.prefix}:events`,
    cancels: () => `${this.opts.prefix}:cancels`,
  };

  private get bullPrefix() {
    return `${this.opts.prefix}:bull`;
  }

  private connect(role: string, extra: { maxRetriesPerRequest: number | null }) {
    const conn = new Redis(this.opts.url, { ...extra, connectionName: `opensam-${role}-${process.pid}` });
    this.connections.push(conn);
    let lastLog = 0;
    conn.on("error", (err: Error) => {
      // ioredis reconnects on its own; avoid flooding the log while Redis is down.
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        console.error(`[jobs] redis (${role}): ${err.message}`);
      }
    });
    return conn;
  }

  private queue(type: JobType): Queue {
    let q = this.queues.get(type);
    if (!q) {
      q = new Queue(type, { connection: this.bullConnection, prefix: this.bullPrefix });
      q.on("error", (err: Error) => console.error(`[jobs] queue ${type}: ${err.message}`));
      this.queues.set(type, q);
    }
    return q;
  }

  // --- job records -------------------------------------------------------------
  async get(jobId: string): Promise<Job | null> {
    if (!ID_PATTERNS.job.test(jobId)) return null;
    const raw = await this.redis.get(this.key.job(jobId));
    return raw ? (JSON.parse(raw) as Job) : null;
  }

  /**
   * Compare-and-set read-modify-write of a job record. `mutate` returns the
   * new record, or null for "no change". Terminal states get an expiry and
   * leave the active set; every change is published.
   */
  private async update(jobId: string, mutate: (job: Job) => Job | null): Promise<Job | null> {
    const key = this.key.job(jobId);
    for (let attempt = 0; attempt < 50; attempt++) {
      const raw = await this.redis.get(key);
      if (raw === null) return null;
      const next = mutate(JSON.parse(raw) as Job);
      if (!next) return JSON.parse(raw) as Job;
      const terminal = isTerminal(next.status);
      const ok = await this.redis.eval(CAS_SCRIPT, 1, key, raw, JSON.stringify(next), terminal ? String(this.opts.retentionSeconds) : "");
      if (ok === 1) {
        if (terminal) await this.redis.srem(this.key.active(), jobId);
        await this.publish(next);
        return next;
      }
    }
    throw new Error(`Job ${jobId} could not be updated (too much contention)`);
  }

  private async publish(job: Job) {
    await this.redis.publish(this.key.events(), JSON.stringify(job));
  }

  async enqueue<TInput>(opts: EnqueueOptions<TInput>): Promise<Job<TInput>> {
    if (!QUEUED_JOB_TYPES.includes(opts.type)) throw new Error(`Job type "${opts.type}" can't be queued`);
    if ((await this.redis.scard(this.key.active())) >= MAX_ACTIVE_JOBS) {
      throw new AppError("INSUFFICIENT_RESOURCES", {
        message: "Too many jobs are running right now.",
        hint: "Wait for some to finish, then try again.",
      });
    }
    const job: Job<TInput> = {
      id: newId("job"),
      type: opts.type,
      projectId: opts.projectId,
      label: opts.label,
      status: "queued",
      progress: { stage: "queued", message: "Waiting for a worker…", current: 0, total: 0, fraction: 0 },
      input: opts.input,
      createdAt: new Date().toISOString(),
      trackId: opts.trackId,
      frameRange: opts.frameRange,
    };
    const projectKey = this.key.project(job.projectId);
    await this.redis
      .multi()
      .set(this.key.job(job.id), JSON.stringify(job))
      .zadd(projectKey, Date.parse(job.createdAt), job.id)
      .expire(projectKey, this.opts.retentionSeconds * 2)
      .sadd(this.key.active(), job.id)
      .exec();
    try {
      await this.queue(opts.type).add(opts.type, { jobId: job.id }, { jobId: job.id, attempts: 1, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } });
    } catch (err) {
      console.error(`[jobs] couldn't queue ${job.id}`, err);
      await this.update(job.id, (j) => {
        transition(j, "failed");
        j.error = errorFields("INTERNAL", "We couldn't queue this job.");
        return j;
      });
      throw new AppError("INTERNAL", { message: "We couldn't queue this job.", cause: err });
    }
    await this.publish(job as Job);
    return structuredClone(job);
  }

  async list(filter: { projectId?: string; activeOnly?: boolean } = {}): Promise<Job[]> {
    let ids: string[];
    if (filter.projectId) ids = await this.redis.zrevrange(this.key.project(filter.projectId), 0, 199);
    else ids = await this.redis.smembers(this.key.active());
    if (!ids.length) return [];
    const raws = await this.redis.mget(ids.map((id) => this.key.job(id)));
    const jobs: Job[] = [];
    const expired: string[] = [];
    raws.forEach((raw, i) => (raw ? jobs.push(JSON.parse(raw) as Job) : expired.push(ids[i])));
    if (expired.length && filter.projectId) await this.redis.zrem(this.key.project(filter.projectId), ...expired);
    return jobs
      .filter((j) => (!filter.projectId || j.projectId === filter.projectId) && (!filter.activeOnly || !isTerminal(j.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async cancel(jobId: string): Promise<Job> {
    const current = await this.get(jobId);
    if (!current) throw new AppError("NOT_FOUND", { message: "That job doesn't exist." });
    if (isTerminal(current.status)) return current;
    const after = await this.update(jobId, (j) => {
      if (j.status !== "queued") return null;
      transition(j, "cancelled");
      j.progress = { ...j.progress, stage: "cancelled", message: "Cancelled" };
      return j;
    });
    if (after?.status === "cancelled") {
      await this.queue(after.type)
        .remove(jobId)
        .catch(() => undefined);
      return after;
    }
    // Running somewhere: flag it (read when a worker starts it) and tell workers now.
    await this.redis.multi().set(this.key.cancel(jobId), "1", "EX", 24 * 3600).publish(this.key.cancels(), jobId).exec();
    return (await this.get(jobId)) ?? current;
  }

  // --- events ------------------------------------------------------------------
  private ensureSubscriber(): Promise<void> {
    if (!this.subReady) {
      const sub = this.connect("events", { maxRetriesPerRequest: null });
      this.sub = sub;
      sub.on("message", (channel: string, message: string) => {
        if (channel === this.key.cancels()) {
          this.running.get(message)?.abort(CANCEL);
          return;
        }
        let job: Job;
        try {
          job = JSON.parse(message) as Job;
        } catch {
          return;
        }
        for (const l of this.listeners) {
          try {
            l(job);
          } catch (err) {
            console.error("[jobs] listener error", err);
          }
        }
      });
      this.subReady = sub.subscribe(this.key.events(), this.key.cancels()).then(() => undefined);
    }
    return this.subReady;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.ensureSubscriber().catch((err) => console.error("[jobs] subscribe failed", err));
    return () => {
      this.listeners.delete(listener);
    };
  }

  waitFor(jobId: string, timeoutMs = 120_000): Promise<Job> {
    return new Promise<Job>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        fn();
      };
      const unsubscribe = this.subscribe((j) => {
        if (j.id === jobId && isTerminal(j.status)) done(() => resolve(j));
      });
      const timer = setTimeout(() => done(() => reject(new Error(`Timed out waiting for job ${jobId}`))), timeoutMs);
      // Subscribe first, then read, so a transition between the two can't be missed.
      this.ensureSubscriber()
        .then(() => this.get(jobId))
        .then((j) => {
          if (!j) done(() => reject(new AppError("NOT_FOUND", { message: "That job doesn't exist." })));
          else if (isTerminal(j.status)) done(() => resolve(j));
        })
        .catch((err) => done(() => reject(err)));
    });
  }

  async stats(): Promise<QueueStats> {
    let queued = 0;
    let running = 0;
    const workers: Partial<Record<JobType, number>> = {};
    for (const type of QUEUED_JOB_TYPES) {
      const q = this.queue(type);
      const counts = await q.getJobCounts("waiting", "active", "delayed", "prioritized");
      queued += (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
      running += counts.active ?? 0;
      workers[type] = await q.getWorkersCount().catch(() => 0);
    }
    return { backend: "redis", queued, running, concurrency: this.opts.concurrency, workers };
  }

  // --- worker side ---------------------------------------------------------------
  register<TInput, TResult>(type: JobType, handler: JobHandler<TInput, TResult>) {
    this.handlers.set(type, handler as JobHandler);
  }

  /** Starts consuming the given job types in this process. */
  async startWorkers(types: readonly JobType[]) {
    await this.ensureSubscriber(); // cancellation messages
    for (const type of types) {
      if (!this.handlers.has(type)) throw new Error(`No handler registered for job type "${type}"`);
      const processor = (bj: BullJob<{ jobId: string }>) => {
        const run = this.process(type, bj.data.jobId);
        this.inFlight.add(run);
        const forget = () => void this.inFlight.delete(run);
        run.then(forget, forget);
        return run;
      };
      const worker = new Worker(type, processor, {
        connection: this.connect(`worker-${type}`, { maxRetriesPerRequest: null }),
        prefix: this.bullPrefix,
        concurrency: this.opts.concurrency,
        lockDuration: this.timings.lockDurationMs,
        stalledInterval: this.timings.stalledIntervalMs,
        maxStalledCount: 1,
        name: this.workerName,
      });
      worker.on("error", (err: Error) => console.error(`[jobs] worker ${type}: ${err.message}`));
      this.workers.push(worker);
    }
    this.janitor = setInterval(() => void this.reapOrphans().catch((err) => console.error("[jobs] janitor", err)), this.timings.janitorMs);
    this.janitor.unref?.();
  }

  private async process(type: JobType, jobId: string) {
    const handler = this.handlers.get(type)!;
    const started = await this.update(jobId, (j) => {
      if (j.status === "queued") transition(j, "processing");
      // Still "processing": the worker that had it died and BullMQ re-queued it.
      else if (j.status === "processing") j.startedAt = new Date().toISOString();
      else return null;
      j.progress = { stage: "starting", message: "Starting…", current: 0, total: 0, fraction: 0 };
      return j;
    });
    if (!started || started.status !== "processing") return; // cancelled, finished or expired meanwhile

    const controller = new AbortController();
    this.running.set(jobId, controller);
    const heartbeatKey = this.key.heartbeat(jobId);
    const beat = () => this.redis.set(heartbeatKey, this.workerName, "PX", this.timings.heartbeatTtlMs).catch(() => undefined);
    await beat();
    const heartbeat = setInterval(beat, this.timings.heartbeatMs);
    if (await this.redis.exists(this.key.cancel(jobId))) controller.abort(CANCEL);

    // Progress: the handler sees every update immediately; Redis gets them coalesced.
    const local = structuredClone(started);
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let lastFlush = 0;
    let writes: Promise<unknown> = Promise.resolve();
    const flush = () => {
      flushTimer = null;
      lastFlush = Date.now();
      const progress = { ...local.progress };
      writes = writes
        .then(() => this.update(jobId, (j) => (j.status === "processing" ? { ...j, progress } : null)))
        .catch((err) => console.error(`[jobs] progress ${jobId}`, err));
    };
    const settleWrites = async () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      await writes;
    };

    const ctx: JobContext = {
      job: local,
      signal: controller.signal,
      progress: (update) => {
        if (controller.signal.aborted) return;
        const stageChanged = update.stage !== undefined && update.stage !== local.progress.stage;
        local.progress = { ...local.progress, ...update };
        if (update.total && update.current !== undefined && update.fraction === undefined) {
          local.progress.fraction = Math.min(1, update.current / update.total);
        }
        const wait = this.timings.progressFlushMs - (Date.now() - lastFlush);
        if (stageChanged || wait <= 0) {
          if (flushTimer) clearTimeout(flushTimer);
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, wait);
        }
      },
    };

    try {
      const result = await handler(ctx);
      if (controller.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      await settleWrites();
      await this.update(jobId, (j) => {
        if (j.status !== "processing") return null;
        transition(j, "completed");
        j.result = result;
        j.progress = { ...local.progress, stage: "done", message: "Done", fraction: 1 };
        return j;
      });
    } catch (err) {
      await settleWrites();
      const reason = controller.signal.reason;
      const appErr = toAppError(err);
      await this.update(jobId, (j) => {
        if (j.status !== "processing") return null;
        if (reason === SHUTDOWN) {
          transition(j, "failed");
          j.error = errorFields("JOB_INTERRUPTED");
          j.progress = { ...local.progress, stage: "failed", message: j.error.message };
        } else if (reason === CANCEL || appErr.code === "JOB_CANCELLED") {
          transition(j, "cancelled");
          j.progress = { ...local.progress, stage: "cancelled", message: "Cancelled" };
        } else {
          if (!(err instanceof AppError)) console.error(`[jobs] ${j.type} ${jobId} failed:`, err);
          else if (appErr.cause) console.error(`[jobs] ${j.type} ${jobId}: ${appErr.code}`, appErr.cause);
          transition(j, "failed");
          j.error = { code: appErr.code, message: appErr.message, hint: appErr.hint, retryable: appErr.retryable };
          j.progress = { ...local.progress, stage: "failed", message: appErr.message };
        }
        return j;
      });
    } finally {
      clearInterval(heartbeat);
      this.running.delete(jobId);
      await this.redis.del(heartbeatKey, this.key.cancel(jobId)).catch(() => undefined);
    }
  }

  /**
   * Fails jobs no worker will finish: "processing" with no heartbeat that
   * BullMQ no longer holds or will re-run (e.g. it exceeded the stall limit),
   * and "queued" records whose BullMQ job is gone.
   */
  async reapOrphans() {
    const graceMs = this.timings.heartbeatTtlMs * 2;
    for (const id of await this.redis.smembers(this.key.active())) {
      const job = await this.get(id);
      if (!job) {
        await this.redis.srem(this.key.active(), id);
        continue;
      }
      if (isTerminal(job.status)) continue;
      if (job.status === "processing" && (await this.redis.exists(this.key.heartbeat(id)))) continue;
      const since = Date.parse(job.status === "processing" ? (job.startedAt ?? job.createdAt) : job.createdAt);
      if (Date.now() - since < graceMs) continue;
      const bull = await this.queue(job.type).getJob(id);
      const state = bull ? await bull.getState() : "missing";
      if (["active", "waiting", "delayed", "prioritized", "waiting-children"].includes(state)) continue;
      await this.update(id, (j) => {
        if (isTerminal(j.status)) return null;
        transition(j, "failed");
        j.error = errorFields("JOB_INTERRUPTED");
        j.progress = { ...j.progress, stage: "failed", message: j.error.message };
        return j;
      });
    }
  }

  /**
   * Stops taking jobs, lets running ones finish for up to `graceMs`, then
   * aborts the rest (recorded as interrupted, so users can re-run them). A
   * handler that ignores the abort gets `abortGraceMs` before its job is
   * recorded as interrupted anyway and the workers are force-closed.
   */
  close({ graceMs = 25_000, abortGraceMs = 5_000 }: { graceMs?: number; abortGraceMs?: number } = {}): Promise<void> {
    this.closing ??= (async () => {
      if (this.janitor) clearInterval(this.janitor);
      // Stop fetching jobs without waiting (BullMQ's graceful close can't be escalated to a forced one later).
      await Promise.all(this.workers.map((w) => w.pause(true).catch(() => undefined)));
      const drained = (ms: number) =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          void Promise.allSettled([...this.inFlight]).then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      let force = false;
      if (!(await drained(graceMs))) {
        for (const c of this.running.values()) c.abort(SHUTDOWN);
        if (!(await drained(abortGraceMs))) {
          // Handlers ignoring the abort: record their jobs as interrupted and don't wait for them.
          force = true;
          await Promise.all(
            [...this.running.keys()].map((id) =>
              this.update(id, (j) => {
                if (j.status !== "processing") return null;
                transition(j, "failed");
                j.error = errorFields("JOB_INTERRUPTED");
                j.progress = { ...j.progress, stage: "failed", message: j.error.message };
                return j;
              }).catch(() => undefined),
            ),
          );
        }
      }
      await Promise.all(this.workers.map((w) => w.close(force).catch(() => undefined)));
      await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
      await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
    })();
    return this.closing;
  }
}
