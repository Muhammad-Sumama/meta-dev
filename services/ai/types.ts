import type { ColorName, TargetCategory, TargetPosition } from "@/lib/schemas/command";
import type { BoxPrompt, FramePrompt, PointPrompt } from "@/lib/schemas/project";

/**
 * AI provider contracts.
 *
 *   AIProvider
 *   ├── language:     LanguageProvider      (LlamaProvider | MockLanguageProvider)
 *   └── segmentation: SegmentationProvider  (SAM2Provider  | MockSegmentationProvider)
 *
 * Application code talks to LlamaService / SAM2Service, which wrap these
 * providers with validation, timeouts and error mapping. Swapping mock for
 * production inference is a configuration change (see services/ai/registry.ts).
 */

export interface ProviderInfo {
  id: string;
  name: string;
  /** "mock" providers never claim model-quality results in the UI. */
  kind: "mock" | "production";
  description: string;
  model?: string;
}

export interface ProviderHealth {
  status: "ready" | "degraded" | "unavailable";
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface CallOptions {
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Language (natural language → structured command)
// ---------------------------------------------------------------------------
export interface LanguageRequest {
  text: string;
  /** Present on a repair attempt after the previous output failed validation. */
  previousOutput?: string;
  validationError?: string;
}

export interface LanguageProvider {
  readonly info: ProviderInfo;
  health(): Promise<ProviderHealth>;
  /**
   * Returns the model's raw answer. It is UNTRUSTED: LlamaService validates and
   * normalizes it against the command schema before anything acts on it.
   */
  interpret(request: LanguageRequest, opts?: CallOptions): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Segmentation (SAM 2 contract)
// ---------------------------------------------------------------------------
export interface VideoSource {
  projectId: string;
  /** Absolute path to the source video on this server. */
  filePath: string;
  /** Stable key that changes if the source file changes. */
  version: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** Masks are produced at this resolution. */
  maskWidth: number;
  maskHeight: number;
}

export interface VideoSession {
  id: string;
  providerId: string;
  source: VideoSource;
  width: number;
  height: number;
  /** Provider-specific diagnostics shown in developer tooling. */
  notes: string[];
}

export interface TargetQuery {
  description: string;
  noun?: string;
  category: TargetCategory;
  colors: ColorName[];
  clothing: Array<{ item: string; color?: ColorName }>;
  position?: TargetPosition;
  size?: "largest" | "smallest";
}

export interface Detection {
  frameIndex: number;
  /** Normalized box. */
  box: BoxPrompt;
  /** A normalized point on the object, if the provider knows one. */
  point?: { x: number; y: number };
  /** 0..1 match with the description (not including position/size constraints). */
  score: number;
  label: string;
}

export interface MaskResult {
  frameIndex: number;
  /** Binary mask, session.width × session.height. */
  mask: Uint8Array;
  score: number;
}

export interface TrackKeyframe {
  frameIndex: number;
  points: PointPrompt[];
  box?: BoxPrompt;
  mask?: Uint8Array;
}

export interface TrackRequest {
  keyframes: TrackKeyframe[];
  startFrame: number;
  endFrame: number;
  direction: "both" | "forward" | "backward";
}

export interface TrackCallbacks extends CallOptions {
  onFrame(frameIndex: number, mask: Uint8Array | null): void | Promise<void>;
  onProgress?(done: number, total: number): void;
}

export interface SegmentationProvider {
  readonly info: ProviderInfo;
  health(): Promise<ProviderHealth>;
  initializeVideo(
    source: VideoSource,
    opts?: CallOptions & { onProgress?: (fraction: number, message: string) => void },
  ): Promise<VideoSession>;
  /** Text grounding: find objects matching the query on the given frames. */
  locateObjects(session: VideoSession, frameIndices: number[], query: TargetQuery, opts?: CallOptions): Promise<Detection[]>;
  segmentFrame(session: VideoSession, prompt: FramePrompt, opts?: CallOptions): Promise<MaskResult>;
  refineMask(
    session: VideoSession,
    req: { frameIndex: number; mask: Uint8Array; points: PointPrompt[] },
    opts?: CallOptions,
  ): Promise<MaskResult>;
  trackObject(session: VideoSession, req: TrackRequest, callbacks: TrackCallbacks): Promise<void>;
  disposeVideo(session: VideoSession): Promise<void>;
}

export interface AIProvider {
  language: LanguageProvider;
  segmentation: SegmentationProvider;
}
