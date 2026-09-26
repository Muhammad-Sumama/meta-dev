import { AppError } from "@/lib/errors";
import {
  ACTION_DEFAULTS,
  ACTIONS,
  EditCommandSchema,
  EFFECT_TYPES,
  POSITIONS,
  TARGET_CATEGORIES,
  type CommandAction,
  type EditCommand,
  type EffectType,
} from "@/lib/schemas/command";
import { categoryOfNoun, normalizeColor } from "./lexicon";

/**
 * Turns untrusted model output into a validated EditCommand.
 *
 * Models drift: they wrap JSON in prose or code fences, rename fields, use
 * synonyms ("follow" for "track"), return strings where objects are
 * expected, or invent values. This function accepts a bounded set of such
 * variations, maps them onto the schema, and rejects everything else with
 * INVALID_AI_RESPONSE. Unknown fields are dropped. Nothing here executes.
 */

const ACTION_SYNONYMS: Record<string, CommandAction> = {
  follow: "track",
  tracking: "track",
  segment: "mask",
  segment_and_track: "track",
  segmentation: "mask",
  rotoscope: "mask",
  matte: "mask",
  cutout: "isolate",
  cut_out: "isolate",
  extract: "isolate",
  removebackground: "remove_background",
  remove_bg: "remove_background",
  background_removal: "remove_background",
  blur_background: "blur",
  blur_object: "blur",
  pixelate: "blur",
  censor: "blur",
  spotlight: "highlight",
  replacebackground: "replace_background",
  replace_bg: "replace_background",
  change_background: "replace_background",
  remove: "remove_object",
  erase: "remove_object",
  delete: "remove_object",
  inpaint: "remove_object",
  export: "export_mask",
  exportmask: "export_mask",
  pick: "select",
  find: "select",
  identify: "select",
};

const MAX_RAW_LENGTH = 20_000;

export function extractJson(raw: string): unknown {
  if (raw.length > MAX_RAW_LENGTH) throw new AppError("INVALID_AI_RESPONSE", { message: "The AI response was too long." });
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new AppError("INVALID_AI_RESPONSE", { message: "The AI didn't return structured data." });
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (cause) {
    throw new AppError("INVALID_AI_RESPONSE", { message: "The AI returned malformed data.", cause });
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function toKey(v: string): string {
  return v.toLowerCase().trim().replace(/[\s-]+/g, "_");
}

function normalizeAction(v: unknown): CommandAction | null {
  const s = str(v, 60);
  if (!s) return null;
  const k = toKey(s);
  if ((ACTIONS as readonly string[]).includes(k)) return k as CommandAction;
  return ACTION_SYNONYMS[k] ?? ACTION_SYNONYMS[k.replace(/_/g, "")] ?? null;
}

function normalizeEffect(v: unknown, action: CommandAction): Record<string, unknown> {
  const rec = asRecord(v);
  const typeRaw = rec ? str(rec.type, 60) : str(v, 60);
  let type: EffectType | undefined;
  if (typeRaw) {
    const k = toKey(typeRaw);
    if ((EFFECT_TYPES as readonly string[]).includes(k)) type = k as EffectType;
    else if (k === "blur") type = "blur_background";
    else if (k === "transparent" || k === "transparent_background") type = "remove_background";
  }
  type ??= ACTION_DEFAULTS[action].effect;
  const out: Record<string, unknown> = { type };
  if (rec) {
    const color = str(rec.color, 20);
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) out.color = color.toLowerCase();
    if (typeof rec.strength === "number" && Number.isFinite(rec.strength)) out.strength = Math.min(1, Math.max(0, rec.strength));
  }
  return out;
}

function normalizeTarget(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const d = str(v);
    if (!d) return null;
    return { type: categoryOfNoun(d.split(/\s+/).pop()), description: d, attributes: { colors: [], clothing: [] } };
  }
  const rec = asRecord(v);
  if (!rec) return null;
  const description = str(rec.description) ?? str(rec.name) ?? str(rec.label) ?? str(rec.object) ?? str(rec.noun);
  const reference = rec.reference === "current_selection" ? "current_selection" : "description";
  if (!description && reference !== "current_selection") return null;

  const noun = str(rec.noun, 40);
  const rawType = str(rec.type, 30);
  const type =
    rawType && (TARGET_CATEGORIES as readonly string[]).includes(toKey(rawType))
      ? toKey(rawType)
      : categoryOfNoun(noun ?? description?.split(/\s+/).pop());

  const attrs = asRecord(rec.attributes) ?? {};
  const rawColors = Array.isArray(attrs.colors) ? attrs.colors : Array.isArray(rec.colors) ? rec.colors : typeof attrs.color === "string" ? [attrs.color] : [];
  const colors = [...new Set(rawColors.map((c) => normalizeColor(typeof c === "string" ? c : "")).filter(Boolean))].slice(0, 4);
  const rawClothing = Array.isArray(attrs.clothing) ? attrs.clothing : [];
  const clothing = rawClothing
    .map((c) => {
      const r = asRecord(c);
      const item = r ? str(r.item, 30) : str(c, 30);
      if (!item) return null;
      const color = r ? normalizeColor(str(r.color, 20)) : undefined;
      return { item: item.toLowerCase(), ...(color ? { color } : {}) };
    })
    .filter(Boolean)
    .slice(0, 4);
  const posRaw = str(attrs.position, 30) ?? str(rec.position, 30);
  const position = posRaw && (POSITIONS as readonly string[]).includes(toKey(posRaw)) ? toKey(posRaw) : undefined;
  const sizeRaw = str(attrs.size, 20)?.toLowerCase();
  const size = sizeRaw === "largest" || sizeRaw === "biggest" ? "largest" : sizeRaw === "smallest" ? "smallest" : undefined;

  return {
    type,
    ...(noun ? { noun } : {}),
    description: description ?? "current selection",
    attributes: { colors, clothing, ...(position ? { position } : {}), ...(size ? { size } : {}) },
    reference,
  };
}

function normalizeRange(v: unknown): Record<string, number> | null {
  const rec = asRecord(v);
  if (!rec) return null;
  const s = typeof rec.startSeconds === "number" ? rec.startSeconds : typeof rec.start === "number" ? rec.start : undefined;
  const e = typeof rec.endSeconds === "number" ? rec.endSeconds : typeof rec.end === "number" ? rec.end : undefined;
  const out: Record<string, number> = {};
  if (s !== undefined && Number.isFinite(s) && s >= 0) out.startSeconds = s;
  if (e !== undefined && Number.isFinite(e) && e > 0) out.endSeconds = e;
  if (out.startSeconds !== undefined && out.endSeconds !== undefined && out.endSeconds <= out.startSeconds) return null;
  return Object.keys(out).length ? out : null;
}

export function normalizeCommand(raw: unknown): EditCommand {
  const obj = asRecord(typeof raw === "string" ? extractJson(raw) : raw);
  if (!obj) throw new AppError("INVALID_AI_RESPONSE", { message: "The AI response wasn't an object." });

  // Some models nest the command: { "command": { … } }
  const src = asRecord(obj.command) ?? obj;

  let action = normalizeAction(src.action);
  if (!action && typeof src.intent === "string") action = normalizeAction(src.intent);
  const target = normalizeTarget(src.target);
  if (!action) {
    if (target) action = "select";
    else throw new AppError("COMMAND_NOT_UNDERSTOOD");
  }
  const defaults = ACTION_DEFAULTS[action];
  const effect = normalizeEffect(src.effect, action);

  const tracking = typeof src.tracking === "boolean" ? src.tracking : defaults.tracking;
  const candidate = {
    version: 1,
    action,
    intent: !tracking && defaults.intent === "segment_and_track" ? "segment" : defaults.intent,
    target,
    tracking,
    effect,
    output: typeof src.output === "string" && ["mask", "matte", "cutout", "video", "png_sequence"].includes(src.output) ? src.output : defaults.output,
    frameRange: normalizeRange(src.frameRange ?? src.frame_range ?? src.range),
    confidence: typeof src.confidence === "number" && src.confidence >= 0 && src.confidence <= 1 ? src.confidence : 0.6,
    ...(str(src.clarification, 300) ? { clarification: str(src.clarification, 300) } : {}),
  };

  const parsed = EditCommandSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new AppError("INVALID_AI_RESPONSE", {
      message: "The AI returned a command we couldn't validate.",
      cause: new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")),
    });
  }
  return parsed.data;
}
