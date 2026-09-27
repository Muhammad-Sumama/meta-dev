/**
 * JOB_BACKEND=redis end to end: this test process plays the web server
 * (route handlers only enqueue), and a real `workers/main.ts` process — the
 * same entry point as `npm run worker` — runs ingest, tracking and export.
 * Covers cross-process results, cancellation and graceful shutdown.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setConfigForTesting } from "@/lib/server/config";
import * as healthRoute from "@/app/api/health/route";
import * as jobRoute from "@/app/api/jobs/[jobId]/route";
import * as commandsRoute from "@/app/api/projects/[projectId]/commands/route";
import * as exportRoute from "@/app/api/projects/[projectId]/exports/[exportId]/route";
import * as exportsRoute from "@/app/api/projects/[projectId]/exports/route";
import * as projectRoute from "@/app/api/projects/[projectId]/route";
import * as trackItemRoute from "@/app/api/projects/[projectId]/tracks/[trackId]/route";
import { resetJobQueueForTesting, getJobQueue } from "@/services/jobs/runtime";
import { DEMO_VIDEO } from "../helpers/evalDemo";
import { redisAvailable, startRedis } from "../helpers/redis";
import { type Handler, call, upload, waitJob } from "../helpers/routes";

describe.skipIf(!redisAvailable)("separate worker process (JOB_BACKEND=redis)", () => {
  let redis: { url: string; stop(): Promise<void> };
  let dataDir: string;
  let worker: ChildProcess;
  let workerLog = "";
  let projectId: string;
  let carTrackId: string;
  const prefix = `it${randomBytes(3).toString("hex")}`;

  function startWorker() {
    const proc = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "--conditions=react-server", "workers/main.ts"], {
      env: {
        ...process.env,
        JOB_BACKEND: "redis",
        REDIS_URL: redis.url,
        JOB_QUEUE_PREFIX: prefix,
        DATA_DIR: dataDir,
        MIN_FREE_DISK_MB: "0",
        JOB_CONCURRENCY: "2",
        WORKER_SHUTDOWN_GRACE_MS: "300",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ready = new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        workerLog += chunk.toString();
        if (workerLog.includes(" ready · ")) resolve();
      };
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", onData);
      proc.on("exit", (code) => reject(new Error(`worker exited (${code}) before it was ready:\n${workerLog}`)));
    });
    return { proc, ready };
  }

  const exportBody = (settings: Record<string, unknown>, subject?: string) => ({
    settings,
    ...(subject ? { composite: { effect: "remove_background", subjectTrackIds: [subject] } } : {}),
  });

  beforeAll(async () => {
    redis = await startRedis();
    dataDir = mkdtempSync(path.join(os.tmpdir(), "opensam-worker-"));
    setConfigForTesting({ DATA_DIR: dataDir, MIN_FREE_DISK_MB: 0, JOB_BACKEND: "redis", REDIS_URL: redis.url, JOB_QUEUE_PREFIX: prefix, RUN_WORKERS_IN_WEB: false });
    await resetJobQueueForTesting();
    const w = startWorker();
    worker = w.proc;
    await w.ready;
  }, 60_000);

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      worker.kill("SIGKILL");
      await once(worker, "exit");
    }
    await resetJobQueueForTesting();
    setConfigForTesting(null);
    await redis?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports the Redis queue and its workers in health", async () => {
    const { json } = await call(healthRoute.GET as Handler);
    expect(json.queue).toMatchObject({ backend: "redis", workers: { ingest: 1, segment: 1, export: 1 } });
    expect(json.ok).toBe(true);
  });

  it("ingests an upload in the worker process", async () => {
    expect(getJobQueue().backend).toBe("redis");
    const { res, json } = await upload(DEMO_VIDEO, "street.mp4");
    expect(res.status).toBe(201);
    projectId = json.project.id;
    expect(json.job.progress.message).toBe("Waiting for a worker…");
    expect((await waitJob(json.job.id)).status).toBe("completed");
    const { json: bundle } = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(bundle.project.media).toMatchObject({ poster: true, filmstrip: { status: "ready" } });
    expect(bundle.jobs.map((j: { id: string }) => j.id)).toContain(json.job.id);
  });

  it("runs an AI command in the worker and the web side sees the track", async () => {
    const { json } = await call(commandsRoute.POST as Handler, { method: "POST", body: { text: "Track the red car", frameIndex: 0 }, params: { projectId } });
    const job = await waitJob(json.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    carTrackId = job.result.trackId;
    const { json: t } = await call(trackItemRoute.GET as Handler, { params: { projectId, trackId: carTrackId } });
    expect(Object.keys(t.track.frames).length).toBeGreaterThan(250);
    const { json: bundle } = await call(projectRoute.GET as Handler, { params: { projectId } });
    expect(bundle.project.commands.at(-1)).toMatchObject({ status: "completed", trackId: carTrackId });
  });

  it("exports in the worker and downloads from the web side", async () => {
    const { json } = await call(exportsRoute.POST as Handler, {
      method: "POST",
      params: { projectId },
      body: exportBody({ kind: "png_sequence", format: "png_zip", resolution: "360", fps: "source", quality: "low", range: { start: 0, end: 4 } }, carTrackId),
    });
    const job = await waitJob(json.job.id);
    expect(job.status, JSON.stringify(job.error)).toBe("completed");
    const dl = await call(exportRoute.GET as Handler, { params: { projectId, exportId: json.exportId } });
    expect(dl.res.status).toBe(200);
    expect(Buffer.from(await dl.res.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
  });

  const longExport = () =>
    call(exportsRoute.POST as Handler, {
      method: "POST",
      params: { projectId },
      body: exportBody({ kind: "video", format: "webm_vp9_alpha", resolution: "source", fps: "source", quality: "high" }, carTrackId),
    });

  async function untilProcessing(jobId: string) {
    for (let i = 0; i < 200; i++) {
      const { json } = await call(jobRoute.GET as Handler, { params: { jobId } });
      if (json.job.status === "processing" && json.job.progress.fraction > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("export never started");
  }

  it("cancels a job running in the worker process", async () => {
    const { json } = await longExport();
    await untilProcessing(json.job.id);
    const cancel = await call(jobRoute.DELETE as Handler, { method: "DELETE", params: { jobId: json.job.id } });
    expect(cancel.res.status).toBe(200);
    expect((await waitJob(json.job.id)).status).toBe("cancelled");
  });

  it("records running jobs as interrupted when the worker is stopped, then a new worker picks up", async () => {
    const { json } = await longExport();
    await untilProcessing(json.job.id);
    worker.kill("SIGTERM");
    const [code] = await once(worker, "exit");
    expect(code).toBe(0);
    expect(workerLog).toContain("[worker] stopped");
    const job = await waitJob(json.job.id);
    expect(job).toMatchObject({ status: "failed", error: { code: "JOB_INTERRUPTED", retryable: true } });

    // Queued while no worker runs, then processed once one starts.
    const { json: queued } = await call(exportsRoute.POST as Handler, {
      method: "POST",
      params: { projectId },
      body: exportBody({ kind: "mask", format: "mask_png_zip", resolution: "360", fps: "source", quality: "low", range: { start: 0, end: 2 } }, carTrackId),
    });
    const { json: health } = await call(healthRoute.GET as Handler);
    expect(health.queue.workers.export).toBe(0);
    const next = startWorker();
    worker = next.proc;
    await next.ready;
    expect((await waitJob(queued.job.id)).status).toBe("completed");
  });
});
