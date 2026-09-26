/**
 * Renders the landing-page "after" clip (public/demo/hero-output.mp4) by
 * driving a running OpenSAM Studio server through its public API — the same
 * path a user takes: demo project → AI commands → tracking → export.
 *
 *   npm run dev            # in another terminal
 *   npm run demo:hero      # BASE_URL defaults to http://localhost:3000
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";

async function call<T>(p: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${p}`, { ...init, headers: { "content-type": "application/json", ...init.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(`${p}: ${JSON.stringify(body)}`);
  return body as T;
}

async function waitJob(id: string) {
  for (;;) {
    const { job } = await call<{ job: { status: string; progress: { message: string }; error?: unknown } }>(`/api/jobs/${id}`);
    if (job.status === "completed") return;
    if (job.status === "failed" || job.status === "cancelled") throw new Error(`job ${id} ${job.status}: ${JSON.stringify(job.error)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const { project } = await call<{ project: { id: string } }>("/api/projects/demo", { method: "POST" });
  console.log("project", project.id);
  for (const text of ["Track the red car", "Track the man in the blue shirt", "Track the dog"]) {
    const res = await call<{ job: { id: string } | null }>(`/api/projects/${project.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ text, frameIndex: 0 }),
    });
    if (res.job) await waitJob(res.job.id);
    console.log("done:", text);
  }
  const exp = await call<{ job: { id: string }; exportId: string }>(`/api/projects/${project.id}/exports`, {
    method: "POST",
    body: JSON.stringify({
      settings: { kind: "video", format: "mp4_h264", resolution: "source", fps: "source", quality: "medium" },
      composite: { effect: "highlight", subjectTrackIds: [], backgroundColor: "#00b140", blurStrength: 0.5, dim: 0.7, feather: 1.5, expand: 1 },
    }),
  });
  await waitJob(exp.job.id);
  const file = await fetch(`${BASE}/api/projects/${project.id}/exports/${exp.exportId}`);
  const out = path.join(process.cwd(), "public", "demo", "hero-output.mp4");
  await writeFile(out, Buffer.from(await file.arrayBuffer()));
  await call(`/api/projects/${project.id}`, { method: "DELETE" });
  console.log("wrote", out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
