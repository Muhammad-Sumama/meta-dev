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

  /** memory = handlers run inside the web server; redis = BullMQ + `npm run worker` processes. */
  JOB_BACKEND: z.enum(["memory", "redis"]).default("memory"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must start with redis:// or rediss://").default("redis://localhost:6379"),
  /** Namespace for Redis keys and queues (lets several deployments share one Redis). */
  JOB_QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default("opensam"),
  /** Redis backend: also run a worker inside the web process (single-container deployments). */
  RUN_WORKERS_IN_WEB: bool.default(false),
  /** Job types a worker process takes, e.g. "segment" on GPU machines and "ingest,export" on CPU ones. */
  WORKER_JOB_TYPES: z
    .string()
    .regex(/^(ingest|segment|export)(,(ingest|segment|export))*$/, "comma-separated list of ingest, segment, export")
    .default("ingest,segment,export"),
  /** How long finished jobs stay queryable (Redis backend). */
  JOB_RETENTION_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(168),

  /** Where project and track metadata live: JSON files in DATA_DIR, or PostgreSQL. */
  PROJECT_STORE: z.enum(["file", "postgres"]).default("file"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must start with postgres:// or postgresql://").optional(),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  /** Where media and exports live: DATA_DIR only, or an S3-compatible bucket (DATA_DIR becomes a cache). */
  MEDIA_STORE: z.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "not a valid bucket name").optional(),
  S3_REGION: z.string().default("us-east-1"),
  /** For S3-compatible services (MinIO, R2, …); omit for AWS. */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Optional; without them the AWS default credential chain is used. */
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Key prefix inside the bucket, e.g. "opensam/prod". */
  S3_PREFIX: z.string().regex(/^[A-Za-z0-9/_.-]{0,200}$/).default(""),
  /** MEDIA_STORE=s3: local cache of downloaded media per machine. */
  MEDIA_CACHE_MAX_MB: z.coerce.number().int().min(256).default(20_480),

  LLM_PROVIDER: z.enum(["mock", "llama"]).default("mock"),
  LLAMA_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  LLAMA_API_KEY: z.string().optional(),
  LLAMA_MODEL: z.string().default("llama3.1:8b"),
  LLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(20_000),
  LLAMA_FALLBACK_TO_RULES: bool.default(true),

  SEGMENTATION_PROVIDER: z.enum(["mock", "sam2"]).default("mock"),
  /** One inference server, or a comma-separated pool (videos stick to one server, with failover). */
  SAM2_SERVICE_URL: z
    .string()
    .refine((v) => v.split(",").every((u) => URL.canParse(u.trim()) && /^https?:\/\//.test(u.trim())), "comma-separated http(s) URLs")
    .default("http://localhost:8008"),
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
  if (parsed.data.PROJECT_STORE === "postgres" && !parsed.data.DATABASE_URL) {
    throw new Error("Invalid environment configuration: DATABASE_URL is required when PROJECT_STORE=postgres");
  }
  if (parsed.data.MEDIA_STORE === "s3" && !parsed.data.S3_BUCKET) {
    throw new Error("Invalid environment configuration: S3_BUCKET is required when MEDIA_STORE=s3");
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
