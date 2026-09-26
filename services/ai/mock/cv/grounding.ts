import type { ColorName, TargetCategory } from "@/lib/schemas/command";
import { colorFractions } from "./color";
import { labelComponents, type Component, type Labeling } from "./components";

/**
 * Heuristic text grounding for the mock provider.
 *
 * There is no vision-language model here: candidates are moving blobs from
 * background subtraction, scored by shape priors (a standing person is tall,
 * a car is wide), named-color coverage, and clothing-region color. Real
 * deployments replace this with an open-vocabulary detector (see the Python
 * inference server's /ground endpoint) feeding boxes to SAM 2.
 */

export interface GroundingQuery {
  category: TargetCategory;
  noun?: string;
  colors: ColorName[];
  clothing: Array<{ item: string; color?: ColorName }>;
}

export interface Candidate {
  component: Component;
  score: number;
  categoryScore: number;
  colorScore: number;
  box: { x0: number; y0: number; x1: number; y1: number };
  /** An interior point (normalized) guaranteed to be on the object. */
  point: { x: number; y: number };
  label: string;
}

const UPPER = new Set(["shirt", "t-shirt", "tshirt", "jacket", "coat", "hoodie", "sweater", "top", "blouse", "jersey", "vest", "dress", "suit", "uniform"]);
const LOWER = new Set(["pants", "jeans", "shorts", "skirt", "trousers", "leggings"]);
const HEAD = new Set(["hat", "cap", "helmet", "beanie", "hair", "scarf"]);

function categoryScore(category: TargetCategory, c: Component, imageArea: number): number {
  const bw = c.maxX - c.minX + 1;
  const bh = c.maxY - c.minY + 1;
  const aspect = bh / bw;
  const rel = c.area / imageArea;
  switch (category) {
    case "person":
      return aspect >= 1.6 ? 1 : aspect >= 1.2 ? 0.55 : 0.1;
    case "vehicle": {
      const shape = aspect <= 0.6 ? 1 : aspect <= 0.85 ? 0.45 : 0.1;
      return Math.min(1, shape * (rel > 0.01 ? 1 : 0.6));
    }
    case "animal":
      return aspect >= 0.55 && aspect <= 1.15 ? 0.9 : aspect < 0.55 ? 0.3 : 0.25;
    default:
      return 0.6;
  }
}

function regionRows(item: string, c: Component): [number, number] | undefined {
  const bh = c.maxY - c.minY + 1;
  if (UPPER.has(item)) return [c.minY + Math.round(bh * 0.18), c.minY + Math.round(bh * 0.55)];
  if (LOWER.has(item)) return [c.minY + Math.round(bh * 0.5), c.maxY];
  if (HEAD.has(item)) return [c.minY, c.minY + Math.round(bh * 0.2)];
  return undefined;
}

function interiorPoint(lab: Labeling, c: Component, w: number): { x: number; y: number } {
  const cx = Math.round(c.cx);
  const cy = Math.round(c.cy);
  if (lab.labels[cy * w + cx] === c.label) return { x: cx, y: cy };
  // Search outward for the nearest pixel of the component.
  let best = { x: cx, y: cy };
  let bestD = Infinity;
  for (let y = c.minY; y <= c.maxY; y++) {
    for (let x = c.minX; x <= c.maxX; x++) {
      if (lab.labels[y * w + x] !== c.label) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

export function groundInForeground(
  frame: Uint8Array,
  fg: Uint8Array,
  w: number,
  h: number,
  query: GroundingQuery,
): Candidate[] {
  const minArea = Math.max(30, Math.round(w * h * 0.0008));
  const lab = labelComponents(fg, w, h, minArea);
  const imageArea = w * h;
  const out: Candidate[] = [];

  for (const c of lab.components) {
    const cat = categoryScore(query.category, c, imageArea);

    // Color evidence: explicit object colors use the whole blob; clothing
    // colors use the body region where that garment is worn.
    const wanted: Array<{ color: ColorName; rows?: [number, number] }> = [
      ...query.colors.map((color) => ({ color })),
      ...query.clothing.filter((g) => g.color).map((g) => ({ color: g.color!, rows: regionRows(g.item, c) })),
    ];
    let colorScore = 1;
    if (wanted.length) {
      const scores = wanted.map(({ color, rows }) => {
        const frac = colorFractions(frame, lab.labels, c.label, w, rows)[color] ?? 0;
        return Math.min(1, frac / (rows ? 0.35 : 0.25));
      });
      colorScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    const touchesEdge = c.minX <= 0 || c.minY <= 0 || c.maxX >= w - 1 || c.maxY >= h - 1;
    const visibility = touchesEdge ? 0.85 : 1;
    const salience = Math.min(1, Math.sqrt(c.area / (imageArea * 0.02)));
    let score = wanted.length
      ? (0.45 * cat + 0.45 * colorScore + 0.1 * salience) * visibility
      : (0.8 * cat + 0.2 * salience) * visibility;
    // A requested color that's essentially absent rules the candidate out
    // ("the purple car" must not match a red one).
    if (wanted.length && colorScore < 0.25) score *= 0.4;

    const pt = interiorPoint(lab, c, w);
    out.push({
      component: c,
      score,
      categoryScore: cat,
      colorScore,
      box: { x0: c.minX / w, y0: c.minY / h, x1: (c.maxX + 1) / w, y1: (c.maxY + 1) / h },
      point: { x: (pt.x + 0.5) / w, y: (pt.y + 0.5) / h },
      label: query.noun ?? query.category,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
