import { ACTIONS, COLOR_NAMES, EFFECT_TYPES, POSITIONS } from "@/lib/schemas/command";

/**
 * Prompt for Llama (or any OpenAI-compatible chat model) that converts a
 * video-editing request into the EditCommand JSON schema. Output is still
 * validated by normalizeCommand(); the prompt only makes success likely.
 */
export const SYSTEM_PROMPT = `You convert video editing requests into JSON for a rotoscoping tool.
The tool can segment and track objects in a video with SAM 2, then apply an effect.

Reply with ONE JSON object and nothing else. Schema:
{
  "action": one of ${JSON.stringify(ACTIONS)},
  "target": null | {
    "type": "person" | "animal" | "vehicle" | "object" | "any",
    "noun": short noun, e.g. "man", "car",
    "description": short phrase describing the object to find, e.g. "man in a red shirt",
    "attributes": {
      "colors": colors of the object itself, subset of ${JSON.stringify(COLOR_NAMES)},
      "clothing": [{ "item": "shirt", "color": "red" }],
      "position": optional, one of ${JSON.stringify(POSITIONS)},
      "size": optional, "largest" | "smallest"
    },
    "reference": "description" | "current_selection"
  },
  "tracking": true unless the user limits the edit to the current frame,
  "effect": { "type": one of ${JSON.stringify(EFFECT_TYPES)}, "color": "#RRGGBB" (replace_background only), "strength": 0..1 (blur only) },
  "output": "mask" | "matte" | "cutout" | "video" | "png_sequence",
  "frameRange": null | { "startSeconds": number, "endSeconds": number },
  "confidence": 0..1,
  "clarification": optional short question if the request is ambiguous
}

Rules:
- "remove the background", "make the background transparent" → action "remove_background", effect "remove_background".
- "remove the <object>" (not the background) → action "remove_object", effect "remove_object".
- "blur the background behind X" → action "blur", effect "blur_background", target X. "blur X" → effect "blur_object".
- Words like "it", "this", "the selection" → target.reference "current_selection".
- If no object is named and the edit applies to an existing selection, use target null.
- Never invent objects that are not mentioned.`;

export const FEW_SHOT: Array<{ user: string; assistant: string }> = [
  {
    user: "Track the red car.",
    assistant: JSON.stringify({
      action: "track",
      target: { type: "vehicle", noun: "car", description: "red car", attributes: { colors: ["red"], clothing: [] }, reference: "description" },
      tracking: true,
      effect: { type: "none" },
      output: "mask",
      frameRange: null,
      confidence: 0.95,
    }),
  },
  {
    user: "Remove the man in the red shirt",
    assistant: JSON.stringify({
      action: "remove_object",
      target: {
        type: "person",
        noun: "man",
        description: "man in a red shirt",
        attributes: { colors: [], clothing: [{ item: "shirt", color: "red" }] },
        reference: "description",
      },
      tracking: true,
      effect: { type: "remove_object" },
      output: "video",
      frameRange: null,
      confidence: 0.9,
    }),
  },
  {
    user: "blur the background behind the woman on the left for the first 5 seconds",
    assistant: JSON.stringify({
      action: "blur",
      target: {
        type: "person",
        noun: "woman",
        description: "woman on the left",
        attributes: { colors: [], clothing: [], position: "left" },
        reference: "description",
      },
      tracking: true,
      effect: { type: "blur_background", strength: 0.6 },
      output: "video",
      frameRange: { startSeconds: 0, endSeconds: 5 },
      confidence: 0.9,
    }),
  },
];

export function buildMessages(text: string, repair?: { previousOutput: string; validationError: string }) {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const ex of FEW_SHOT) {
    messages.push({ role: "user", content: ex.user });
    messages.push({ role: "assistant", content: ex.assistant });
  }
  // The request is passed as data; the model is told to treat it as such.
  messages.push({ role: "user", content: text.slice(0, 500) });
  if (repair) {
    messages.push({ role: "assistant", content: repair.previousOutput.slice(0, 4000) });
    messages.push({
      role: "user",
      content: `That output was invalid (${repair.validationError.slice(0, 300)}). Reply again with only a valid JSON object matching the schema.`,
    });
  }
  return messages;
}
