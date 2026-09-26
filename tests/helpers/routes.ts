/**
 * Helpers for integration tests that call Next.js route handlers directly
 * (no HTTP server) and inspect media with the bundled FFmpeg binaries.
 */
import { spawnSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { expect } from "vitest";
import * as jobRoute from "@/app/api/jobs/[jobId]/route";
import * as projectsRoute from "@/app/api/projects/route";
import { getJobQueue } from "@/services/jobs/runtime";

export type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
type Json = any;

const BASE = "http://localhost";

export async function call(
  handler: Handler,
  opts: { url?: string; method?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string> } = {},
): Promise<{ res: Response; json: Json }> {
  const init: RequestInit & { duplex?: string } = { method: opts.method ?? "GET", headers: opts.headers };
  if (opts.body instanceof ReadableStream) {
    init.body = opts.body;
    init.duplex = "half";
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json", ...opts.headers };
  }
  const res = await handler(new Request(`${BASE}${opts.url ?? "/"}`, init), { params: Promise.resolve(opts.params ?? {}) });
  const type = res.headers.get("content-type") ?? "";
  const json = type.includes("application/json") ? await res.clone().json() : null;
  return { res, json };
}

export function fileStream(file: string, start = 0, end?: number) {
  return Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
}

/** Streams a file to `POST /api/projects` the way the browser uploader does. */
export async function upload(file: string, name: string, end?: number) {
  const size = end !== undefined ? end + 1 : statSync(file).size;
  return call(projectsRoute.POST as Handler, {
    method: "POST",
    url: "/api/projects",
    body: fileStream(file, 0, end),
    headers: { "x-file-name": encodeURIComponent(name), "content-length": String(size) },
  });
}

/** Waits for a background job and checks the jobs API reports the same outcome. */
export async function waitJob(id: string) {
  const job = await getJobQueue().waitFor(id, 180_000);
  const { json } = await call(jobRoute.GET as Handler, { url: `/api/jobs/${id}`, params: { jobId: id } });
  expect(json.job.status).toBe(job.status);
  return json.job;
}

const req = createRequire(path.join(process.cwd(), "package.json"));

export function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH || (req("ffmpeg-static") as string);
}

export function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH || (req("@ffprobe-installer/ffprobe") as { path: string }).path;
}

/** Runs FFmpeg synchronously (test fixtures only) and fails loudly with its stderr. */
export function ffmpeg(args: string[]) {
  const out = spawnSync(ffmpegBinary(), ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${out.stderr}`);
}

type ProbeStream = Record<string, string | number | Record<string, string> | Array<Record<string, unknown>>>;

export function ffprobeJson(file: string) {
  const out = spawnSync(ffprobeBinary(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-count_packets", file], { encoding: "utf8" });
  return JSON.parse(out.stdout) as { streams: ProbeStream[]; format: Record<string, string> };
}
