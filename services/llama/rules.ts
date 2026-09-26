import type { ColorName, CommandAction, EffectType, TargetPosition } from "@/lib/schemas/command";
import { CLOTHING, COLOR_HEX, isKnownNoun, normalizeColor, categoryOfNoun } from "./lexicon";

/**
 * Deterministic rule-based command parser.
 *
 * Used as the mock language provider (no model needed) and as the fallback
 * when a configured Llama endpoint is unavailable or returns unusable output.
 * It returns a *raw* command object that goes through the same schema
 * validation as model output (services/llama/normalize.ts).
 */

export const RULES_VERSION = "rules-v1";

const TIME = String.raw`(\d+:\d{1,2}(?:\.\d+)?|\d+(?:\.\d+)?\s?(?:s|sec|secs|seconds?)?)`;

function parseTime(v: string): number | undefined {
  const t = v.trim();
  const mmss = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : undefined;
}

function extractRange(text: string): { range: { startSeconds?: number; endSeconds?: number } | null; rest: string } {
  let m = new RegExp(String.raw`\b(?:for|in|during|over) the first ${TIME}`).exec(text);
  if (m) {
    const end = parseTime(m[1]);
    if (end !== undefined) return { range: { startSeconds: 0, endSeconds: end }, rest: text.replace(m[0], " ") };
  }
  m = new RegExp(String.raw`\b(?:from|between) ${TIME} (?:to|until|till|through|and|-) ${TIME}`).exec(text);
  if (m) {
    const a = parseTime(m[1]);
    const b = parseTime(m[2]);
    if (a !== undefined && b !== undefined && b > a) return { range: { startSeconds: a, endSeconds: b }, rest: text.replace(m[0], " ") };
  }
  const range: { startSeconds?: number; endSeconds?: number } = {};
  let rest = text;
  m = new RegExp(String.raw`\b(?:after|starting at|starting from|from) ${TIME}(?![\w:])`).exec(rest);
  if (m && /\d/.test(m[1])) {
    range.startSeconds = parseTime(m[1]);
    rest = rest.replace(m[0], " ");
  }
  m = new RegExp(String.raw`\b(?:until|till|before|up to) ${TIME}(?![\w:])`).exec(rest);
  if (m && /\d/.test(m[1])) {
    range.endSeconds = parseTime(m[1]);
    rest = rest.replace(m[0], " ");
  }
  return { range: range.startSeconds !== undefined || range.endSeconds !== undefined ? range : null, rest };
}

const POSITION_PATTERNS: Array<[TargetPosition, RegExp]> = [
  ["top_left", /\b(?:top|upper)[ -]left\b/],
  ["top_right", /\b(?:top|upper)[ -]right\b/],
  ["bottom_left", /\b(?:bottom|lower)[ -]left\b/],
  ["bottom_right", /\b(?:bottom|lower)[ -]right\b/],
  ["left", /\b(?:(?:on|to|at|from) the left(?: side)?|left(?:-| )?(?:most|side|hand)|leftmost|on the left)\b|\bleft\b(?= (?:one|person|man|woman|car|dog|side))/],
  ["right", /\b(?:(?:on|to|at|from) the right(?: side)?|right(?:-| )?(?:most|side|hand)|rightmost)\b|\bright\b(?= (?:one|person|man|woman|car|dog|side))/],
  ["center", /\b(?:in the |at the )?(?:center|centre|middle)\b|\bcentral\b/],
  ["foreground", /\b(?:in (?:the )?front|foreground|closest|nearest|nearer)\b/],
  ["background", /\bin the (?:background|back|distance)\b|\bfar(?:thest)? (?:away|back)\b|\bdistant\b/],
  ["top", /\b(?:at the |on the )?top\b|\bupper\b/],
  ["bottom", /\b(?:at the |on the )?bottom\b|\blower\b/],
];

const REFERENCE = /\b(?:it|this one|that one|the selection|the selected (?:object|one|thing|person|item)|selected object|current selection|my selection|this object|that object|them)\b/;

const CLOTHING_ALT = CLOTHING.map((c) => c.replace("-", "\\-")).join("|");
const CLOTHING_RE = new RegExp(
  String.raw`\b(?:in|wearing|with|dressed in|who is wearing|that is wearing|who's wearing)\s+(?:a |an |the |his |her |their )?((?:[a-z]+ ){0,2})(${CLOTHING_ALT})\b`,
  "g",
);

const STOP_NOUNS = new Set(["background", "backdrop", "bg", "frame", "video", "clip", "mask", "matte", "screen", "sequence", "shot", "scene", "footage", "image", "png", "alpha"]);

function detectAction(text: string, mentionsBg: boolean): { action: CommandAction | null; effect: EffectType; explicit: boolean } {
  if (/\b(?:export|save|download|render)\b/.test(text) && /\b(?:masks?|matte|alpha|roto)\b/.test(text)) {
    return { action: "export_mask", effect: "none", explicit: true };
  }
  if (/\b(?:replace|change|swap|switch|turn)\b.*\b(?:background|backdrop|bg|sky)\b/.test(text) || /\b(?:green|blue) ?screen\b|\bchroma ?key\b/.test(text) || /\bmake the (?:background|bg) (?!transparent)\w+/.test(text)) {
    return { action: "replace_background", effect: "replace_background", explicit: true };
  }
  if (
    /\b(?:remove|delete|erase|drop|cut|get rid of|knock out|clear|take out|hide|kill)\b.*\b(?:background|backdrop|bg|surroundings|everything else)\b/.test(text) ||
    /\btransparent\b/.test(text) ||
    /\b(?:no|without(?: a| the)?) background\b/.test(text)
  ) {
    return { action: "remove_background", effect: "remove_background", explicit: true };
  }
  if (/\b(?:blur|blurred|blurry|pixelate|censor|obscure|anonymi[sz]e|defocus|bokeh)\b/.test(text)) {
    const bg = mentionsBg || /\b(?:bokeh|defocus|portrait mode)\b/.test(text);
    return { action: "blur", effect: bg ? "blur_background" : "blur_object", explicit: true };
  }
  if (/\b(?:highlight|spotlight|emphasi[sz]e|focus on|outline|glow)\b|\bmake .* (?:pop|stand out)\b/.test(text)) {
    return { action: "highlight", effect: "highlight", explicit: true };
  }
  if (/\b(?:remove|delete|erase|get rid of|take out|eliminate|paint out|clean up)\b/.test(text)) {
    return { action: "remove_object", effect: "remove_object", explicit: true };
  }
  if (/\b(?:isolate|extract|separate|cut out|cutout|pull out|lift out|key out)\b/.test(text)) {
    return { action: "isolate", effect: "remove_background", explicit: true };
  }
  if (/\b(?:track|tracking|follow|trace|keep up with)\b/.test(text)) return { action: "track", effect: "none", explicit: true };
  if (/\b(?:mask|matte|rotoscope|roto|segment|segmentation)\b/.test(text)) return { action: "mask", effect: "none", explicit: true };
  if (/\b(?:select|pick|choose|find|grab|get|identify|detect|click|locate|show me|mark)\b/.test(text)) {
    return { action: "select", effect: "none", explicit: true };
  }
  return { action: null, effect: "none", explicit: false };
}

export function parseWithRules(input: string): Record<string, unknown> {
  let text = input
    .toLowerCase()
    .replace(/[“”"`]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");

  const { range, rest } = extractRange(text);
  text = rest.replace(/\s+/g, " ").trim();

  const thisFrameOnly = /\b(?:this|the current|current|only this|just this|single|one) frame\b/.test(text);
  const mentionsBgRaw = /\b(?:background|backdrop|bg|surroundings|everything else|behind (?:him|her|them|it))\b/.test(
    text.replace(/\bin the background\b/g, ""),
  );

  const { action: detected, effect, explicit } = detectAction(text, mentionsBgRaw);

  // --- Clothing -------------------------------------------------------------
  const clothing: Array<{ item: string; color?: ColorName }> = [];
  let targetText = text;
  for (const m of text.matchAll(CLOTHING_RE)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    const color = words.map((w) => normalizeColor(w)).find(Boolean);
    const item = m[2] === "tshirt" || m[2] === "t-shirt" ? "shirt" : m[2];
    clothing.push({ item, ...(color ? { color } : {}) });
    targetText = targetText.replace(m[0], " ");
  }

  // --- Position & size ------------------------------------------------------
  let position: TargetPosition | undefined;
  for (const [pos, re] of POSITION_PATTERNS) {
    if (re.test(targetText)) {
      // "remove the background" is an effect, not a position.
      if (pos === "background" && !/\bin the (?:background|back|distance)\b|\bfar|\bdistant\b/.test(targetText)) continue;
      position = pos;
      targetText = targetText.replace(re, " ");
      break;
    }
  }
  let size: "largest" | "smallest" | undefined;
  if (/\b(?:biggest|largest|big|large)\b/.test(targetText)) size = "largest";
  else if (/\b(?:smallest|small|little|tiny)\b/.test(targetText)) size = "smallest";

  // --- Main noun and its colors --------------------------------------------
  const tokens = targetText.replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  let noun: string | undefined;
  let nounIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (STOP_NOUNS.has(t) || CLOTHING.includes(t)) continue;
    const bigram = i + 1 < tokens.length ? `${t} ${tokens[i + 1]}` : "";
    if (bigram === "license plate" || bigram === "number plate") {
      noun = "license plate";
      nounIdx = i;
      break;
    }
    if (isKnownNoun(t)) {
      noun = t;
      nounIdx = i;
      break;
    }
  }
  const colors: ColorName[] = [];
  if (nounIdx >= 0) {
    for (let j = Math.max(0, nounIdx - 3); j < nounIdx; j++) {
      const c = normalizeColor(tokens[j]);
      if (c && !colors.includes(c)) colors.push(c);
    }
  } else if (!clothing.length) {
    // "select the red one"
    const oneIdx = tokens.findIndex((t) => t === "one" || t === "thing" || t === "object");
    const scan = oneIdx >= 0 ? tokens.slice(Math.max(0, oneIdx - 2), oneIdx) : [];
    for (const t of scan) {
      const c = normalizeColor(t);
      if (c && !colors.includes(c)) colors.push(c);
    }
  }

  const isReference = !noun && REFERENCE.test(targetText);
  let target: Record<string, unknown> | null = null;
  if (noun || colors.length || clothing.length) {
    const cat = noun ? categoryOfNoun(noun) : clothing.length ? "person" : "any";
    const baseNoun = noun ?? (clothing.length ? "person" : "object");
    const parts = [...(size ? [size === "largest" ? "largest" : "smallest"] : []), ...colors, baseNoun];
    let description = parts.join(" ");
    for (const c of clothing) description += ` in ${c.color ? `${c.color} ` : ""}${c.item}`;
    if (position) description += ` (${position.replace("_", " ")})`;
    target = {
      type: cat,
      ...(noun ? { noun } : {}),
      description,
      attributes: { colors, clothing, ...(position ? { position } : {}), ...(size ? { size } : {}) },
      reference: "description",
    };
  } else if (isReference || (detected && effect !== "none") || detected === "export_mask") {
    target = isReference
      ? { type: "any", description: "current selection", attributes: { colors: [], clothing: [] }, reference: "current_selection" }
      : null;
  }

  const action: CommandAction | null = detected ?? (target ? "select" : null);

  // --- Effect parameters ----------------------------------------------------
  const effectObj: Record<string, unknown> = { type: effect };
  if (effect === "replace_background") {
    const hex = /#[0-9a-f]{6}\b/.exec(text)?.[0];
    let color: string | undefined = hex;
    if (!color && /\bgreen ?screen\b|\bchroma ?key\b/.test(text)) color = "#00b140";
    if (!color && /\bblue ?screen\b/.test(text)) color = "#0047bb";
    if (!color) {
      const after = /\b(?:with|to|into|make the (?:background|bg))\s+(?:a |an |plain |solid |pure )*([a-z]+)/.exec(text)?.[1];
      const named = normalizeColor(after);
      if (named) color = COLOR_HEX[named];
    }
    effectObj.color = color ?? "#00b140";
  }
  if (effect === "blur_background" || effect === "blur_object") {
    effectObj.strength = /\b(?:heavily|heavy|strong|strongly|a lot|very|extremely|fully)\b/.test(text)
      ? 0.9
      : /\b(?:slightly|slight|light|lightly|subtle|subtly|a bit|a little|soft)\b/.test(text)
        ? 0.3
        : 0.6;
  }

  const output = /\bpng\b/.test(text)
    ? "png_sequence"
    : action === "export_mask" || action === "mask" || action === "select" || action === "track"
      ? "mask"
      : effect === "remove_background"
        ? "cutout"
        : "video";

  const confidence = !action ? 0 : explicit && noun ? 0.9 : explicit && (target || isReference) ? 0.75 : noun ? 0.7 : 0.5;

  let clarification: string | undefined;
  if (action && !target && !["export_mask"].includes(action) && effect === "none") {
    clarification = "Which object do you mean? Try naming it, e.g. “Track the dog”.";
  }

  return {
    version: 1,
    action,
    target,
    tracking: !thisFrameOnly,
    effect: effectObj,
    output,
    frameRange: range,
    confidence,
    ...(clarification ? { clarification } : {}),
  };
}
