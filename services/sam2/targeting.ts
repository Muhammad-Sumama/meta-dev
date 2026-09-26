import type { TargetPosition } from "@/lib/schemas/command";
import type { Detection } from "../ai/types";

/**
 * Chooses one detection using spatial constraints from the command
 * ("on the left", "the biggest"). Shared by mock and production grounding:
 * detectors answer "what matches the words", this answers "which one".
 */

function positionScore(pos: TargetPosition, cx: number, cy: number, bottom: number): number {
  switch (pos) {
    case "left":
      return 1 - cx;
    case "right":
      return cx;
    case "center":
      return 1 - Math.min(1, Math.hypot(cx - 0.5, (cy - 0.5) * 0.6) * 2);
    case "top":
      return 1 - cy;
    case "bottom":
      return cy;
    case "top_left":
      return 1 - (cx + cy) / 2;
    case "top_right":
      return (cx + 1 - cy) / 2;
    case "bottom_left":
      return (1 - cx + cy) / 2;
    case "bottom_right":
      return (cx + cy) / 2;
    case "foreground":
      return bottom;
    case "background":
      return 1 - bottom;
  }
}

export interface SelectOptions {
  position?: TargetPosition;
  size?: "largest" | "smallest";
  preferredFrame: number;
  minScore?: number;
}

export function selectDetection(detections: Detection[], opts: SelectOptions): Detection | null {
  const minScore = opts.minScore ?? 0.35;
  const viable = detections.filter((d) => d.score >= minScore);
  if (!viable.length) return null;

  const byFrame = new Map<number, Detection[]>();
  for (const d of viable) {
    const list = byFrame.get(d.frameIndex) ?? [];
    list.push(d);
    byFrame.set(d.frameIndex, list);
  }

  let best: { d: Detection; score: number } | null = null;
  for (const [frame, list] of byFrame) {
    const top = Math.max(...list.map((d) => d.score));
    // Only candidates that match the words nearly as well as the best one
    // compete on position/size ("the man on the left" among men).
    const peers = list.filter((d) => d.score >= top * 0.75);
    const areas = peers.map((d) => (d.box.x1 - d.box.x0) * (d.box.y1 - d.box.y0));
    const maxArea = Math.max(...areas);
    const minArea = Math.min(...areas);
    for (const [i, d] of peers.entries()) {
      const cx = (d.box.x0 + d.box.x1) / 2;
      const cy = (d.box.y0 + d.box.y1) / 2;
      let s = d.score;
      if (opts.position) {
        const ps = positionScore(opts.position, cx, cy, d.box.y1);
        const rank = peers.length > 1 ? peers.filter((o) => positionScore(opts.position!, (o.box.x0 + o.box.x1) / 2, (o.box.y0 + o.box.y1) / 2, o.box.y1) > ps).length : 0;
        s = 0.55 * d.score + 0.3 * ps + (rank === 0 ? 0.15 : 0);
      }
      if (opts.size && peers.length > 1 && maxArea > minArea) {
        const rel = (areas[i] - minArea) / (maxArea - minArea);
        s += 0.15 * (opts.size === "largest" ? rel : 1 - rel);
      }
      // Mild preference for the frame the user is looking at.
      if (frame === opts.preferredFrame) s += 0.04;
      if (!best || s > best.score) best = { d, score: s };
    }
  }
  return best?.d ?? null;
}

/** Frames to search: the current frame first, then evenly spaced samples. */
export function groundingFrames(frameCount: number, preferred: number, samples = 8, range?: { start: number; end: number }): number[] {
  const start = range?.start ?? 0;
  const end = range?.end ?? frameCount - 1;
  const frames = new Set<number>();
  frames.add(Math.min(end, Math.max(start, preferred)));
  const span = end - start + 1;
  for (let i = 0; i < samples - 1; i++) frames.add(start + Math.floor(((i + 0.5) * span) / (samples - 1)));
  return [...frames].filter((f) => f >= start && f <= end);
}
