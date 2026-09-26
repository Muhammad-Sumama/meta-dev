import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { decodeMask } from "@/lib/mask/rle";
import type { FrameSource } from "@/services/ai/frameSource";
import { MockSegmentationProvider } from "@/services/ai/mock/MockSegmentationProvider";
import type { VideoSession } from "@/services/ai/types";
import { normalizeCommand } from "@/services/llama/normalize";
import { parseWithRules } from "@/services/llama/rules";
import { groundingFrames, selectDetection } from "@/services/sam2/targeting";

const ROOT = path.resolve(__dirname, "..", "..");
export const DEMO_VIDEO = path.join(ROOT, "public", "demo", "street-scene.mp4");
export const GT_FILE = path.join(ROOT, "tests", "fixtures", "street-scene-gt.json");

interface GroundTruth {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  step: number;
  subjects: Record<string, Record<string, number[]>>;
}

export function ffmpegPath(): string {
  const req = createRequire(path.join(ROOT, "package.json"));
  return process.env.FFMPEG_PATH || (req("ffmpeg-static") as string);
}

/** Decodes the whole demo clip at w×h RGB (it's tiny: 300 frames). */
export async function decodeDemoFrames(w: number, h: number): Promise<Uint8Array[]> {
  const p = spawn(ffmpegPath(), ["-loglevel", "error", "-i", DEMO_VIDEO, "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const chunks: Buffer[] = [];
  for await (const c of p.stdout) chunks.push(c as Buffer);
  const all = Buffer.concat(chunks);
  const size = w * h * 3;
  const frames: Uint8Array[] = [];
  for (let i = 0; i + size <= all.length; i += size) frames.push(new Uint8Array(all.subarray(i, i + size)));
  return frames;
}

export function memoryFrameSource(frames: Uint8Array[]): FrameSource {
  return {
    async readFrame(i) {
      return frames[Math.max(0, Math.min(frames.length - 1, i))];
    },
    async *stream(start, count) {
      for (let i = start; i < Math.min(frames.length, start + count); i++) yield { index: i, data: frames[i] };
    },
  };
}

function iou(a: Uint8Array, b: Uint8Array) {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ? 1 : 0;
    const y = b[i] ? 1 : 0;
    inter += x & y;
    uni += x | y;
  }
  return uni === 0 ? 1 : inter / uni;
}

export const DEMO_COMMANDS: Record<string, string> = {
  red_car: "Track the red car",
  man_blue_shirt: "Track the man in the blue shirt",
  man_red_shirt: "Remove the man in the red shirt",
  dog: "Isolate the dog",
};

export interface SubjectReport {
  subject: string;
  command: string;
  keyframe: number;
  meanIoU: number;
  minIoU: number;
  worstFrame: number;
  perFrame: Record<number, number>;
  masks?: Map<number, Uint8Array>;
  detection?: unknown;
}

export async function evaluateDemo(opts: { verbose?: boolean; subjects?: string[]; keepMasks?: boolean } = {}): Promise<SubjectReport[]> {
  const gt = JSON.parse(readFileSync(GT_FILE, "utf8")) as GroundTruth;
  const { width: w, height: h } = gt;
  const frames = await decodeDemoFrames(w, h);
  const provider = new MockSegmentationProvider({ frameSourceFactory: () => memoryFrameSource(frames) });
  const session: VideoSession = await provider.initializeVideo({
    projectId: "prj_eval",
    filePath: DEMO_VIDEO,
    version: "eval",
    width: 960,
    height: 540,
    fps: gt.fps,
    frameCount: frames.length,
    maskWidth: w,
    maskHeight: h,
  });

  const reports: SubjectReport[] = [];
  for (const subject of opts.subjects ?? Object.keys(DEMO_COMMANDS)) {
    const text = DEMO_COMMANDS[subject];
    const cmd = normalizeCommand(parseWithRules(text));
    const t = cmd.target!;
    const dets = await provider.locateObjects(session, groundingFrames(frames.length, 0), {
      description: t.description,
      noun: t.noun,
      category: t.type,
      colors: t.attributes.colors,
      clothing: t.attributes.clothing,
      position: t.attributes.position,
      size: t.attributes.size,
    });
    const pick = selectDetection(dets, { position: t.attributes.position, size: t.attributes.size, preferredFrame: 0 });
    if (!pick) throw new Error(`No detection for ${subject}`);
    const seg = await provider.segmentFrame(session, {
      frameIndex: pick.frameIndex,
      box: pick.box,
      points: pick.point ? [{ ...pick.point, label: 1 }] : [],
    });
    const masks = new Map<number, Uint8Array>();
    await provider.trackObject(
      session,
      { keyframes: [{ frameIndex: seg.frameIndex, points: [], mask: seg.mask }], startFrame: 0, endFrame: frames.length - 1, direction: "both" },
      { onFrame: (i, m) => void (m ? masks.set(i, m) : masks.delete(i)) },
    );
    const perFrame: Record<number, number> = {};
    for (const [k, counts] of Object.entries(gt.subjects[subject])) {
      const f = Number(k);
      const truth = decodeMask(counts, w * h);
      perFrame[f] = iou(masks.get(f) ?? new Uint8Array(w * h), truth);
    }
    const vals = Object.values(perFrame);
    const minIoU = Math.min(...vals);
    const worstFrame = Number(Object.entries(perFrame).find(([, v]) => v === minIoU)![0]);
    const report: SubjectReport = {
      subject,
      command: text,
      keyframe: seg.frameIndex,
      meanIoU: vals.reduce((a, b) => a + b, 0) / vals.length,
      minIoU,
      worstFrame,
      perFrame,
      ...(opts.keepMasks ? { masks, detection: { pick, top: [...dets].sort((a, b) => b.score - a.score).slice(0, 5) } } : {}),
    };
    if (opts.verbose) {
      const low = Object.entries(perFrame)
        .filter(([, v]) => v < 0.7)
        .map(([f, v]) => `${f}:${v.toFixed(2)}`)
        .join(" ");
      if (low) console.log(`  ${subject} frames < 0.7 → ${low}`);
    }
    reports.push(report);
  }
  return reports;
}
