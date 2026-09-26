"use client";

import { decodeMask, maskForFrame, type RLECounts } from "@/lib/mask/rle";
import { hexToRgb } from "@/lib/compositing/effects";
import type { Track } from "@/lib/schemas/project";

/** Decoded masks cached by RLE array identity (arrays are immutable in the doc). */
const decodeCache = new WeakMap<RLECounts, Uint8Array>();

export function decodeCached(counts: RLECounts, n: number): Uint8Array {
  let m = decodeCache.get(counts);
  if (!m || m.length !== n) {
    m = decodeMask(counts, n);
    decodeCache.set(counts, m);
  }
  return m;
}

export function trackMaskAt(track: Track, frame: number): Uint8Array | null {
  const hit = maskForFrame(track.frames, frame, 0);
  return hit ? decodeCached(hit.counts, track.width * track.height) : null;
}

/**
 * Paints colored masks (+ outlines) for visible tracks into an ImageData at
 * mask resolution. The selected track is drawn last and slightly stronger.
 */
export function paintOverlay(
  image: ImageData,
  tracks: Track[],
  frame: number,
  opts: { selectedId: string | null; outlines: boolean; draft?: { trackId: string; mask: Uint8Array } | null },
) {
  const { width: w, height: h, data } = image;
  data.fill(0);
  const ordered = [...tracks].sort((a, b) => (a.id === opts.selectedId ? 1 : b.id === opts.selectedId ? -1 : 0));
  for (const t of ordered) {
    if (!t.visible || t.width !== w || t.height !== h) continue;
    const mask = opts.draft?.trackId === t.id ? opts.draft.mask : trackMaskAt(t, frame);
    if (!mask) continue;
    const [r, g, b] = hexToRgb(t.color);
    const selected = t.id === opts.selectedId;
    const fillA = selected ? 150 : 110;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (!mask[i]) continue;
        const edge =
          opts.outlines &&
          (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]);
        const q = i * 4;
        data[q] = r;
        data[q + 1] = g;
        data[q + 2] = b;
        data[q + 3] = edge ? 255 : fillA;
      }
    }
  }
}

/** Union of masks as a white-on-transparent ImageData (alpha source for effect preview). */
export function paintAlpha(image: ImageData, masks: Uint8Array[]) {
  const { data } = image;
  data.fill(0);
  for (const m of masks) {
    for (let i = 0; i < m.length; i++) {
      if (m[i]) {
        const q = i * 4;
        data[q] = 255;
        data[q + 1] = 255;
        data[q + 2] = 255;
        data[q + 3] = 255;
      }
    }
  }
}
