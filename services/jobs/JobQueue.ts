import { AppError, ERROR_CATALOG, toAppError } from "@/lib/errors";
import { newId } from "@/lib/utils/ids";
import {
  isTerminal,
  JOB_TRANSITIONS,
  type Job,
  type JobStatus,
  type JobType,
} from "@/lib/schemas/job";
import {
  MAX_ACTIVE_JOBS,
  type EnqueueOptions,
  type JobContext,
  type JobHandler,
  type JobQueuePort,
  type JobStore,
  type QueueStats,
} from "./types";

/**
 * In-process job queue (the default backend).
 *
 *   API route → enqueue() → [queued] → worker handler → [processing] → [completed|failed|cancelled]
 *
 * Handlers run in the Next.js server process with bounded concurrency; job
 * state is persisted through a `JobStore` (JSON files). For multi-process or
 * multi-machine deployments use `RedisJobQueue` (JOB_BACKEND=redis), which
 * implements the same `JobQueuePort`.
 */

export type { EnqueueOptions, JobContext, JobHandler, JobStore } from "./types";

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  async save(job: Job) {
    this.jobs.set(job.id, structuredClone(job));
  }
  async load(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }
  async loadAll() {
    return [...this.jobs.values()].map((j) => structuredClone(j));
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid job transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

type Listener = (job: Job) => void;

export class JobQueue implements JobQueuePort {
  readonly backend = "memory" as const;
  private handlers = new Map<JobType, JobHandler>();
  private jobs = new Map<string, Job>();
  private waiting: string[] = [];
  private running = new Map<string, AbortController>();
  private listeners = new Set<Listener>();
  private lastPersist = new Map<string, number>();
  private recovered: Promise<void>;

  constructor(
    private readonly store: JobStore,
    private readonly concurrency = 2,
    private readonly persistIntervalMs = 750,
  ) {
    this.recovered = this.recoverInterrupted();
  }

  register<TInput, TResult>(type: JobType, handler: JobHandler<TInput, TResult>) {
    this.handlers.set(type, handler as JobHandler);
  }

  hasHandler(type: JobType) {
    return this.handlers.has(type);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Jobs left queued/processing by a previous server process can never finish. */
  private async recoverInterrupted() {
    try {
      const all = await this.store.loadAll();
      for (const job of all) {
        if (!isTerminal(job.status)) {
          job.status = "failed";
          job.finishedAt = new Date().toISOString();
          const { message, hint, retryable } = ERROR_CATALOG.JOB_INTERRUPTED;
          job.error = { code: "JOB_INTERRUPTED", message, hint, retryable };
          await this.store.save(job);
        }
      }
    } catch (err) {
      console.error("[jobs] recovery failed", err);
    }
  }

  async enqueue<TInput>(opts: EnqueueOptions<TInput>): Promise<Job<TInput>> {
    return this.enqueueSync(opts);
  }

  /** Synchronous enqueue (in-process only). */
  enqueueSync<TInput>(opts: EnqueueOptions<TInput>): Job<TInput> {
    if (!this.handlers.has(opts.type)) throw new Error(`No handler registered for job type "${opts.type}"`);
    const active = [...this.jobs.values()].filter((j) => !isTerminal(j.status)).length;
    if (active >= MAX_ACTIVE_JOBS) {
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
      progress: { stage: "queued", message: "Waiting to start…", current: 0, total: 0, fraction: 0 },
      input: opts.input,
      createdAt: new Date().toISOString(),
      trackId: opts.trackId,
      frameRange: opts.frameRange,
    };
    this.jobs.set(job.id, job as Job);
    this.waiting.push(job.id);
    this.persist(job as Job, true);
    this.emit(job as Job);
    queueMicrotask(() => this.pump());
    return structuredClone(job);
  }

  async get(jobId: string): Promise<Job | null> {
    const mem = this.jobs.get(jobId);
    if (mem) return structuredClone(mem);
    await this.recovered;
    return this.store.load(jobId);
  }

  async list(filter: { projectId?: string; activeOnly?: boolean } = {}): Promise<Job[]> {
    await this.recovered;
    const byId = new Map<string, Job>();
    for (const j of await this.store.loadAll()) byId.set(j.id, j);
    for (const j of this.jobs.values()) byId.set(j.id, structuredClone(j));
    return [...byId.values()]
      .filter((j) => (!filter.projectId || j.projectId === filter.projectId) && (!filter.activeOnly || !isTerminal(j.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async cancel(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const stored = await this.store.load(jobId);
      if (!stored) throw new AppError("NOT_FOUND", { message: "That job doesn't exist." });
      return stored;
    }
    if (isTerminal(job.status)) return structuredClone(job);
    if (job.status === "queued") {
      this.waiting = this.waiting.filter((id) => id !== jobId);
      this.transition(job, "cancelled");
      job.progress = { ...job.progress, stage: "cancelled", message: "Cancelled" };
      this.persist(job, true);
      this.emit(job);
    } else {
      this.running.get(jobId)?.abort();
    }
    return structuredClone(job);
  }

  /** Resolves when the job reaches a terminal state (used by tests and scripts). */
  waitFor(jobId: string, timeoutMs = 120_000): Promise<Job> {
    return new Promise((resolve, reject) => {
      const check = (j: Job) => {
        if (j.id === jobId && isTerminal(j.status)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(structuredClone(j));
        }
      };
      const unsubscribe = this.subscribe(check);
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for job ${jobId}`));
      }, timeoutMs);
      const current = this.jobs.get(jobId);
      if (current) check(current);
    });
  }

  private transition(job: Job, to: JobStatus) {
    if (!JOB_TRANSITIONS[job.status].includes(to)) throw new InvalidTransitionError(job.status, to);
    job.status = to;
    if (to === "processing") job.startedAt = new Date().toISOString();
    if (isTerminal(to)) job.finishedAt = new Date().toISOString();
  }

  private pump() {
    while (this.running.size < this.concurrency && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      void this.execute(job);
    }
  }

  private async execute(job: Job) {
    const handler = this.handlers.get(job.type)!;
    const controller = new AbortController();
    this.running.set(job.id, controller);
    this.transition(job, "processing");
    job.progress = { stage: "starting", message: "Starting…", current: 0, total: 0, fraction: 0 };
    this.persist(job, true);
    this.emit(job);

    const ctx: JobContext = {
      job,
      signal: controller.signal,
      progress: (update) => {
        if (job.status !== "processing") return;
        const stageChanged = update.stage !== undefined && update.stage !== job.progress.stage;
        job.progress = { ...job.progress, ...update };
        if (update.total && update.current !== undefined && update.fraction === undefined) {
          job.progress.fraction = Math.min(1, update.current / update.total);
        }
        this.persist(job, stageChanged);
        this.emit(job);
      },
    };

    try {
      const result = await handler(ctx);
      if (controller.signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      job.result = result;
      this.transition(job, "completed");
      job.progress = { ...job.progress, stage: "done", message: "Done", fraction: 1 };
    } catch (err) {
      const appErr = toAppError(err);
      if (controller.signal.aborted || appErr.code === "JOB_CANCELLED") {
        this.transition(job, "cancelled");
        job.progress = { ...job.progress, stage: "cancelled", message: "Cancelled" };
      } else {
        if (!(err instanceof AppError)) console.error(`[jobs] ${job.type} ${job.id} failed:`, err);
        else if (appErr.cause) console.error(`[jobs] ${job.type} ${job.id}: ${appErr.code}`, appErr.cause);
        this.transition(job, "failed");
        job.error = { code: appErr.code, message: appErr.message, hint: appErr.hint, retryable: appErr.retryable };
        job.progress = { ...job.progress, stage: "failed", message: appErr.message };
      }
    } finally {
      this.running.delete(job.id);
      this.persist(job, true);
      this.emit(job);
      this.evictOld();
      this.pump();
    }
  }

  private persist(job: Job, force: boolean) {
    const now = Date.now();
    const last = this.lastPersist.get(job.id) ?? 0;
    if (!force && now - last < this.persistIntervalMs) return;
    this.lastPersist.set(job.id, now);
    this.store.save(structuredClone(job)).catch((err) => console.error("[jobs] persist failed", err));
  }

  private emit(job: Job) {
    for (const l of this.listeners) {
      try {
        l(job);
      } catch (err) {
        console.error("[jobs] listener error", err);
      }
    }
  }

  private evictOld() {
    if (this.jobs.size <= 200) return;
    const terminal = [...this.jobs.values()]
      .filter((j) => isTerminal(j.status))
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    for (const j of terminal.slice(0, this.jobs.size - 200)) {
      this.jobs.delete(j.id);
      this.lastPersist.delete(j.id);
    }
  }

  async stats(): Promise<QueueStats> {
    return { backend: "memory", running: this.running.size, queued: this.waiting.length, concurrency: this.concurrency };
  }
}
