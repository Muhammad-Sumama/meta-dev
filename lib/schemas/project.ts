import { z } from "zod";
import { EFFECT_TYPES, EditCommandSchema, COMMAND_SOURCES } from "./command";

export const ID_PATTERNS = {
  project: /^prj_[a-z0-9]{12}$/,
  track: /^trk_[a-z0-9]{12}$/,
  job: /^job_[a-z0-9]{12}$/,
  export: /^exp_[a-z0-9]{12}$/,
  command: /^cmd_[a-z0-9]{12}$/,
} as const;

export const ProjectIdSchema = z.string().regex(ID_PATTERNS.project, "Invalid project id");
export const TrackIdSchema = z.string().regex(ID_PATTERNS.track, "Invalid track id");
export const JobIdSchema = z.string().regex(ID_PATTERNS.job, "Invalid job id");
export const ExportIdSchema = z.string().regex(ID_PATTERNS.export, "Invalid export id");

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------
export const VideoMetadataSchema = z.object({
  originalName: z.string().max(255),
  fileName: z.string().max(64),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().max(64),
  container: z.string().max(64),
  codec: z.string().max(64),
  pixelFormat: z.string().max(64).optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  fps: z.number().positive(),
  frameCount: z.number().int().positive(),
  duration: z.number().positive(),
  hasAudio: z.boolean(),
  audioCodec: z.string().max(64).optional(),
  bitRate: z.number().nonnegative().optional(),
  browserPlayable: z.boolean(),
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const MediaStateSchema = z.object({
  proxy: z.object({
    status: z.enum(["not_needed", "pending", "ready", "failed"]),
    fileName: z.string().optional(),
  }),
  /**
   * VP9/WebM preview for browsers without an H.264 decoder (e.g. some Linux
   * Chromium builds). Created on demand when the editor detects it's needed.
   */
  vp9Proxy: z
    .object({ status: z.enum(["none", "pending", "ready", "failed"]), fileName: z.string().optional() })
    .default({ status: "none" }),
  poster: z.boolean(),
  filmstrip: z.object({
    status: z.enum(["pending", "ready", "failed"]),
    count: z.number().int().nonnegative(),
    tileWidth: z.number().int().nonnegative(),
    tileHeight: z.number().int().nonnegative(),
  }),
});
export type MediaState = z.infer<typeof MediaStateSchema>;

// ---------------------------------------------------------------------------
// Composite (how the selected objects are rendered in preview and export)
// ---------------------------------------------------------------------------
export const CompositeSchema = z.object({
  effect: z.enum(EFFECT_TYPES).default("none"),
  /** Tracks treated as the subject. Empty = all visible tracks. */
  subjectTrackIds: z.array(z.string()).max(32).default([]),
  backgroundColor: hexColor.default("#00b140"),
  /** 0..1 */
  blurStrength: z.number().min(0).max(1).default(0.5),
  /** 0..1, background dimming for highlight */
  dim: z.number().min(0).max(1).default(0.65),
  /** Edge softness in source-resolution pixels. */
  feather: z.number().min(0).max(40).default(2),
  /** Grow (+) / shrink (−) the mask edge, source pixels. */
  expand: z.number().min(-20).max(20).default(0),
  /** Snap mask edges to the image (guided filter; see lib/compositing/refine.ts). */
  refineEdges: z.boolean().default(true),
});
export type Composite = z.infer<typeof CompositeSchema>;

export const DEFAULT_COMPOSITE: Composite = CompositeSchema.parse({});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export const EXPORT_KINDS = ["video", "mask", "png_sequence", "project"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_FORMATS = [
  "mp4_h264",
  "webm_vp9",
  "webm_vp9_alpha",
  "mov_prores4444",
  "png_zip",
  "mask_mp4",
  "mask_png_zip",
  "project_json",
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_RESOLUTIONS = ["source", "2160", "1440", "1080", "720", "480", "360"] as const;
export const EXPORT_FPS = ["source", "24", "25", "30", "50", "60"] as const;

export const ExportSettingsSchema = z.object({
  kind: z.enum(EXPORT_KINDS),
  format: z.enum(EXPORT_FORMATS),
  resolution: z.enum(EXPORT_RESOLUTIONS).default("source"),
  fps: z.enum(EXPORT_FPS).default("source"),
  quality: z.enum(["high", "medium", "low"]).default("high"),
  includeAudio: z.boolean().default(true),
  /** Inclusive frame range; omitted = whole video. */
  range: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((r) => r.end >= r.start, { message: "range.end must be ≥ range.start" })
    .optional(),
});
export type ExportSettings = z.infer<typeof ExportSettingsSchema>;

// ---------------------------------------------------------------------------
// Prompts (what the segmentation backend receives)
// ---------------------------------------------------------------------------
/** Normalized coordinates (0..1) so prompts are resolution independent. */
export const PointPromptSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** 1 = positive (part of the object), 0 = negative (not the object). */
  label: z.union([z.literal(0), z.literal(1)]),
});
export type PointPrompt = z.infer<typeof PointPromptSchema>;

export const BoxPromptSchema = z
  .object({
    x0: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
  })
  .refine((b) => b.x1 > b.x0 && b.y1 > b.y0, { message: "Box must have positive size" });
export type BoxPrompt = z.infer<typeof BoxPromptSchema>;

export const FramePromptSchema = z.object({
  frameIndex: z.number().int().min(0),
  points: z.array(PointPromptSchema).max(64).default([]),
  box: BoxPromptSchema.optional(),
  /** Free-text description (used for grounding when no points/box). */
  text: z.string().max(200).optional(),
});
export type FramePrompt = z.infer<typeof FramePromptSchema>;

// ---------------------------------------------------------------------------
// Tracks (a segmented object across frames)
// ---------------------------------------------------------------------------
const RLESchema = z.array(z.number().int().nonnegative()).max(200_000);

export const TrackSchema = z.object({
  id: TrackIdSchema,
  name: z.string().trim().min(1).max(80),
  color: hexColor,
  visible: z.boolean().default(true),
  source: z.enum(["ai", "manual"]),
  provider: z.string().max(32).default("manual"),
  category: z.string().max(32).optional(),
  command: z.string().max(500).optional(),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  prompts: z.array(FramePromptSchema).max(500).default([]),
  /** Frame index (as string) → RLE counts at width×height. */
  frames: z.record(z.string().regex(/^\d+$/), RLESchema),
  /** Frame range that tracking covered (inclusive), if tracked. */
  trackedRange: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Track = z.infer<typeof TrackSchema>;

export interface TrackSummary extends Omit<Track, "frames"> {
  maskedFrames: number;
  coverage: Array<[number, number]>;
}

// ---------------------------------------------------------------------------
// Commands (history of AI requests)
// ---------------------------------------------------------------------------
export const CommandRecordSchema = z.object({
  id: z.string(),
  text: z.string().max(500),
  createdAt: z.string(),
  command: EditCommandSchema.nullable(),
  source: z.enum(COMMAND_SOURCES).optional(),
  model: z.string().optional(),
  planSummary: z.string().optional(),
  status: z.enum(["parsed", "running", "completed", "failed", "cancelled"]),
  jobId: z.string().optional(),
  trackId: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  error: z
    .object({ code: z.string(), message: z.string(), hint: z.string().optional(), retryable: z.boolean() })
    .optional(),
});
export type CommandRecord = z.infer<typeof CommandRecordSchema>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------
export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: ProjectIdSchema,
  name: z.string().trim().min(1).max(120),
  isDemo: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  video: VideoMetadataSchema,
  media: MediaStateSchema,
  /** Resolution masks are computed at (aspect-preserving, max side ANALYSIS_MAX_SIZE). */
  analysis: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  composite: CompositeSchema,
  commands: z.array(CommandRecordSchema).max(200).default([]),
  jobIds: z.array(z.string()).max(500).default([]),
  exportSettings: ExportSettingsSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export interface ProjectListItem {
  id: string;
  name: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
  duration: number;
  width: number;
  height: number;
  trackCount: number;
  hasPoster: boolean;
}

export const TRACK_COLORS = ["#c6f432", "#22d3ee", "#f472b6", "#fbbf24", "#a78bfa", "#fb7185", "#34d399", "#60a5fa"];
