"use client";

import type { SerializedError } from "@/lib/errors";
import type { CommandRequest, ExportRequest, SegmentRequest, TrackRequest } from "@/lib/schemas/api";
import type { EditingPlan, ParsedCommand } from "@/lib/schemas/command";
import type { Job } from "@/lib/schemas/job";
import type { CommandRecord, Composite, ExportSettings, Project, ProjectListItem, Track, TrackSummary } from "@/lib/schemas/project";

/** Browser-side API client. All errors surface as ApiError with a user-facing message. */
export class ApiError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly status: number;
  constructor(err: SerializedError & { status?: number }) {
    super(err.message);
    this.name = "ApiError";
    this.code = err.code;
    this.hint = err.hint;
    this.retryable = err.retryable;
    this.status = err.status ?? 0;
  }
}

const NETWORK_ERROR = {
  code: "NETWORK",
  message: "We couldn't reach the OpenSAM server.",
  hint: "Check that `npm run dev` is still running, then try again.",
  retryable: true,
} as const;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError({ ...NETWORK_ERROR, code: "NETWORK" as SerializedError["code"] });
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const err = (body as { error?: SerializedError } | null)?.error;
    throw new ApiError({
      code: err?.code ?? "INTERNAL",
      message: err?.message ?? "Something went wrong on our side.",
      hint: err?.hint,
      retryable: err?.retryable ?? true,
      status: res.status,
    });
  }
  return body as T;
}

const jsonBody = (v: unknown) => JSON.stringify(v);

export interface HealthInfo {
  ok: boolean;
  storage: { backend: "file" | "postgres"; ok: boolean; message: string };
  media: { backend: "local" | "s3"; ok: boolean; message: string };
  ffmpeg: { available: boolean; version: string | null; encoders: Record<string, boolean>; source: { ffmpeg: string; ffprobe: string } | null };
  formats: Record<string, boolean>;
  ai: {
    language: { id: string; name: string; kind: "mock" | "production"; model?: string; description: string; health: { status: string; message: string } };
    segmentation: { id: string; name: string; kind: "mock" | "production"; description: string; health: { status: string; message: string } };
  };
  config: { maxUploadMb: number; maxDurationSeconds: number; analysisMaxSize: number; llmProvider: string; llamaModel: string | null; segmentationProvider: string };
  queue:
    | { backend: "memory" | "redis"; running: number; queued: number; concurrency: number; workers?: Record<string, number> }
    | { backend: "memory" | "redis"; error: string };
}

export interface ProjectBundle {
  project: Project;
  tracks: TrackSummary[];
  jobs: Job[];
}

export interface SegmentResponse {
  frameIndex: number;
  width: number;
  height: number;
  counts: number[];
  score: number;
  provider: string;
  providerKind: "mock" | "production";
}

export interface CommandResponse {
  record: CommandRecord;
  parsed: ParsedCommand;
  plan: EditingPlan;
  job: Job | null;
}

export const api = {
  health: () => request<HealthInfo>("/api/health"),
  listProjects: () => request<{ projects: ProjectListItem[] }>("/api/projects"),
  createDemo: () => request<{ project: Project; job: Job }>("/api/projects/demo", { method: "POST" }),
  getProject: (id: string) => request<ProjectBundle>(`/api/projects/${id}`),
  patchProject: (id: string, patch: { name?: string; composite?: Composite; exportSettings?: ExportSettings }) =>
    request<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: jsonBody(patch) }),
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),

  getTrack: (pid: string, tid: string) => request<{ track: Track }>(`/api/projects/${pid}/tracks/${tid}`),
  saveTrack: (pid: string, track: Track) => request<{ track: Track }>(`/api/projects/${pid}/tracks/${track.id}`, { method: "PUT", body: jsonBody(track) }),
  deleteTrack: (pid: string, tid: string) => request<{ ok: true }>(`/api/projects/${pid}/tracks/${tid}`, { method: "DELETE" }),

  segment: (pid: string, req: SegmentRequest, signal?: AbortSignal) =>
    request<SegmentResponse>(`/api/projects/${pid}/segment`, { method: "POST", body: jsonBody(req), signal }),
  track: (pid: string, req: TrackRequest) => request<{ job: Job }>(`/api/projects/${pid}/track`, { method: "POST", body: jsonBody(req) }),
  command: (pid: string, req: CommandRequest) => request<CommandResponse>(`/api/projects/${pid}/commands`, { method: "POST", body: jsonBody(req) }),
  parse: (text: string) => request<ParsedCommand>("/api/ai/parse", { method: "POST", body: jsonBody({ text }) }),

  requestPreviewProxy: (pid: string) => request<{ project: Project; job: Job | null }>(`/api/projects/${pid}/preview-proxy`, { method: "POST" }),

  startExport: (pid: string, req: ExportRequest) =>
    request<{ job: Job; exportId: string }>(`/api/projects/${pid}/exports`, { method: "POST", body: jsonBody(req) }),
  getJob: (id: string) => request<{ job: Job }>(`/api/jobs/${id}`),
  cancelJob: (id: string) => request<{ job: Job }>(`/api/jobs/${id}`, { method: "DELETE" }),
  listJobs: (pid: string, activeOnly = false) => request<{ jobs: Job[] }>(`/api/projects/${pid}/jobs${activeOnly ? "?active=1" : ""}`),

  mediaUrl: (pid: string, asset: "preview" | "source" | "poster" | "filmstrip") => `/api/projects/${pid}/media/${asset}`,
  eventsUrl: (pid: string) => `/api/projects/${pid}/events`,
  exportUrl: (pid: string, exportId: string) => `/api/projects/${pid}/exports/${exportId}`,
};

/**
 * Streams a file to the server with upload progress (fetch can't report
 * upload progress, so this uses XMLHttpRequest).
 */
export function uploadVideo(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ project: Project; job: Job }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/projects");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { project?: Project; job?: Job; error?: SerializedError } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.project && body.job) resolve({ project: body.project, job: body.job });
      else
        reject(
          new ApiError({
            code: body?.error?.code ?? "UPLOAD_FAILED",
            message: body?.error?.message ?? "The upload didn't finish.",
            hint: body?.error?.hint,
            retryable: body?.error?.retryable ?? true,
            status: xhr.status,
          }),
        );
    };
    xhr.onerror = () => reject(new ApiError({ ...NETWORK_ERROR, code: "NETWORK" as SerializedError["code"] }));
    xhr.onabort = () => reject(Object.assign(new Error("Upload cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export function errorText(err: unknown): { title: string; hint?: string } {
  if (err instanceof ApiError) return { title: err.message, hint: err.hint };
  return { title: "Something went wrong.", hint: "Try again." };
}
