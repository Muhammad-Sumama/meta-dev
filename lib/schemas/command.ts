import { z } from "zod";

/**
 * Structured editing command produced by the language layer (Llama or the
 * built-in rule parser). Model output is NEVER executed directly: it is
 * validated against these schemas, normalized, and compiled into an
 * EditingPlan by deterministic code (services/llama/plan.ts).
 */

export const ACTIONS = [
  "select",
  "isolate",
  "track",
  "mask",
  "remove_background",
  "blur",
  "highlight",
  "replace_background",
  "remove_object",
  "export_mask",
] as const;
export type CommandAction = (typeof ACTIONS)[number];

export const INTENTS = ["segment", "segment_and_track", "apply_effect", "export"] as const;
export type CommandIntent = (typeof INTENTS)[number];

export const TARGET_CATEGORIES = ["person", "animal", "vehicle", "object", "any"] as const;
export type TargetCategory = (typeof TARGET_CATEGORIES)[number];

export const POSITIONS = [
  "left",
  "right",
  "center",
  "top",
  "bottom",
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
  "foreground",
  "background",
] as const;
export type TargetPosition = (typeof POSITIONS)[number];

export const COLOR_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "brown",
  "black",
  "white",
  "gray",
] as const;
export type ColorName = (typeof COLOR_NAMES)[number];

export const EFFECT_TYPES = [
  "none",
  "remove_background",
  "blur_background",
  "blur_object",
  "highlight",
  "replace_background",
  "remove_object",
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

export const OUTPUTS = ["mask", "matte", "cutout", "video", "png_sequence"] as const;
export type CommandOutput = (typeof OUTPUTS)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #RRGGBB color");

export const ClothingSchema = z.object({
  item: z.string().trim().min(1).max(30),
  color: z.enum(COLOR_NAMES).optional(),
});

export const TargetAttributesSchema = z.object({
  colors: z.array(z.enum(COLOR_NAMES)).max(4).default([]),
  position: z.enum(POSITIONS).optional(),
  size: z.enum(["largest", "smallest"]).optional(),
  clothing: z.array(ClothingSchema).max(4).default([]),
});

export const TargetSchema = z.object({
  type: z.enum(TARGET_CATEGORIES).default("any"),
  noun: z.string().trim().max(40).optional(),
  description: z.string().trim().min(1).max(200),
  attributes: TargetAttributesSchema.default({ colors: [], clothing: [] }),
  /** `current_selection` means "it/this/the selected object". */
  reference: z.enum(["description", "current_selection"]).default("description"),
});
export type Target = z.infer<typeof TargetSchema>;
export type TargetAttributes = z.infer<typeof TargetAttributesSchema>;

export const EffectSchema = z.object({
  type: z.enum(EFFECT_TYPES).default("none"),
  color: hexColor.optional(),
  /** 0..1, used by blur and highlight. */
  strength: z.number().min(0).max(1).optional(),
});
export type Effect = z.infer<typeof EffectSchema>;

export const FrameRangeSchema = z
  .object({
    startSeconds: z.number().min(0).max(86_400).optional(),
    endSeconds: z.number().min(0).max(86_400).optional(),
  })
  .refine((r) => r.startSeconds === undefined || r.endSeconds === undefined || r.endSeconds > r.startSeconds, {
    message: "endSeconds must be after startSeconds",
  });

export const EditCommandSchema = z.object({
  version: z.literal(1).default(1),
  action: z.enum(ACTIONS),
  intent: z.enum(INTENTS),
  target: TargetSchema.nullable(),
  tracking: z.boolean(),
  effect: EffectSchema.default({ type: "none" }),
  output: z.enum(OUTPUTS).default("mask"),
  frameRange: FrameRangeSchema.nullable().default(null),
  confidence: z.number().min(0).max(1).default(0.5),
  /** Set when the request is ambiguous; shown to the user. */
  clarification: z.string().max(300).optional(),
});
export type EditCommand = z.infer<typeof EditCommandSchema>;

export const COMMAND_SOURCES = ["llama", "rules", "fallback"] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

export interface ParsedCommand {
  command: EditCommand;
  source: CommandSource;
  warnings: string[];
  /** Model or parser identifier, e.g. "llama3.1:8b" or "rules-v1". */
  model: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Editing plans (compiled deterministically from a validated EditCommand)
// ---------------------------------------------------------------------------

export type PlanStep =
  | { kind: "use_selection"; trackId: string }
  | { kind: "locate"; description: string }
  | { kind: "segment" }
  | { kind: "track"; startFrame: number; endFrame: number }
  | { kind: "apply_effect"; effect: Effect }
  | { kind: "open_export"; preset: "mask" | "video" | "png_sequence" };

export interface EditingPlan {
  steps: PlanStep[];
  requiresSegmentation: boolean;
  existingTrackId?: string;
  summary: string;
}

/** Map of action → default intent/effect/output used for normalization. */
export const ACTION_DEFAULTS: Record<
  CommandAction,
  { intent: CommandIntent; effect: EffectType; output: CommandOutput; tracking: boolean }
> = {
  select: { intent: "segment_and_track", effect: "none", output: "mask", tracking: true },
  isolate: { intent: "segment_and_track", effect: "remove_background", output: "cutout", tracking: true },
  track: { intent: "segment_and_track", effect: "none", output: "mask", tracking: true },
  mask: { intent: "segment_and_track", effect: "none", output: "mask", tracking: true },
  remove_background: { intent: "segment_and_track", effect: "remove_background", output: "cutout", tracking: true },
  blur: { intent: "segment_and_track", effect: "blur_background", output: "video", tracking: true },
  highlight: { intent: "segment_and_track", effect: "highlight", output: "video", tracking: true },
  replace_background: { intent: "segment_and_track", effect: "replace_background", output: "video", tracking: true },
  remove_object: { intent: "segment_and_track", effect: "remove_object", output: "video", tracking: true },
  export_mask: { intent: "export", effect: "none", output: "mask", tracking: true },
};
