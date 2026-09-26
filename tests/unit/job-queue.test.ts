import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import type { Job } from "@/lib/schemas/job";
import { InvalidTransitionError, JobQueue, MemoryJobStore } from "@/services/jobs/JobQueue";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function queue(concurrency = 1, store = new MemoryJobStore()) {
  return new JobQueue(store, concurrency, 0);
}

describe("JobQueue", () => {
  it("runs queued → processing → completed with progress", async () => {
    const q = queue();
    const seen: string[] = [];
    q.subscribe((j) => seen.push(`${j.status}:${j.progress.stage}`));
    q.register("export", async ({ progress }) => {
      progress({ stage: "rendering", message: "Processing frame 1 / 2", current: 1, total: 2 });
      await tick();
      progress({ current: 2, total: 2 });
      return { ok: true };
    });
    const job = q.enqueue({ type: "export", projectId: "prj_aaaaaaaaaaaa", label: "t", input: {} });
    expect(job.status).toBe("queued");
    const done = await q.waitFor(job.id);
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({ ok: true });
    expect(done.progress.fraction).toBe(1);
    expect(seen).toContain("processing:rendering");
    expect(seen[0]).toBe("queued:queued");
    expect(done.startedAt && done.finishedAt).toBeTruthy();
  });

  it("marks failures with user-facing errors only", async () => {
    const q = queue();
    q.register("segment", async () => {
      throw new AppError("TARGET_NOT_FOUND", { message: "We couldn't find “unicorn” in this video." });
    });
    q.register("export", async () => {
      throw new Error("TypeError: cannot read property 'x' of undefined at /secret/path.ts:12");
    });
    const a = await q.waitFor(q.enqueue({ type: "segment", projectId: "p", label: "", input: {} }).id);
    expect(a.status).toBe("failed");
    expect(a.error).toMatchObject({ code: "TARGET_NOT_FOUND", message: "We couldn't find “unicorn” in this video." });
    const b = await q.waitFor(q.enqueue({ type: "export", projectId: "p", label: "", input: {} }).id);
    expect(b.error?.code).toBe("INTERNAL");
    expect(b.error?.message).not.toMatch(/secret|TypeError/);
  });

  it("cancels queued and running jobs", async () => {
    const q = queue(1);
    q.register("export", async ({ signal }) => {
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" }))));
    });
    const running = q.enqueue({ type: "export", projectId: "p", label: "", input: {} });
    const queued = q.enqueue({ type: "export", projectId: "p", label: "", input: {} });
    await tick();
    expect((await q.get(running.id))?.status).toBe("processing");
    expect((await q.cancel(queued.id)).status).toBe("cancelled");
    await q.cancel(running.id);
    expect((await q.waitFor(running.id)).status).toBe("cancelled");
    // Terminal jobs can't be revived.
    expect((await q.cancel(running.id)).status).toBe("cancelled");
  });

  it("respects the concurrency limit", async () => {
    const q = queue(2);
    let active = 0;
    let peak = 0;
    q.register("export", async () => {
      active++;
      peak = Math.max(peak, active);
      await tick(20);
      active--;
    });
    const ids = Array.from({ length: 5 }, () => q.enqueue({ type: "export", projectId: "p", label: "", input: {} }).id);
    await Promise.all(ids.map((id) => q.waitFor(id)));
    expect(peak).toBe(2);
  });

  it("fails jobs interrupted by a restart", async () => {
    const store = new MemoryJobStore();
    const stale: Job = {
      id: "job_aaaaaaaaaaaa",
      type: "export",
      projectId: "p",
      label: "",
      status: "processing",
      progress: { stage: "rendering", message: "", current: 0, total: 0, fraction: 0.4 },
      input: {},
      createdAt: new Date().toISOString(),
    };
    await store.save(stale);
    const q = queue(1, store);
    const j = await q.get(stale.id);
    expect(j?.status).toBe("failed");
    expect(j?.error?.message).toMatch(/restarted/);
  });

  it("rejects unknown job types and invalid transitions", () => {
    const q = queue();
    expect(() => q.enqueue({ type: "clean_plate", projectId: "p", label: "", input: {} })).toThrow();
    expect(new InvalidTransitionError("completed", "processing").message).toMatch(/completed → processing/);
  });
});
