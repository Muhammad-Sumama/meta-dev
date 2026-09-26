import "server-only";
import { readFrameAt, readFrames } from "@/services/video/frames";
import type { VideoSource } from "./types";

/** Access to decoded analysis-resolution RGB frames. Injectable for tests. */
export interface FrameSource {
  readFrame(index: number, signal?: AbortSignal): Promise<Uint8Array>;
  stream(start: number, count: number, signal?: AbortSignal): AsyncIterable<{ index: number; data: Uint8Array }>;
}

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}

export function ffmpegFrameSource(source: VideoSource, cacheSize = 24): FrameSource {
  const cache = new LRU<number, Uint8Array>(cacheSize);
  const base = { width: source.maskWidth, height: source.maskHeight, fps: source.fps, pixelFormat: "rgb24" as const };
  return {
    async readFrame(index, signal) {
      const clamped = Math.max(0, Math.min(source.frameCount - 1, index));
      const hit = cache.get(clamped);
      if (hit) return hit;
      const data = new Uint8Array(await readFrameAt(source.filePath, clamped, { ...base, signal }));
      cache.set(clamped, data);
      return data;
    },
    async *stream(start, count, signal) {
      for await (const f of readFrames(source.filePath, { ...base, startFrame: start, count, signal })) {
        yield { index: f.index, data: new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength) };
      }
    },
  };
}
