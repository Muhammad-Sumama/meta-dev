/** Live job updates over server-sent events, with the in-process queue. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setConfigForTesting } from "@/lib/server/config";
import * as commandsRoute from "@/app/api/projects/[projectId]/commands/route";
import * as eventsRoute from "@/app/api/projects/[projectId]/events/route";
import * as demoRoute from "@/app/api/projects/demo/route";
import { getJobQueue, resetJobQueueForTesting } from "@/services/jobs/runtime";
import { type Handler, call, waitJob } from "../helpers/routes";
import { readSse } from "../helpers/sse";

let dataDir: string;
let projectId: string;

// Kept referenced: undici only propagates the caller's abort to a Request's signal while the Request is alive.
const requests: Request[] = [];

function openEvents(pid: string, signal: AbortSignal) {
  const request = new Request(`http://localhost/api/projects/${pid}/events`, { signal });
  requests.push(request);
  return (eventsRoute.GET as Handler)(request, { params: Promise.resolve({ projectId: pid }) });
}

const listenerCount = () => (getJobQueue() as unknown as { listeners: Set<unknown> }).listeners.size;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "opensam-events-"));
  setConfigForTesting({ DATA_DIR: dataDir, MIN_FREE_DISK_MB: 0, JOB_BACKEND: "memory" });
  await resetJobQueueForTesting();
  const { json } = await call(demoRoute.POST as Handler, { method: "POST" });
  projectId = json.project.id;
  await waitJob(json.job.id);
});

afterAll(async () => {
  await resetJobQueueForTesting();
  setConfigForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/projects/:id/events", () => {
  it("sends a snapshot, then live job updates with progress coalesced and inputs left out", async () => {
    const before = listenerCount();
    const ac = new AbortController();
    const res = await openEvents(projectId, ac.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const sse = readSse(res);

    const snapshot = await sse.until((e) => e.event === "snapshot");
    expect(snapshot.data.jobs.map((j: { type: string; status: string }) => [j.type, j.status])).toContainEqual(["ingest", "completed"]);
    expect(listenerCount()).toBe(before + 1);

    const { json } = await call(commandsRoute.POST as Handler, { method: "POST", body: { text: "Track the red car", frameIndex: 0 }, params: { projectId } });
    const jobId = json.job.id;
    await sse.until((e) => e.event === "job" && e.data.id === jobId && e.data.status === "completed");

    const updates = sse.events.filter((e) => e.event === "job" && e.data.id === jobId).map((e) => e.data);
    expect(updates.map((u) => u.status)).toEqual(expect.arrayContaining(["processing", "completed"]));
    expect(updates.at(-1).result.trackId).toMatch(/^trk_/);
    // Tracking reports progress for every frame (~300); the stream coalesces it.
    expect(updates.length).toBeGreaterThan(3);
    expect(updates.length).toBeLessThan(80);
    const fractions = updates.map((u) => u.progress.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    for (const u of updates) expect(u).not.toHaveProperty("input");

    ac.abort();
    expect(await sse.waitForEnd()).toBe(true);
    expect(listenerCount()).toBe(before);
  });

  it("stops listening when the client disconnects", async () => {
    const before = listenerCount();
    const res = await openEvents(projectId, new AbortController().signal);
    const sse = readSse(res);
    await sse.until((e) => e.event === "snapshot");
    expect(listenerCount()).toBe(before + 1);
    await sse.cancel(); // what the server does when the browser goes away
    expect(listenerCount()).toBe(before);
  });

  it("returns 404 for unknown projects", async () => {
    const res = await openEvents("prj_doesnotexist", new AbortController().signal);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
