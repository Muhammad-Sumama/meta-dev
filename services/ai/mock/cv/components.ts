import type { Mask } from "./morphology";

export interface Component {
  label: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
}

export interface Labeling {
  labels: Int32Array;
  components: Component[];
}

/** 8-connected component labeling (BFS). Label 0 = background; components are 1-based. */
export function labelComponents(mask: Mask, w: number, h: number, minArea = 1): Labeling {
  const n = w * h;
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  const components: Component[] = [];
  let next = 1;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = next++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    let areaCount = 0;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let sx = 0;
    let sy = 0;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i / w) | 0;
      areaCount++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (mask[j] && !labels[j]) {
            labels[j] = label;
            queue[tail++] = j;
          }
        }
      }
    }
    components.push({ label, area: areaCount, minX, minY, maxX, maxY, cx: sx / areaCount, cy: sy / areaCount });
  }
  if (minArea > 1) {
    const small = new Set(components.filter((c) => c.area < minArea).map((c) => c.label));
    if (small.size) {
      for (let i = 0; i < n; i++) if (small.has(labels[i])) labels[i] = 0;
    }
    return { labels, components: components.filter((c) => c.area >= minArea) };
  }
  return { labels, components };
}

export function componentMask(labeling: Labeling, labelSet: Set<number> | number): Mask {
  const { labels } = labeling;
  const out = new Uint8Array(labels.length);
  if (typeof labelSet === "number") {
    for (let i = 0; i < labels.length; i++) out[i] = labels[i] === labelSet ? 1 : 0;
  } else {
    for (let i = 0; i < labels.length; i++) out[i] = labelSet.has(labels[i]) ? 1 : 0;
  }
  return out;
}

/** Keeps only components with area ≥ minArea. */
export function removeSmall(mask: Mask, w: number, h: number, minArea: number): Mask {
  const lab = labelComponents(mask, w, h, minArea);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = lab.labels[i] ? 1 : 0;
  return out;
}

export function largestComponent(mask: Mask, w: number, h: number): Mask {
  const lab = labelComponents(mask, w, h);
  if (!lab.components.length) return new Uint8Array(mask.length);
  const best = lab.components.reduce((a, b) => (b.area > a.area ? b : a));
  return componentMask(lab, best.label);
}
