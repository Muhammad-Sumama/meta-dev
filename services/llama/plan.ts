import { AppError } from "@/lib/errors";
import type { EditCommand, EditingPlan, PlanStep } from "@/lib/schemas/command";

export interface PlanContext {
  fps: number;
  frameCount: number;
  /** Frame the user is looking at (grounding starts here). */
  frameIndex: number;
  selectedTrackId?: string;
  /** Number of existing tracks (export can use all of them). */
  trackCount: number;
}

const EFFECT_LABEL: Record<string, string> = {
  remove_background: "remove the background",
  blur_background: "blur the background",
  blur_object: "blur it",
  highlight: "highlight it",
  replace_background: "replace the background",
  remove_object: "remove it with a clean plate",
};

/**
 * Compiles a validated command into concrete steps. This is deterministic
 * code, not model output: the model only ever chooses among these steps
 * through the schema-constrained command.
 */
export function generateEditingPlan(command: EditCommand, ctx: PlanContext): EditingPlan {
  const last = Math.max(0, ctx.frameCount - 1);
  const toFrame = (s: number | undefined, fallback: number) =>
    s === undefined ? fallback : Math.min(last, Math.max(0, Math.round(s * ctx.fps)));
  let startFrame = toFrame(command.frameRange?.startSeconds, 0);
  let endFrame = toFrame(command.frameRange?.endSeconds, last);
  if (endFrame < startFrame) [startFrame, endFrame] = [endFrame, startFrame];
  if (!command.tracking) startFrame = endFrame = Math.min(last, Math.max(0, ctx.frameIndex));

  const steps: PlanStep[] = [];
  const parts: string[] = [];
  const target = command.target;
  const useSelection = !target || target.reference === "current_selection";

  if (useSelection) {
    if (command.action === "export_mask" && !ctx.selectedTrackId && ctx.trackCount > 0) {
      steps.push({ kind: "open_export", preset: "mask" });
      return { steps, requiresSegmentation: false, summary: "Export masks for all tracked objects." };
    }
    if (!ctx.selectedTrackId) {
      throw new AppError("NO_SELECTION", {
        message: target ? "Select an object first, then ask again." : "Tell me which object to use.",
        hint: "Click an object with the Select tool, or name it — e.g. “Blur the background behind the dog”.",
      });
    }
    steps.push({ kind: "use_selection", trackId: ctx.selectedTrackId });
    parts.push("Use the selected object");
  } else {
    steps.push({ kind: "locate", description: target.description });
    steps.push({ kind: "segment" });
    parts.push(`Find “${target.description}” and segment it`);
    if (command.tracking) {
      steps.push({ kind: "track", startFrame, endFrame });
      const whole = startFrame === 0 && endFrame === last;
      parts.push(whole ? "track it through the whole clip" : `track it from frame ${startFrame} to ${endFrame}`);
    } else {
      parts.push("on this frame only");
    }
  }

  if (command.effect.type !== "none") {
    steps.push({ kind: "apply_effect", effect: command.effect });
    parts.push(`then ${EFFECT_LABEL[command.effect.type] ?? command.effect.type}`);
  }
  if (command.action === "export_mask") {
    steps.push({ kind: "open_export", preset: "mask" });
    parts.push("then export the mask");
  } else if (command.output === "png_sequence") {
    steps.push({ kind: "open_export", preset: "png_sequence" });
    parts.push("then export a PNG sequence");
  }

  const summary = parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".";
  return {
    steps,
    requiresSegmentation: !useSelection,
    existingTrackId: useSelection ? ctx.selectedTrackId : undefined,
    summary,
  };
}
