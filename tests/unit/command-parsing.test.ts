import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { normalizeCommand, extractJson } from "@/services/llama/normalize";
import { parseWithRules } from "@/services/llama/rules";

const parse = (t: string) => normalizeCommand(parseWithRules(t));

describe("rule-based command parser (mock Llama)", () => {
  it.each([
    ["Track the red car.", "track", "vehicle", "red car", "none"],
    ["Remove the man in the red shirt.", "remove_object", "person", "man in red shirt", "remove_object"],
    ["Select the woman standing in the center.", "select", "person", "woman (center)", "none"],
    ["Create a mask around the dog.", "mask", "animal", "dog", "none"],
    ["Isolate the person and make the background transparent.", "remove_background", "person", "person", "remove_background"],
    ["Blur the background behind the dog", "blur", "animal", "dog", "blur_background"],
    ["blur the license plate", "blur", "object", "license plate", "blur_object"],
    ["Highlight the person on the left", "highlight", "person", "person (left)", "highlight"],
    ["Replace the background of the man with blue", "replace_background", "person", "man", "replace_background"],
    ["Track the person in the blue shirt", "track", "person", "person in blue shirt", "none"],
  ])("%s", (text, action, type, description, effect) => {
    const c = parse(text);
    expect(c.action).toBe(action);
    expect(c.target?.type).toBe(type);
    expect(c.target?.description).toBe(description);
    expect(c.effect.type).toBe(effect);
    expect(c.tracking).toBe(true);
  });

  it("extracts clothing colors and positions as structured attributes", () => {
    const c = parse("Select the man wearing a red jacket on the right");
    expect(c.target?.attributes.clothing).toEqual([{ item: "jacket", color: "red" }]);
    expect(c.target?.attributes.position).toBe("right");
  });

  it("parses time ranges", () => {
    expect(parse("Track the dog for the first 5 seconds").frameRange).toEqual({ startSeconds: 0, endSeconds: 5 });
    expect(parse("Track the car from 0:02 to 0:07").frameRange).toEqual({ startSeconds: 2, endSeconds: 7 });
    expect(parse("Track the car between 1.5s and 4s").frameRange).toEqual({ startSeconds: 1.5, endSeconds: 4 });
  });

  it("limits edits to the current frame when asked", () => {
    const c = parse("Select the dog on this frame only");
    expect(c.tracking).toBe(false);
    expect(c.intent).toBe("segment");
  });

  it("treats pronouns as the current selection", () => {
    const c = parse("Blur it");
    expect(c.target?.reference).toBe("current_selection");
  });

  it("keeps effect-only commands target-free", () => {
    const c = parse("Remove the background");
    expect(c.action).toBe("remove_background");
    expect(c.target).toBeNull();
  });

  it("maps green screen and named colors to hex", () => {
    expect(parse("Put the dog on a green screen").effect.color).toBe("#00b140");
    expect(parse("Replace the background with white").effect.color).toBe("#ffffff");
  });

  it("recognizes export requests", () => {
    expect(parse("Export the mask").action).toBe("export_mask");
  });

  it("rejects gibberish", () => {
    expect(() => parse("asdf qwerty")).toThrowError(AppError);
    try {
      parse("asdf qwerty");
    } catch (e) {
      expect((e as AppError).code).toBe("COMMAND_NOT_UNDERSTOOD");
    }
  });
});

describe("model output validation", () => {
  it("accepts well-formed JSON", () => {
    const c = normalizeCommand(
      JSON.stringify({ action: "track", target: { type: "vehicle", description: "red car", attributes: { colors: ["red"] } }, tracking: true, output: "mask" }),
    );
    expect(c.action).toBe("track");
    expect(c.target?.attributes.colors).toEqual(["red"]);
  });

  it("extracts JSON from prose and code fences", () => {
    expect(extractJson('Sure! Here you go:\n```json\n{"action":"select","target":"the dog"}\n```')).toEqual({ action: "select", target: "the dog" });
    const c = normalizeCommand('Here is the command: {"action": "select", "target": "the dog"} Hope it helps');
    expect(c.target?.description).toBe("the dog");
    expect(c.target?.type).toBe("animal");
  });

  it("maps synonyms and nested commands", () => {
    expect(normalizeCommand({ command: { action: "follow", target: { description: "cyclist" } } }).action).toBe("track");
    expect(normalizeCommand({ intent: "segment_and_track", target: { name: "bus" } }).target?.type).toBe("vehicle");
    const blur = normalizeCommand({ action: "blur_background", target: { description: "woman" } });
    expect(blur.action).toBe("blur");
  });

  it("drops invalid values instead of trusting them", () => {
    const c = normalizeCommand({
      action: "track",
      target: { description: "car", type: "spaceship", attributes: { colors: ["red", "ultraviolet", 3], position: "upside-down" } },
      effect: { type: "remove_background", color: "javascript:alert(1)", strength: 99 },
      confidence: 7,
      evil: "<script>",
    });
    expect(c.target?.type).toBe("vehicle");
    expect(c.target?.attributes.colors).toEqual(["red"]);
    expect(c.target?.attributes.position).toBeUndefined();
    expect(c.effect.color).toBeUndefined();
    expect(c.effect.strength).toBe(1);
    expect(c.confidence).toBe(0.6);
    expect(c).not.toHaveProperty("evil");
  });

  it("rejects malformed and hostile output with a user-facing error", () => {
    for (const bad of ["not json at all", "{broken json", "[1,2,3]", "x".repeat(30_000)]) {
      try {
        normalizeCommand(bad);
        throw new Error("expected failure");
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect(["INVALID_AI_RESPONSE", "COMMAND_NOT_UNDERSTOOD"]).toContain((e as AppError).code);
      }
    }
    expect(() => normalizeCommand({ action: "launch_missiles" })).toThrowError(/understand/);
  });

  it("rejects inverted time ranges", () => {
    const c = normalizeCommand({ action: "track", target: "dog", frameRange: { startSeconds: 5, endSeconds: 2 } });
    expect(c.frameRange).toBeNull();
  });
});
