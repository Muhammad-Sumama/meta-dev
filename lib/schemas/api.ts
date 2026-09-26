import { z } from "zod";
import {
  BoxPromptSchema,
  CompositeSchema,
  ExportSettingsSchema,
  PointPromptSchema,
  TrackIdSchema,
  TrackSchema,
} from "./project";

export const CommandRequestSchema = z.object({
  text: z.string().trim().min(1, "Type what you want to do").max(500, "Keep requests under 500 characters"),
  frameIndex: z.number().int().min(0).default(0),
  selectedTrackId: TrackIdSchema.optional(),
});
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export const ParseRequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
});

export const SegmentRequestSchema = z
  .object({
    frameIndex: z.number().int().min(0),
    points: z.array(PointPromptSchema).max(64).default([]),
    box: BoxPromptSchema.optional(),
  })
  .refine((r) => r.points.length > 0 || r.box, { message: "Provide at least one point or a box" });
export type SegmentRequest = z.infer<typeof SegmentRequestSchema>;

const RLESchema = z.array(z.number().int().nonnegative()).max(200_000);

export const KeyframeSchema = z
  .object({
    frameIndex: z.number().int().min(0),
    points: z.array(PointPromptSchema).max(64).default([]),
    box: BoxPromptSchema.optional(),
    /** Optional mask prompt (e.g. after brush edits), RLE at analysis resolution. */
    mask: RLESchema.optional(),
  })
  .refine((k) => k.points.length > 0 || k.box || k.mask, { message: "Each keyframe needs points, a box, or a mask" });
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const TrackRequestSchema = z.object({
  trackId: TrackIdSchema.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  keyframes: z.array(KeyframeSchema).min(1).max(50),
  range: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .refine((r) => r.end >= r.start)
    .optional(),
  direction: z.enum(["both", "forward", "backward"]).default("both"),
  /** Keep existing masks outside the propagated range (used for "re-track from here"). */
  preserveOutside: z.boolean().default(false),
});
export type TrackRequest = z.infer<typeof TrackRequestSchema>;

export const SaveTrackRequestSchema = TrackSchema;

export const PatchProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  composite: CompositeSchema.optional(),
  exportSettings: ExportSettingsSchema.optional(),
});

export const ExportRequestSchema = z.object({
  settings: ExportSettingsSchema,
  composite: CompositeSchema.optional(),
});
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
