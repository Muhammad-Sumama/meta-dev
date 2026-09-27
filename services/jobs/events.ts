import "server-only";
import { isTerminal, type Job } from "@/lib/schemas/job";
import type { JobQueuePort } from "./types";

/** What clients get: everything but the (potentially large) input payload. */
export type PublicJob = Omit<Job, "input">;

export function publicJob(job: Job): PublicJob {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose
  const { input, ...rest } = job;
  return rest;
}

export interface JobStreamOptions {
  /** Comment line sent this often so proxies don't close an idle stream. */
  heartbeatMs?: number;
  /** Progress updates for one job are coalesced to at most one per this interval; status changes are immediate. */
  coalesceMs?: number;
  /** Recent jobs sent on connect. */
  snapshotSize?: number;
}

/**
 * Server-sent events for one project's jobs:
 *
 *   retry: 3000
 *   event: snapshot   data: {"jobs":[…recent jobs…]}      (on every (re)connect)
 *   event: job        data: {…job…}                      (each change, progress coalesced)
 *   : ping                                               (heartbeat)
 *
 * Works with both queue backends (in-process listeners, or Redis pub/sub
 * from worker processes).
 */
export function jobEventStream(queue: JobQueuePort, projectId: string, signal: AbortSignal, opts: JobStreamOptions = {}): ReadableStream<Uint8Array> {
  const { heartbeatMs = 15_000, coalesceMs = 150, snapshotSize = 30 } = opts;
  const encoder = new TextEncoder();
  const lastSent = new Map<string, { at: number; status: Job["status"] }>();
  const pending = new Map<string, Job>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const write = (text: string) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(text));
    } catch {
      cleanup();
    }
  };
  const sendJob = (job: Job) => {
    lastSent.set(job.id, { at: Date.now(), status: job.status });
    write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
    if (isTerminal(job.status)) lastSent.delete(job.id);
  };
  const push = (job: Job) => {
    const prev = lastSent.get(job.id);
    const now = Date.now();
    if (!prev || prev.status !== job.status || now - prev.at >= coalesceMs) {
      clearTimeout(timers.get(job.id));
      timers.delete(job.id);
      pending.delete(job.id);
      sendJob(job);
      return;
    }
    pending.set(job.id, job);
    if (!timers.has(job.id)) {
      timers.set(
        job.id,
        setTimeout(() => {
          timers.delete(job.id);
          const latest = pending.get(job.id);
          pending.delete(job.id);
          if (latest) sendJob(latest);
        }, coalesceMs - (now - prev.at)),
      );
    }
  };
  function cleanup() {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    signal.removeEventListener("abort", onAbort);
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  }
  const onAbort = () => cleanup();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      if (signal.aborted) return cleanup();
      signal.addEventListener("abort", onAbort);
      // Subscribe before reading the snapshot so nothing falls between them.
      const early: Job[] = [];
      let live = false;
      unsubscribe = queue.subscribe((job) => {
        if (job.projectId !== projectId) return;
        if (live) push(job);
        else early.push(structuredClone(job));
      });
      write("retry: 3000\n\n");
      try {
        const jobs = (await queue.list({ projectId })).slice(0, snapshotSize);
        write(`event: snapshot\ndata: ${JSON.stringify({ jobs: jobs.map(publicJob) })}\n\n`);
      } catch (err) {
        console.error("[events] snapshot failed", err);
        return cleanup(); // the browser reconnects after `retry`
      }
      live = true;
      for (const job of early) push(job);
      heartbeat = setInterval(() => write(": ping\n\n"), heartbeatMs);
    },
    cancel() {
      cleanup();
    },
  });
}
