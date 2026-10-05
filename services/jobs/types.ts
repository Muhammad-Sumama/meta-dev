import type { Job, JobProgress, JobType } from "@/lib/schemas/job";

/**
 * The job system's public surface. Two implementations:
 *
 *   - `JobQueue` (services/jobs/JobQueue.ts): in-process, bounded concurrency,
 *     JSON files. Zero setup; the default.
 *   - `RedisJobQueue` (services/jobs/redis/RedisJobQueue.ts): BullMQ on Redis.
 *     The web server only enqueues; `npm run worker` processes (on CPU or GPU
 *     machines) run handlers. Progress, cancellation and results cross
 *     processes through Redis.
 *
 * Handlers are written against `JobContext` only, so the same code runs in
 * either.
 */

export interface JobContext<TInput = unknown> {
  job: Readonly<Job<TInput>>;
  signal: AbortSignal;
  progress(update: Partial<JobProgress>): void;
}

export type JobHandler<TInput = unknown, TResult = unknown> = (ctx: JobContext<TInput>) => Promise<TResult>;

export interface EnqueueOptions<TInput> {
  type: JobType;
  projectId: string;
  label: string;
  input: TInput;
  trackId?: string;
  frameRange?: { start: number; end: number };
}

export interface QueueStats {
  backend: "memory" | "redis";
  running: number;
  queued: number;
  /** Jobs each process runs at once. */
  concurrency: number;
  /** Connected worker processes per job type (Redis backend only). */
  workers?: Partial<Record<JobType, number>>;
}

/** Anything that accepts job handlers (both queues; a worker process registers into one). */
export interface HandlerRegistry {
  register<TInput, TResult>(type: JobType, handler: JobHandler<TInput, TResult>): void;
}

export interface JobQueuePort extends HandlerRegistry {
  readonly backend: "memory" | "redis";
  enqueue<TInput>(opts: EnqueueOptions<TInput>): Promise<Job<TInput>>;
  get(jobId: string): Promise<Job | null>;
  list(filter?: { projectId?: string; activeOnly?: boolean }): Promise<Job[]>;
  /** Cancels a queued job immediately, or asks the process running it to stop. */
  cancel(jobId: string): Promise<Job>;
  /** Resolves when the job reaches a terminal state. */
  waitFor(jobId: string, timeoutMs?: number): Promise<Job>;
  /** Every state/progress change of every job (progress is throttled). */
  subscribe(listener: (job: Job) => void): () => void;
  stats(): Promise<QueueStats>;
}

export interface JobStore {
  save(job: Job): Promise<void>;
  load(jobId: string): Promise<Job | null>;
  loadAll(): Promise<Job[]>;
}

/** Jobs allowed to be queued or running at once, across all projects. */
export const MAX_ACTIVE_JOBS = 50;
