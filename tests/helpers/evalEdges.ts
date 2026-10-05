import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAlpha, growMask } from "@/lib/compositing/alpha";
import { refineAlpha, refineRadiusFor } from "@/lib/compositing/refine";
import { decodeMask } from "@/lib/mask/rle";
import { decodeDemoFrames, evaluateDemo } from "./evalDemo";

export const GT_FULL_FILE = path.join(process.cwd(), "tests", "fixtures", "street-scene-gt-full.json");

export interface EdgeScore {
  /** Mean |alpha − truth| (0..1) within 3 px of the true boundary. */
  edgeError: number;
  /** IoU of alpha ≥ 50% vs truth at full resolution. */
  iou: number;
}

export interface EdgeRow {
  source: "truth" | "tracked";
  subject: string;
  baseline: EdgeScore;
  refined: EdgeScore;
}

const MW = 512;
const MH = 288;
const FEATHER = 2; // the default Composite.feather

/** Area-majority downsample of a binary mask (what a perfect analysis-resolution mask would be). */
function downsample(full: Uint8Array, W: number, H: number, w: number, h: number) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx0 = Math.floor((x * W) / w), fx1 = Math.max(fx0 + 1, Math.floor(((x + 1) * W) / w));
      const fy0 = Math.floor((y * H) / h), fy1 = Math.max(fy0 + 1, Math.floor(((y + 1) * H) / h));
      let on = 0;
      for (let yy = fy0; yy < fy1; yy++) for (let xx = fx0; xx < fx1; xx++) on += full[yy * W + xx];
      out[y * w + x] = on * 2 >= (fx1 - fx0) * (fy1 - fy0) ? 1 : 0;
    }
  }
  return out;
}

function score(alpha: Uint8Array, truth: Uint8Array, band: Uint8Array): EdgeScore {
  let err = 0;
  let count = 0;
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < truth.length; i++) {
    const a = alpha[i] >= 128 ? 1 : 0;
    inter += a & truth[i];
    uni += a | truth[i];
    if (band[i]) {
      err += Math.abs(alpha[i] / 255 - truth[i]);
      count++;
    }
  }
  return { edgeError: count ? err / count : 0, iou: uni ? inter / uni : 1 };
}

/** Edge accuracy of the export alpha, with and without refinement, per subject (averaged over sampled frames). */
export async function evaluateEdges(opts: { eps?: number; radius?: number; verbose?: boolean } = {}): Promise<EdgeRow[]> {
  const gt = JSON.parse(readFileSync(GT_FULL_FILE, "utf8")) as { width: number; height: number; subjects: Record<string, Record<string, number[]>> };
  const { width: W, height: H } = gt;
  const rgb = await decodeDemoFrames(W, H);
  const tracked = await evaluateDemo({ keepMasks: true });
  const trackedMasks = Object.fromEntries(tracked.map((r) => [r.subject, r.masks!]));
  const radius = opts.radius ?? refineRadiusFor(MH, H, (FEATHER * H) / H);

  const rows: EdgeRow[] = [];
  for (const source of ["truth", "tracked"] as const) {
    for (const [subject, frames] of Object.entries(gt.subjects)) {
      const sums = { b: { edgeError: 0, iou: 0 }, r: { edgeError: 0, iou: 0 } };
      let n = 0;
      for (const [k, counts] of Object.entries(frames)) {
        const f = Number(k);
        const truth = decodeMask(counts, W * H);
        if (!truth.some((v) => v)) continue;
        const mask = source === "truth" ? downsample(truth, W, H, MW, MH) : trackedMasks[subject]?.get(f);
        if (!mask) continue;
        const rgba = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) {
          rgba[i * 4] = rgb[f][i * 3];
          rgba[i * 4 + 1] = rgb[f][i * 3 + 1];
          rgba[i * 4 + 2] = rgb[f][i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        const band = growMask(truth, W, H, 3);
        const inner = growMask(truth, W, H, -3);
        for (let i = 0; i < band.length; i++) band[i] = band[i] && !inner[i] ? 1 : 0;
        const baseline = buildAlpha([mask], MW, MH, W, H, { expand: 0, feather: FEATHER, sourceHeight: H });
        const refined = refineAlpha(baseline, rgba, W, H, { radius, eps: opts.eps });
        const b = score(baseline, truth, band);
        const r = score(refined, truth, band);
        sums.b.edgeError += b.edgeError;
        sums.b.iou += b.iou;
        sums.r.edgeError += r.edgeError;
        sums.r.iou += r.iou;
        n++;
      }
      if (!n) continue;
      rows.push({
        source,
        subject,
        baseline: { edgeError: sums.b.edgeError / n, iou: sums.b.iou / n },
        refined: { edgeError: sums.r.edgeError / n, iou: sums.r.iou / n },
      });
    }
  }
  return rows;
}
