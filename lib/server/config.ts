import "server-only";
import path from "node:path";
import { z } from "zod";

/**
 * Server configuration from environment variables. Secrets (API keys) live
 * here only and are never serialized to the client; `publicConfig()` exposes
 * the safe subset used by the Settings panel.
 */

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const EnvSchema = z.object({
  DATA_DIR: z.string().default("./data"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(20_000).default(500),
  MAX_VIDEO_DURATION_SECONDS: z.coerce.number().positive().max(24 * 3600).default(600),
  MAX_VIDEO_DIMENSION: z.coerce.number().int().positive().max(8192).default(4096),
  ANALYSIS_MAX_SIZE: z.coerce.number().int().min(128).max(2048).default(512),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(1024),

  LLM_PROVIDER: z.enum(["mock", "llama"]).default("mock"),
  LLAMA_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLAMA_API_KEY: z.string().optional(),
  LLAMA_MODEL: z.string().default("llama3.1:8b"),
  LLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(20_000),
  LLAMA_FALLBACK_TO_RULES: bool.default(true),

  SEGMENTATION_PROVIDER: z.enum(["mock", "sam2"]).default("mock"),
  SAM2_SERVICE_URL: z.string().url().default("http://localhost:8008"),
  SAM2_API_KEY: z.string().optional(),
  SAM2_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),
  SAM2_SHARED_STORAGE: bool.default(false),

  FFMPEG_PATH: z.string().optional(),
  FFPROBE_PATH: z.string().optional(),
});

export type ServerConfig = z.infer<typeof EnvSchema> & { dataDir: string };

let cached: ServerConfig | null = null;

export function getConfig(): ServerConfig {
  if (cached) return cached;
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const v = process.env[key];
    if (v !== undefined && v !== "") raw[key] = v;
  }
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = { ...parsed.data, dataDir: path.resolve(parsed.data.DATA_DIR) };
  return cached;
}

/** For tests: override config values. */
export function setConfigForTesting(overrides: Partial<ServerConfig> | null): void {
  if (overrides === null) {
    cached = null;
    return;
  }
  cached = { ...getConfig(), ...overrides };
  if (overrides.DATA_DIR) cached.dataDir = path.resolve(overrides.DATA_DIR);
}

export interface PublicConfig {
  maxUploadMb: number;
  maxDurationSeconds: number;
  analysisMaxSize: number;
  llmProvider: "mock" | "llama";
  llamaModel: string | null;
  segmentationProvider: "mock" | "sam2";
}

export function publicConfig(): PublicConfig {
  const c = getConfig();
  return {
    maxUploadMb: c.MAX_UPLOAD_MB,
    maxDurationSeconds: c.MAX_VIDEO_DURATION_SECONDS,
    analysisMaxSize: c.ANALYSIS_MAX_SIZE,
    llmProvider: c.LLM_PROVIDER,
    llamaModel: c.LLM_PROVIDER === "llama" ? c.LLAMA_MODEL : null,
    segmentationProvider: c.SEGMENTATION_PROVIDER,
  };
}
