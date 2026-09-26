import "server-only";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { getConfig } from "@/lib/server/config";

/**
 * Safe FFmpeg/ffprobe invocation.
 *
 * - Binaries resolve from FFMPEG_PATH/FFPROBE_PATH, then the bundled
 *   `ffmpeg-static` / `@ffprobe-installer/ffprobe` packages, then $PATH.
 * - Processes are always spawned with an argument array (`shell: false`), so
 *   file names and user values can never be interpreted as shell syntax.
 * - Every call is abortable and has a timeout.
 */

export interface Binaries {
  ffmpeg: string;
  ffprobe: string;
  source: { ffmpeg: string; ffprobe: string };
}

let cachedBinaries: Binaries | null = null;

function which(name: string): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function requireFromProject(id: string): unknown {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    return req(id);
  } catch {
    return null;
  }
}

function resolveOne(kind: "ffmpeg" | "ffprobe"): { path: string; source: string } | null {
  const cfg = getConfig();
  const envPath = kind === "ffmpeg" ? cfg.FFMPEG_PATH : cfg.FFPROBE_PATH;
  if (envPath && existsSync(envPath)) return { path: envPath, source: "env" };

  const pkgName = kind === "ffmpeg" ? "ffmpeg-static" : "@ffprobe-installer/ffprobe";
  const mod = requireFromProject(pkgName) as string | { path?: string } | null;
  const bundled = typeof mod === "string" ? mod : mod?.path;
  if (bundled && existsSync(bundled)) return { path: bundled, source: "bundled" };

  const system = which(kind);
  if (system) return { path: system, source: "system" };
  return null;
}

export function resolveBinaries(): Binaries {
  if (cachedBinaries) return cachedBinaries;
  const ffmpeg = resolveOne("ffmpeg");
  const ffprobe = resolveOne("ffprobe");
  if (!ffmpeg || !ffprobe) {
    throw new AppError("FFMPEG_UNAVAILABLE", {
      details: { missing: [!ffmpeg && "ffmpeg", !ffprobe && "ffprobe"].filter(Boolean) },
    });
  }
  cachedBinaries = {
    ffmpeg: ffmpeg.path,
    ffprobe: ffprobe.path,
    source: { ffmpeg: ffmpeg.source, ffprobe: ffprobe.source },
  };
  return cachedBinaries;
}

export function isFFmpegAvailable(): boolean {
  try {
    resolveBinaries();
    return true;
  } catch {
    return false;
  }
}

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

export interface RunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with each `key=value` block from `-progress pipe:1`. */
  onProgress?: (fields: Record<string, string>) => void;
  /** Collect stdout (default true). Disable for large outputs. */
  collectStdout?: boolean;
  maxStderrBytes?: number;
}

function assertArgs(args: readonly string[]) {
  for (const a of args) {
    if (typeof a !== "string") throw new TypeError("FFmpeg arguments must be strings");
    if (a.includes("\0")) throw new TypeError("FFmpeg arguments must not contain NUL bytes");
  }
}

function abortError(): Error {
  const e = new Error("Operation cancelled");
  e.name = "AbortError";
  return e;
}

/** Kill a child process and wait briefly for exit. */
export function killProcess(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.killed) return;
  proc.kill("SIGKILL");
}

export function runBinary(
  bin: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  assertArgs(args);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const proc = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    const maxErr = opts.maxStderrBytes ?? 64 * 1024;
    let progressBuf = "";
    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
    };

    const onAbort = () => {
      killProcess(proc);
      finish(abortError());
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      killProcess(proc);
      finish(new AppError("INSUFFICIENT_RESOURCES", { message: "Video processing took too long and was stopped." }));
    }, opts.timeoutMs ?? 30 * 60_000);

    proc.stdout!.on("data", (chunk: Buffer) => {
      if (opts.onProgress) {
        progressBuf += chunk.toString("utf8");
        let idx: number;
        while ((idx = progressBuf.indexOf("progress=")) !== -1) {
          const end = progressBuf.indexOf("\n", idx);
          if (end === -1) break;
          const block = progressBuf.slice(0, end + 1);
          progressBuf = progressBuf.slice(end + 1);
          const fields: Record<string, string> = {};
          for (const line of block.split("\n")) {
            const eq = line.indexOf("=");
            if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
          opts.onProgress(fields);
        }
      } else if (opts.collectStdout !== false) {
        stdoutChunks.push(chunk);
      }
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < maxErr) stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => finish(err));
    proc.on("close", (code) => {
      if (code === 0) finish(null);
      else finish(new ProcessError(`${path.basename(bin)} exited with code ${code}`, code, stderr.slice(-4000)));
    });
  });
}

export function runFFmpeg(args: readonly string[], opts?: RunOptions) {
  const { ffmpeg } = resolveBinaries();
  return runBinary(ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args], opts);
}

export function runFFprobe(args: readonly string[], opts?: RunOptions) {
  const { ffprobe } = resolveBinaries();
  return runBinary(ffprobe, ["-hide_banner", ...args], opts);
}

/** Spawn FFmpeg with piped stdio for streaming raw frames in/out. */
export function spawnFFmpeg(args: readonly string[], stdio: { stdin: boolean; stdout: boolean }) {
  assertArgs(args);
  const { ffmpeg } = resolveBinaries();
  // `-nostdin` disables keyboard interaction; omit it when stdin carries frame data.
  const base = stdio.stdin ? ["-hide_banner", "-loglevel", "error", "-y"] : ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  return spawn(ffmpeg, [...base, ...args], {
    shell: false,
    stdio: [stdio.stdin ? "pipe" : "ignore", stdio.stdout ? "pipe" : "ignore", "pipe"],
    windowsHide: true,
  });
}

export interface FFmpegCapabilities {
  available: boolean;
  version: string | null;
  encoders: {
    h264: boolean;
    vp9: boolean;
    prores: boolean;
    png: boolean;
    aac: boolean;
    opus: boolean;
  };
  source?: Binaries["source"];
}

let capsPromise: Promise<FFmpegCapabilities> | null = null;

export function getFFmpegCapabilities(): Promise<FFmpegCapabilities> {
  if (!capsPromise) {
    capsPromise = (async () => {
      const none: FFmpegCapabilities = {
        available: false,
        version: null,
        encoders: { h264: false, vp9: false, prores: false, png: false, aac: false, opus: false },
      };
      let bins: Binaries;
      try {
        bins = resolveBinaries();
      } catch {
        return none;
      }
      try {
        const [ver, enc] = await Promise.all([
          runBinary(bins.ffmpeg, ["-hide_banner", "-version"], { timeoutMs: 15_000 }),
          runBinary(bins.ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 }),
        ]);
        const version = /ffmpeg version (\S+)/.exec(ver.stdout.toString())?.[1] ?? "unknown";
        const list = enc.stdout.toString();
        const has = (name: string) => new RegExp(`\\s${name}\\s`).test(list);
        return {
          available: true,
          version,
          encoders: {
            h264: has("libx264"),
            vp9: has("libvpx-vp9"),
            prores: has("prores_ks"),
            png: has("png"),
            aac: has("aac"),
            opus: has("libopus"),
          },
          source: bins.source,
        };
      } catch {
        capsPromise = null;
        return none;
      }
    })();
  }
  return capsPromise;
}

/** Maps low-level process failures to user-facing errors. */
export function mapFFmpegError(err: unknown, fallback: "CORRUPTED_VIDEO" | "EXPORT_FAILED" | "UPLOAD_FAILED"): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error && err.name === "AbortError") return new AppError("JOB_CANCELLED", { cause: err });
  if (err instanceof ProcessError) {
    if (/No space left on device/i.test(err.stderr)) return new AppError("INSUFFICIENT_RESOURCES", { cause: err });
    if (/Cannot allocate memory|Out of memory/i.test(err.stderr)) return new AppError("INSUFFICIENT_RESOURCES", { cause: err });
    if (/Unknown encoder|Encoder not found/i.test(err.stderr)) return new AppError("FORMAT_UNAVAILABLE", { cause: err });
  }
  if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") {
    return new AppError("FFMPEG_UNAVAILABLE", { cause: err });
  }
  return new AppError(fallback, { cause: err });
}
