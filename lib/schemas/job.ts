import { z } from "zod";

export const JOB_STATUSES = ["queued", "processing", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = ["ingest", "segment", "export", "clean_plate"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Allowed state transitions. Anything else is a programming error. */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["processing", "cancelled", "failed"],
  processing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: JobStatus): boolean {
  return JOB_TRANSITIONS[status].length === 0;
}

export const JobProgressSchema = z.object({
  stage: z.string(),
  message: z.string(),
  current: z.number().nonnegative().default(0),
  total: z.number().nonnegative().default(0),
  /** 0..1 overall progress. */
  fraction: z.number().min(0).max(1).default(0),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export interface JobError {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
}

export interface Job<TInput = unknown, TResult = unknown> {
  id: string;
  type: JobType;
  projectId: string;
  label: string;
  status: JobStatus;
  progress: JobProgress;
  input: TInput;
  result?: TResult;
  error?: JobError;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Track this job writes to, if any (lets the UI draw processing state on the timeline). */
  trackId?: string;
  /** Frame range the job covers (for timeline display). */
  frameRange?: { start: number; end: number };
}
