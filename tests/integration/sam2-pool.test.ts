/**
 * The SAM 2 client against two real inference servers (inference/ with its
 * fake backend — the HTTP contract without a GPU): a video's session lives on
 * one server, and when that server dies the session moves to the other one.
 * Skipped when inference/.venv (pip install -r inference/requirements-dev.txt)
 * is missing.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VideoSource } from "@/services/ai/types";
import { SAM2Provider } from "@/services/sam2/SAM2Provider";
import { DEMO_VIDEO } from "../helpers/evalDemo";
import { freePort } from "../helpers/redis";

const PYTHON = path.join(process.cwd(), "inference", ".venv", "bin", "python");
const available = existsSync(PYTHON);

async function startInference(): Promise<{ url: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(PYTHON, ["-m", "uvicorn", "tests.fake_server:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warning"], {
    cwd: path.join(process.cwd(), "inference"),
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (proc.exitCode !== null) throw new Error("inference server exited");
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return { url, proc };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("inference server didn't start");
}

describe.skipIf(!available)("SAM 2 server pool against real inference servers", () => {
  const servers: Array<{ url: string; proc: ChildProcess }> = [];
  const source: VideoSource = {
    projectId: "prj_poolpoolpool",
    filePath: DEMO_VIDEO,
    version: "v1",
    width: 960,
    height: 540,
    fps: 30,
    frameCount: 10,
    maskWidth: 16,
    maskHeight: 8,
  };

  beforeAll(async () => {
    servers.push(...(await Promise.all([startInference(), startInference()])));
  }, 60_000);

  afterAll(() => {
    for (const s of servers) if (s.proc.exitCode === null) s.proc.kill("SIGKILL");
  });

  it("moves a video's session to the surviving server when its server dies", async () => {
    const provider = new SAM2Provider({ baseUrl: servers.map((s) => s.url), timeoutMs: 10_000, sharedStorage: false, cooldownMs: 60_000 });
    const session = await provider.initializeVideo(source);
    const owner = provider.serverFor(session.id);
    const first = await provider.segmentFrame(session, { frameIndex: 2, points: [{ x: 0.5, y: 0.5, label: 1 }] });
    expect(first.mask.some((v) => v)).toBe(true);

    const dying = servers.find((s) => s.url === owner)!;
    dying.proc.kill("SIGKILL");
    await new Promise((r) => dying.proc.once("exit", r));

    // Same call: the client re-uploads the video to the other server and carries on.
    const again = await provider.segmentFrame(session, { frameIndex: 2, points: [{ x: 0.5, y: 0.5, label: 1 }] });
    expect([...again.mask]).toEqual([...first.mask]);
    expect(provider.serverFor(session.id)).not.toBe(owner);

    const frames: number[] = [];
    await provider.trackObject(session, { keyframes: [{ frameIndex: 0, points: [{ x: 0.5, y: 0.5, label: 1 }] }], startFrame: 0, endFrame: 9, direction: "both" }, {
      onFrame: (f) => void frames.push(f),
    });
    expect(frames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect(await provider.health()).toMatchObject({ status: "degraded", details: { serversReady: 1, servers: 2 } });
  }, 60_000);
});
