import "server-only";
import { AppError, toAppError } from "@/lib/errors";
import { decodeMask, encodeMask, isValidRLE, type RLECounts } from "@/lib/mask/rle";
import type { Effect, Target } from "@/lib/schemas/command";
import { TRACK_COLORS, type PointPrompt, type BoxPrompt, type Track } from "@/lib/schemas/project";
import { newId } from "@/lib/utils/ids";
import { getAIServices } from "@/services/ai/registry";
import type { TrackKeyframe } from "@/services/ai/types";
import type { JobHandler } from "@/services/jobs/types";
import { getProjectRepository } from "@/services/projects";
import { requireJobProject } from "./project";

/**
 * The "AI worker": runs segmentation/tracking jobs.
 *
 *   command → (locate → segment → track) → Track saved → project updated
 *   manual  → (keyframes → track)        → Track saved
 */

export type SegmentJobInput =
  | {
      kind: "command";
      commandId: string;
      text: string;
      target: Target;
      tracking: boolean;
      preferredFrame: number;
      startFrame: number;
      endFrame: number;
      effect: Effect;
    }
  | {
      kind: "track";
      trackId?: string;
      name?: string;
      keyframes: Array<{ frameIndex: number; points: PointPrompt[]; box?: BoxPrompt; mask?: RLECounts }>;
      startFrame: number;
      endFrame: number;
      direction: "both" | "forward" | "backward";
      preserveOutside: boolean;
    };

export interface SegmentJobResult {
  trackId: string;
  maskedFrames: number;
  keyframe: number;
  effect?: Effect;
  provider: string;
  providerKind: "mock" | "production";
}

function titleCase(s: string) {
  const t = s.replace(/\s*\(.*\)$/, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export const segmentationWorker: JobHandler<SegmentJobInput, SegmentJobResult> = async ({ job, signal, progress }) => {
  const input = job.input;
  const repo = getProjectRepository();
  const project = await requireJobProject(job.projectId);
  const { sam2 } = getAIServices();
  const n = project.analysis.width * project.analysis.height;
  const frames: Record<string, RLECounts> = {};

  const markCommand = async (patch: { status: "running" | "completed" | "failed" | "cancelled"; trackId?: string; error?: AppError }) => {
    if (input.kind !== "command") return;
    await repo
      .update(project.id, (p) => {
        const rec = p.commands.find((c) => c.id === input.commandId);
        if (!rec) return;
        rec.status = patch.status;
        if (patch.trackId) rec.trackId = patch.trackId;
        if (patch.error) rec.error = { code: patch.error.code, message: patch.error.message, hint: patch.error.hint, retryable: patch.error.retryable };
      })
      .catch(() => undefined);
  };

  try {
    await markCommand({ status: "running" });
    progress({ stage: "initializing", message: sam2.info.kind === "mock" ? "Analyzing the scene…" : "Loading video into SAM 2…", fraction: 0.01 });
    await sam2.initializeVideo(project, {
      signal,
      onProgress: (f, message) => progress({ stage: "initializing", message, fraction: 0.01 + f * 0.14 }),
    });

    const onFrame = (frameIndex: number, mask: Uint8Array | null) => {
      if (mask) frames[frameIndex] = encodeMask(mask);
      else delete frames[frameIndex];
    };
    const onProgress = (done: number, tot: number) =>
      progress({
        stage: "tracking",
        message: `Tracking frame ${Math.min(done, tot)} / ${tot}`,
        current: Math.min(done, tot),
        total: tot,
        fraction: 0.25 + 0.7 * Math.min(1, done / Math.max(1, tot)),
      });

    let keyframe = 0;
    let trackId = input.kind === "track" && input.trackId ? input.trackId : newId("trk");
    let existing: Track | null = null;
    let prompts: Track["prompts"] = [];

    if (input.kind === "command") {
      const res = await sam2.generateMaskSequence(
        project,
        { target: input.target, preferredFrame: input.preferredFrame, startFrame: input.startFrame, endFrame: input.endFrame, tracking: input.tracking },
        {
          signal,
          onFrame,
          onProgress,
          onStage: (stage, message) =>
            progress({ stage, message, fraction: stage === "locating" ? 0.16 : stage === "segmenting" ? 0.22 : 0.25 }),
        },
      );
      keyframe = res.keyframe.frameIndex;
      prompts = [
        {
          frameIndex: res.detection.frameIndex,
          points: res.detection.point ? [{ ...res.detection.point, label: 1 as const }] : [],
          box: res.detection.box,
          text: input.target.description,
        },
      ];
    } else {
      if (input.trackId) existing = await repo.getTrack(project.id, input.trackId);
      if (input.trackId && !existing) trackId = newId("trk");
      const keyframes: TrackKeyframe[] = input.keyframes.map((k) => {
        if (k.mask && !isValidRLE(k.mask, n)) throw new AppError("VALIDATION_ERROR", { message: "A mask didn't match the video's analysis size." });
        return { frameIndex: k.frameIndex, points: k.points, box: k.box, mask: k.mask ? decodeMask(k.mask, n) : undefined };
      });
      keyframe = keyframes[0]?.frameIndex ?? 0;
      progress({ stage: "tracking", message: "Tracking through the video…", fraction: 0.25 });
      await sam2.trackObject(
        project,
        { keyframes, startFrame: input.startFrame, endFrame: input.endFrame, direction: input.direction },
        { signal, onFrame, onProgress },
      );
      prompts = input.keyframes.map((k) => ({ frameIndex: k.frameIndex, points: k.points, box: k.box }));
    }

    const masked = Object.keys(frames).length;
    if (!masked) throw new AppError("TRACKING_FAILED", { message: "Tracking didn't produce any masks." });

    progress({ stage: "saving", message: "Saving masks…", fraction: 0.97 });
    const now = new Date().toISOString();
    const tracks = await repo.listTracks(project.id);
    const usedColors = new Set(tracks.map((t) => t.color));
    const color = existing?.color ?? TRACK_COLORS.find((c) => !usedColors.has(c)) ?? TRACK_COLORS[tracks.length % TRACK_COLORS.length];

    let mergedFrames = frames;
    if (existing && input.kind === "track" && input.preserveOutside) {
      mergedFrames = { ...existing.frames };
      for (const k of Object.keys(mergedFrames)) {
        const f = Number(k);
        if (f >= input.startFrame && f <= input.endFrame) delete mergedFrames[k];
      }
      Object.assign(mergedFrames, frames);
    }

    const track: Track = {
      id: trackId,
      name:
        existing?.name ??
        (input.kind === "command" ? titleCase(input.target.description) : input.name ?? `Object ${tracks.length + 1}`),
      color,
      visible: true,
      source: input.kind === "command" ? "ai" : existing?.source ?? "manual",
      provider: sam2.info.id,
      category: input.kind === "command" ? input.target.type : existing?.category,
      command: input.kind === "command" ? input.text : existing?.command,
      width: project.analysis.width,
      height: project.analysis.height,
      prompts: existing && input.kind === "track" && input.preserveOutside ? [...existing.prompts, ...prompts].slice(-500) : prompts,
      frames: mergedFrames,
      trackedRange: { start: input.startFrame, end: input.endFrame },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await repo.saveTrack(project.id, track);

    if (input.kind === "command") {
      await markCommand({ status: "completed", trackId });
      if (input.effect.type !== "none") {
        await repo.update(project.id, (p) => {
          p.composite.effect = input.effect.type;
          p.composite.subjectTrackIds = [trackId];
          if (input.effect.color) p.composite.backgroundColor = input.effect.color;
          if (input.effect.strength !== undefined) p.composite.blurStrength = input.effect.strength;
        });
      }
    }

    return {
      trackId,
      maskedFrames: masked,
      keyframe,
      effect: input.kind === "command" ? input.effect : undefined,
      provider: sam2.info.id,
      providerKind: sam2.info.kind,
    };
  } catch (err) {
    const e = toAppError(err, "SEGMENTATION_FAILED");
    await markCommand({ status: signal.aborted || e.code === "JOB_CANCELLED" ? "cancelled" : "failed", error: e });
    throw err;
  }
};
