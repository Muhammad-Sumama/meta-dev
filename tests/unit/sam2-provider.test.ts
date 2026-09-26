import { describe, expect, it, vi } from "vitest";
import { encodeMask } from "@/lib/mask/rle";
import type { VideoSession } from "@/services/ai/types";
import { SAM2Provider } from "@/services/sam2/SAM2Provider";
import { groundingFrames, selectDetection } from "@/services/sam2/targeting";

const W = 8;
const H = 4;
const session: VideoSession = {
  id: "prj_test-v1",
  providerId: "sam2",
  width: W,
  height: H,
  notes: [],
  source: { projectId: "prj_test", filePath: "/tmp/x.mp4", version: "v1", width: 16, height: 8, fps: 30, frameCount: 10, maskWidth: W, maskHeight: H },
};

function mask(on: number[]) {
  const m = new Uint8Array(W * H);
  for (const i of on) m[i] = 1;
  return m;
}

function sam2(fetchImpl: typeof fetch, timeoutMs = 2000) {
  return new SAM2Provider({ baseUrl: "http://gpu.test:8008", apiKey: "k", timeoutMs, sharedStorage: true, fetchImpl });
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("SAM2Provider (HTTP contract)", () => {
  it("sends point/box prompts and decodes RLE masks", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://gpu.test:8008/v1/sessions/prj_test-v1/segment");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ frame_index: 3, points: [[0.5, 0.25]], labels: [1], box: [0.1, 0.1, 0.9, 0.9] });
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
      return json({ frame_index: 3, score: 0.97, mask: { counts: encodeMask(mask([1, 2, 9])), size: [H, W] } });
    }) as unknown as typeof fetch;
    const res = await sam2(fetchImpl).segmentFrame(session, { frameIndex: 3, points: [{ x: 0.5, y: 0.25, label: 1 }], box: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 } });
    expect(res.score).toBe(0.97);
    expect([...res.mask].map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([1, 2, 9]);
  });

  it("rejects masks with the wrong size", async () => {
    const p = sam2((async () => json({ score: 1, mask: { counts: [5, 5], size: [2, 5] } })) as unknown as typeof fetch);
    await expect(p.segmentFrame(session, { frameIndex: 0, points: [{ x: 0, y: 0, label: 1 }] })).rejects.toMatchObject({ code: "INVALID_AI_RESPONSE" });
  });

  it("streams propagation results as NDJSON", async () => {
    const lines = [
      { type: "progress", done: 1, total: 3 },
      { type: "mask", frame_index: 0, counts: encodeMask(mask([0])) },
      { type: "mask", frame_index: 1, counts: encodeMask(mask([])) },
      { type: "progress", done: 3, total: 3 },
      { type: "done" },
    ];
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    // Deliver in awkward chunk sizes to exercise line buffering.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const p = sam2((async () => new Response(stream, { status: 200 })) as unknown as typeof fetch);
    const frames: Array<[number, boolean]> = [];
    const progress: number[] = [];
    await p.trackObject(
      session,
      { keyframes: [{ frameIndex: 0, points: [], mask: mask([0]) }], startFrame: 0, endFrame: 2, direction: "both" },
      { onFrame: (i, m) => void frames.push([i, m !== null]), onProgress: (d) => progress.push(d) },
    );
    expect(frames).toEqual([
      [0, true],
      [1, false],
    ]);
    expect(progress).toEqual([1, 3]);
  });

  it("fails if the stream ends without `done` or reports an error", async () => {
    const p1 = sam2((async () => new Response('{"type":"progress","done":1,"total":2}\n')) as unknown as typeof fetch);
    await expect(p1.trackObject(session, { keyframes: [], startFrame: 0, endFrame: 1, direction: "both" }, { onFrame: () => {} })).rejects.toMatchObject({ code: "TRACKING_FAILED" });
    const p2 = sam2((async () => new Response('{"type":"error","message":"CUDA out of memory"}\n')) as unknown as typeof fetch);
    await expect(p2.trackObject(session, { keyframes: [], startFrame: 0, endFrame: 1, direction: "both" }, { onFrame: () => {} })).rejects.toMatchObject({ code: "TRACKING_FAILED" });
  });

  it("maps server states to friendly errors", async () => {
    const cases: Array<[Response | Error, string]> = [
      [json({}, 401), "MODEL_UNAVAILABLE"],
      [json({}, 503), "MODEL_UNAVAILABLE"],
      [json({}, 507), "INSUFFICIENT_RESOURCES"],
      [new TypeError("fetch failed"), "MODEL_UNAVAILABLE"],
    ];
    for (const [r, code] of cases) {
      const p = sam2((async () => {
        if (r instanceof Error) throw r;
        return r;
      }) as unknown as typeof fetch);
      await expect(p.segmentFrame(session, { frameIndex: 0, points: [{ x: 0, y: 0, label: 1 }] })).rejects.toMatchObject({ code });
    }
  });

  it("reports health", async () => {
    const ok = await sam2((async () => json({ status: "ok", model: "sam2.1_hiera_large", device: "cuda" })) as unknown as typeof fetch).health();
    expect(ok.status).toBe("ready");
    expect(ok.message).toMatch(/cuda/);
    const down = await sam2((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch).health();
    expect(down.status).toBe("unavailable");
  });

  it("reuses an existing server session", async () => {
    const calls: string[] = [];
    const p = sam2((async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return json({ session_id: "x" });
    }) as unknown as typeof fetch);
    await p.initializeVideo(session.source);
    expect(calls).toEqual(["GET http://gpu.test:8008/v1/sessions/prj_test-v1"]);
  });
});

describe("detection targeting", () => {
  const det = (x: number, score = 0.8, w = 0.1) => ({ frameIndex: 0, box: { x0: x, y0: 0.4, x1: x + w, y1: 0.8 }, score, label: "person" });

  it("picks by position among similar matches", () => {
    expect(selectDetection([det(0.7), det(0.1), det(0.4)], { position: "left", preferredFrame: 0 })!.box.x0).toBe(0.1);
    expect(selectDetection([det(0.7), det(0.1), det(0.4)], { position: "right", preferredFrame: 0 })!.box.x0).toBe(0.7);
    expect(selectDetection([det(0.1), det(0.45), det(0.8)], { position: "center", preferredFrame: 0 })!.box.x0).toBe(0.45);
  });

  it("picks by size and ignores weak matches", () => {
    expect(selectDetection([det(0.1, 0.8, 0.05), det(0.5, 0.8, 0.3)], { size: "largest", preferredFrame: 0 })!.box.x0).toBe(0.5);
    expect(selectDetection([det(0.1, 0.2)], { preferredFrame: 0 })).toBeNull();
  });

  it("samples grounding frames starting at the current frame", () => {
    const frames = groundingFrames(300, 120, 8);
    expect(frames[0]).toBe(120);
    expect(new Set(frames).size).toBe(frames.length);
    expect(Math.max(...frames)).toBeLessThan(300);
  });
});
