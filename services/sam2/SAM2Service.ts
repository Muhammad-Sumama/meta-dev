import "server-only";
import { AppError, toAppError } from "@/lib/errors";
import type { Target } from "@/lib/schemas/command";
import type { FramePrompt, PointPrompt, Project } from "@/lib/schemas/project";
import { mediaPath } from "../storage/paths";
import type {
  CallOptions,
  Detection,
  MaskResult,
  SegmentationProvider,
  TrackCallbacks,
  TrackKeyframe,
  VideoSession,
  VideoSource,
} from "../ai/types";
import { groundingFrames, selectDetection } from "./targeting";

/**
 * Application-facing segmentation API. Wraps whichever SegmentationProvider
 * is configured (SAM2Provider or MockSegmentationProvider) with session
 * caching, error mapping and the higher-level "text → mask sequence" flow.
 */
export class SAM2Service {
  private sessions = new Map<string, { session: Promise<VideoSession>; lastUsed: number }>();

  constructor(private readonly provider: SegmentationProvider) {}

  get info() {
    return this.provider.info;
  }

  health() {
    return this.provider.health();
  }

  static videoSource(project: Project): VideoSource {
    return {
      projectId: project.id,
      filePath: mediaPath(project.id, project.video.fileName),
      version: `${project.video.sizeBytes.toString(36)}${Date.parse(project.createdAt).toString(36)}`,
      width: project.video.width,
      height: project.video.height,
      fps: project.video.fps,
      frameCount: project.video.frameCount,
      maskWidth: project.analysis.width,
      maskHeight: project.analysis.height,
    };
  }

  /** Initializes (or reuses) the provider session for a project's video. */
  async initializeVideo(
    project: Project,
    opts: CallOptions & { onProgress?: (fraction: number, message: string) => void } = {},
  ): Promise<VideoSession> {
    const key = `${project.id}:${project.analysis.width}x${project.analysis.height}`;
    const cached = this.sessions.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      try {
        return await cached.session;
      } catch {
        this.sessions.delete(key);
      }
    }
    const session = this.provider
      .initializeVideo(SAM2Service.videoSource(project), opts)
      .catch((err) => {
        this.sessions.delete(key);
        throw this.map(err, "SEGMENTATION_FAILED");
      });
    this.sessions.set(key, { session, lastUsed: Date.now() });
    this.evict();
    return session;
  }

  private evict() {
    const cutoff = Date.now() - 20 * 60_000;
    for (const [k, v] of this.sessions) {
      if (v.lastUsed < cutoff) {
        this.sessions.delete(k);
        v.session.then((s) => this.provider.disposeVideo(s)).catch(() => undefined);
      }
    }
  }

  async disposeProject(projectId: string) {
    for (const [k, v] of this.sessions) {
      if (k.startsWith(`${projectId}:`)) {
        this.sessions.delete(k);
        v.session.then((s) => this.provider.disposeVideo(s)).catch(() => undefined);
      }
    }
  }

  private map(err: unknown, fallback: "SEGMENTATION_FAILED" | "TRACKING_FAILED"): AppError {
    const e = toAppError(err, fallback);
    if (!(err instanceof AppError) && e.code === fallback) console.error(`[sam2] ${fallback}:`, err);
    return e;
  }

  /** Text grounding: finds the object described by `target`, preferring the current frame. */
  async locateTarget(
    project: Project,
    target: Target,
    preferredFrame: number,
    opts: CallOptions & { range?: { start: number; end: number } } = {},
  ): Promise<Detection> {
    const session = await this.initializeVideo(project, opts);
    const frames = groundingFrames(project.video.frameCount, preferredFrame, 8, opts.range);
    let detections: Detection[];
    try {
      detections = await this.provider.locateObjects(
        session,
        frames,
        {
          description: target.description,
          noun: target.noun,
          category: target.type,
          colors: target.attributes.colors,
          clothing: target.attributes.clothing,
          position: target.attributes.position,
          size: target.attributes.size,
        },
        opts,
      );
    } catch (err) {
      throw this.map(err, "SEGMENTATION_FAILED");
    }
    const pick = selectDetection(detections, {
      position: target.attributes.position,
      size: target.attributes.size,
      preferredFrame,
    });
    if (!pick) {
      throw new AppError("TARGET_NOT_FOUND", {
        message: `We couldn't find “${target.description}” in this video.`,
        hint:
          this.provider.info.kind === "mock"
            ? "Mock mode understands people, animals, vehicles, colors and positions on static-camera shots. Try clicking the object with the Select tool instead."
            : "Try describing it differently, or click the object with the Select tool.",
      });
    }
    return pick;
  }

  async segmentFrame(project: Project, prompt: FramePrompt, opts: CallOptions = {}): Promise<MaskResult> {
    if (prompt.frameIndex >= project.video.frameCount) throw new AppError("VALIDATION_ERROR", { message: "That frame is outside the video." });
    const session = await this.initializeVideo(project, opts);
    try {
      return await this.provider.segmentFrame(session, prompt, opts);
    } catch (err) {
      throw this.map(err, "SEGMENTATION_FAILED");
    }
  }

  async refineMask(project: Project, frameIndex: number, mask: Uint8Array, points: PointPrompt[], opts: CallOptions = {}) {
    const session = await this.initializeVideo(project, opts);
    try {
      return await this.provider.refineMask(session, { frameIndex, mask, points }, opts);
    } catch (err) {
      throw this.map(err, "SEGMENTATION_FAILED");
    }
  }

  async trackObject(
    project: Project,
    req: { keyframes: TrackKeyframe[]; startFrame: number; endFrame: number; direction: "both" | "forward" | "backward" },
    cb: TrackCallbacks,
  ): Promise<void> {
    const session = await this.initializeVideo(project, { signal: cb.signal });
    const last = project.video.frameCount - 1;
    try {
      await this.provider.trackObject(
        session,
        { ...req, startFrame: Math.max(0, req.startFrame), endFrame: Math.min(last, req.endFrame) },
        cb,
      );
    } catch (err) {
      throw this.map(err, "TRACKING_FAILED");
    }
  }

  /**
   * Full pipeline used by AI commands:
   * locate target → segment keyframe → propagate through the range.
   */
  async generateMaskSequence(
    project: Project,
    req: { target: Target; preferredFrame: number; startFrame: number; endFrame: number; tracking: boolean },
    cb: TrackCallbacks & { onStage?: (stage: "locating" | "segmenting" | "tracking", message: string) => void },
  ): Promise<{ detection: Detection; keyframe: MaskResult }> {
    cb.onStage?.("locating", `Looking for “${req.target.description}”…`);
    const detection = await this.locateTarget(project, req.target, req.preferredFrame, {
      signal: cb.signal,
      range: { start: req.startFrame, end: req.endFrame },
    });
    cb.onStage?.("segmenting", "Creating the mask…");
    const keyframe = await this.segmentFrame(
      project,
      {
        frameIndex: detection.frameIndex,
        box: detection.box,
        points: detection.point ? [{ ...detection.point, label: 1 }] : [],
      },
      cb,
    );
    if (!req.tracking) {
      await cb.onFrame(keyframe.frameIndex, keyframe.mask);
      return { detection, keyframe };
    }
    cb.onStage?.("tracking", "Tracking through the video…");
    await this.trackObject(
      project,
      {
        keyframes: [{ frameIndex: keyframe.frameIndex, points: [], mask: keyframe.mask }],
        startFrame: req.startFrame,
        endFrame: req.endFrame,
        direction: "both",
      },
      cb,
    );
    return { detection, keyframe };
  }
}
