import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useJobUpdates } from "@/hooks/useJobUpdates";
import type { Job } from "@/lib/schemas/job";
import { useEditor } from "@/stores/editor";
import { jsonResponse, makeProject } from "./helpers";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  private listeners = new Map<string, Set<(e: Event) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
}

const PID = "prj_aaaaaaaaaaaa";

function job(id: string, status: Job["status"], type: Job["type"] = "ingest"): Job {
  return {
    id,
    type,
    projectId: PID,
    label: "Preparing video",
    status,
    progress: { stage: status, message: status, current: 0, total: 0, fraction: status === "completed" ? 1 : 0.4 },
    input: { projectId: PID },
    createdAt: new Date().toISOString(),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
const projectFetches = () => fetchMock.mock.calls.filter(([url]) => String(url) === `/api/projects/${PID}`).length;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn(async (url: string) => {
    if (url === `/api/projects/${PID}`) return jsonResponse({ project: makeProject({ id: PID }), tracks: [], jobs: [] });
    if (url.startsWith("/api/jobs/")) return jsonResponse({ job: job(url.split("/").pop()!, "completed") });
    return jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function start(jobs: Job[]) {
  useEditor.getState().init(makeProject({ id: PID }), [], jobs);
  const hook = renderHook(() => useJobUpdates(PID));
  const es = FakeEventSource.instances.at(-1)!;
  expect(es.url).toBe(`/api/projects/${PID}/events`);
  return { ...hook, es };
}

describe("useJobUpdates", () => {
  it("applies a job's result once when it finishes while we're watching", async () => {
    const { es } = start([job("job_aaaaaaaaaaaa", "processing")]);
    es.emit("open");
    es.emit("job", { ...job("job_aaaaaaaaaaaa", "processing"), progress: { stage: "work", message: "Frame 3", current: 3, total: 10, fraction: 0.3 } });
    expect(useEditor.getState().jobs.job_aaaaaaaaaaaa.progress.message).toBe("Frame 3");
    es.emit("job", job("job_aaaaaaaaaaaa", "completed"));
    es.emit("job", job("job_aaaaaaaaaaaa", "completed")); // duplicate delivery
    await waitFor(() => expect(projectFetches()).toBe(1));
    expect(useEditor.getState().jobs.job_aaaaaaaaaaaa.status).toBe("completed");
  });

  it("records, but never replays, jobs that finished before we saw them", async () => {
    const { es } = start([]);
    es.emit("open");
    es.emit("snapshot", { jobs: [job("job_oldoldoldold", "completed", "segment")] });
    expect(useEditor.getState().jobs.job_oldoldoldold.status).toBe("completed");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies results of jobs that finished while the stream was disconnected", async () => {
    const { es } = start([job("job_bbbbbbbbbbbb", "processing")]);
    es.emit("open");
    es.emit("snapshot", { jobs: [job("job_bbbbbbbbbbbb", "completed")] });
    await waitFor(() => expect(projectFetches()).toBe(1));
  });

  it("falls back to polling when the stream can't connect", async () => {
    const { es } = start([job("job_cccccccccccc", "processing")]);
    es.emit("error");
    es.emit("error");
    expect(es.closed).toBe(false);
    es.emit("error");
    expect(es.closed).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job_cccccccccccc", expect.anything()));
    await waitFor(() => expect(projectFetches()).toBe(1));
    expect(useEditor.getState().jobs.job_cccccccccccc.status).toBe("completed");
  });

  it("closes the stream when the editor unmounts", () => {
    const { es, unmount } = start([]);
    unmount();
    expect(es.closed).toBe(true);
  });
});

describe("editor store job updates", () => {
  it("never moves a job backwards when updates arrive out of order", () => {
    useEditor.getState().init(makeProject({ id: PID }), [], []);
    const s = useEditor.getState();
    s.upsertJob(job("job_dddddddddddd", "completed"));
    s.upsertJob(job("job_dddddddddddd", "queued")); // late HTTP response
    expect(useEditor.getState().jobs.job_dddddddddddd.status).toBe("completed");
    s.upsertJob(job("job_eeeeeeeeeeee", "processing"));
    const { input: _omitted, ...withoutInput } = job("job_eeeeeeeeeeee", "processing"); // live events omit input
    void _omitted;
    s.upsertJob({ ...withoutInput, progress: { ...withoutInput.progress, fraction: 0.9 } } as Job);
    expect(useEditor.getState().jobs.job_eeeeeeeeeeee).toMatchObject({ input: { projectId: PID }, progress: { fraction: 0.9 } });
  });
});
