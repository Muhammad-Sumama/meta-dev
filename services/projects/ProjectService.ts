import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppError, toAppError } from "@/lib/errors";
import { encodeMask } from "@/lib/mask/rle";
import type { CommandRequest, ExportRequest, SegmentRequest, TrackRequest } from "@/lib/schemas/api";
import type { EditingPlan, ParsedCommand } from "@/lib/schemas/command";
import type { Job } from "@/lib/schemas/job";
import type { CommandRecord, Project, Track, TrackSummary } from "@/lib/schemas/project";
import { newId } from "@/lib/utils/ids";
import { getAIServices } from "../ai/registry";
import { FORMAT_SPECS } from "../export/formats";
import { getJobQueue } from "../jobs/runtime";
import { assertDiskSpace, writeJsonAtomic } from "../storage/fs";
import { exportsDir, mediaPath, tmpDir } from "../storage/paths";
import { createProjectFromFile, receiveUpload } from "../video/upload";
import { sniffContainer } from "@/lib/validation/upload";
import { getProjectRepository, requireProject } from "./index";
import type { SegmentJobInput } from "@/workers/segmentation.worker";
import type { ExportJobInput } from "../export/ExportService";

/**
 * Application use-cases behind the API routes. Route handlers validate
 * input shape; this layer enforces business rules and orchestrates
 * repositories, AI services and jobs.
 */

export interface ProjectBundle {
  project: Project;
  tracks: TrackSummary[];
  jobs: Job[];
}

async function recordJob(projectId: string, jobId: string) {
  await getProjectRepository().update(projectId, (p) => {
    p.jobIds = [...p.jobIds, jobId].slice(-500);
  });
}

function enqueueIngest(project: Project) {
  return getJobQueue().enqueue({ type: "ingest", projectId: project.id, label: "Preparing video", input: { projectId: project.id } });
}

export async function createProjectFromUpload(request: Request): Promise<{ project: Project; job: Job }> {
  const encodedName = request.headers.get("x-file-name");
  if (!encodedName) throw new AppError("VALIDATION_ERROR", { message: "Missing file name." });
  let originalName: string;
  try {
    originalName = decodeURIComponent(encodedName).slice(0, 255);
  } catch {
    throw new AppError("VALIDATION_ERROR", { message: "Invalid file name." });
  }
  const declared = Number(request.headers.get("content-length") ?? NaN);
  const received = await receiveUpload(request.body, {
    originalName,
    declaredSize: Number.isFinite(declared) ? declared : undefined,
    signal: request.signal,
  });
  const project = await createProjectFromFile({ path: received.tmpPath, size: received.size, container: received.container, originalName });
  const job = await enqueueIngest(project);
  await recordJob(project.id, job.id);
  return { project, job };
}

export async function createDemoProject(): Promise<{ project: Project; job: Job }> {
  const demoPath = path.join(process.cwd(), "public", "demo", "street-scene.mp4");
  let head: Buffer;
  let size: number;
  try {
    const fh = await fs.open(demoPath, "r");
    try {
      head = Buffer.alloc(64);
      await fh.read(head, 0, 64, 0);
      size = (await fh.stat()).size;
    } finally {
      await fh.close();
    }
  } catch {
    throw new AppError("NOT_FOUND", { message: "The demo video is missing.", hint: "Run `npm run demo:generate` to recreate it." });
  }
  await assertDiskSpace(tmpDir());
  const container = sniffContainer(head) ?? "mp4";
  const project = await createProjectFromFile(
    { path: demoPath, size, container, originalName: "street-scene.mp4", keepSource: true },
    { isDemo: true, name: "Demo — Street scene" },
  );
  // Ship the pre-encoded VP9 preview so browsers without H.264 open the demo instantly.
  const webm = path.join(process.cwd(), "public", "demo", "street-scene.webm");
  let finalProject = project;
  try {
    await fs.copyFile(webm, mediaPath(project.id, "proxy-vp9.webm"));
    finalProject = await getProjectRepository().update(project.id, (p) => {
      p.media.vp9Proxy = { status: "ready", fileName: "proxy-vp9.webm" };
    });
  } catch {
    /* optional asset; generated on demand instead */
  }
  const job = await enqueueIngest(finalProject);
  await recordJob(project.id, job.id);
  return { project: finalProject, job };
}

/** Starts (or reuses) VP9 preview generation for browsers that can't play H.264. */
export async function requestVp9Proxy(projectId: string): Promise<{ project: Project; job: Job | null }> {
  const project = await requireProject(projectId);
  const status = project.media.vp9Proxy.status;
  if (status === "ready") return { project, job: null };
  const queue = getJobQueue();
  if (status === "pending") {
    const active = (await queue.list({ projectId, activeOnly: true })).find(
      (j) => j.type === "ingest" && (j.input as { task?: string }).task === "vp9_proxy",
    );
    if (active) return { project, job: active };
  }
  const updated = await getProjectRepository().update(projectId, (p) => {
    p.media.vp9Proxy = { status: "pending" };
  });
  const job = await queue.enqueue({ type: "ingest", projectId, label: "Preparing browser preview", input: { projectId, task: "vp9_proxy" } });
  await recordJob(projectId, job.id);
  return { project: updated, job };
}

export async function getProjectBundle(projectId: string): Promise<ProjectBundle> {
  const project = await requireProject(projectId);
  const [tracks, jobs] = await Promise.all([
    getProjectRepository().listTracks(projectId),
    getJobQueue().list({ projectId }),
  ]);
  return { project, tracks, jobs: jobs.slice(0, 30) };
}

export async function deleteProject(projectId: string) {
  await requireProject(projectId);
  const queue = getJobQueue();
  for (const j of await queue.list({ projectId, activeOnly: true })) await queue.cancel(j.id);
  await getAIServices().sam2.disposeProject(projectId);
  await getProjectRepository().delete(projectId);
}

// ---------------------------------------------------------------------------
// AI commands
// ---------------------------------------------------------------------------
export interface CommandResponse {
  record: CommandRecord;
  parsed: ParsedCommand;
  plan: EditingPlan;
  job: Job | null;
}

export async function runCommand(projectId: string, req: CommandRequest, signal?: AbortSignal): Promise<CommandResponse> {
  const repo = getProjectRepository();
  const project = await requireProject(projectId);
  const { llama } = getAIServices();

  if (req.selectedTrackId && !(await repo.getTrack(projectId, req.selectedTrackId))) {
    throw new AppError("NOT_FOUND", { message: "The selected object no longer exists." });
  }
  const tracks = await repo.listTracks(projectId);
  const record: CommandRecord = {
    id: newId("cmd"),
    text: req.text,
    createdAt: new Date().toISOString(),
    command: null,
    status: "parsed",
    warnings: [],
  };

  let parsed: ParsedCommand;
  let plan: EditingPlan;
  try {
    parsed = await llama.parseCommand(req.text, { signal });
    plan = llama.generateEditingPlan(parsed.command, {
      fps: project.video.fps,
      frameCount: project.video.frameCount,
      frameIndex: Math.min(req.frameIndex, project.video.frameCount - 1),
      selectedTrackId: req.selectedTrackId,
      trackCount: tracks.length,
    });
  } catch (err) {
    const e = toAppError(err);
    record.status = "failed";
    record.error = { code: e.code, message: e.message, hint: e.hint, retryable: e.retryable };
    await repo.update(projectId, (p) => {
      p.commands = [...p.commands, record].slice(-200);
    });
    throw e;
  }

  record.command = parsed.command;
  record.source = parsed.source;
  record.model = parsed.model;
  record.planSummary = plan.summary;
  record.warnings = parsed.warnings;

  let job: Job | null = null;
  if (plan.requiresSegmentation && parsed.command.target) {
    const track = plan.steps.find((s) => s.kind === "track");
    const last = project.video.frameCount - 1;
    const startFrame = track?.kind === "track" ? track.startFrame : Math.min(req.frameIndex, last);
    const endFrame = track?.kind === "track" ? track.endFrame : Math.min(req.frameIndex, last);
    const input: SegmentJobInput = {
      kind: "command",
      commandId: record.id,
      text: req.text,
      target: parsed.command.target,
      tracking: parsed.command.tracking,
      preferredFrame: Math.min(req.frameIndex, last),
      startFrame,
      endFrame,
      effect: parsed.command.effect,
    };
    job = await getJobQueue().enqueue({
      type: "segment",
      projectId,
      label: req.text.slice(0, 80),
      input,
      frameRange: { start: startFrame, end: endFrame },
    });
    record.status = "running";
    record.jobId = job.id;
  } else {
    record.status = "completed";
    record.trackId = plan.existingTrackId;
  }

  await repo.update(projectId, (p) => {
    p.commands = [...p.commands, record].slice(-200);
    if (job) p.jobIds = [...p.jobIds, job.id].slice(-500);
    // Effect-only commands on the current selection apply immediately.
    const effect = plan.steps.find((s) => s.kind === "apply_effect");
    if (!plan.requiresSegmentation && effect?.kind === "apply_effect" && plan.existingTrackId) {
      p.composite.effect = effect.effect.type;
      p.composite.subjectTrackIds = [plan.existingTrackId];
      if (effect.effect.color) p.composite.backgroundColor = effect.effect.color;
      if (effect.effect.strength !== undefined) p.composite.blurStrength = effect.effect.strength;
    }
  });
  return { record, parsed, plan, job };
}

// ---------------------------------------------------------------------------
// Interactive segmentation & tracking
// ---------------------------------------------------------------------------
export async function segmentOnce(projectId: string, req: SegmentRequest, signal?: AbortSignal) {
  const project = await requireProject(projectId);
  const { sam2 } = getAIServices();
  const res = await sam2.segmentFrame(project, { frameIndex: req.frameIndex, points: req.points, box: req.box }, { signal });
  return {
    frameIndex: res.frameIndex,
    width: project.analysis.width,
    height: project.analysis.height,
    counts: encodeMask(res.mask),
    score: res.score,
    provider: sam2.info.id,
    providerKind: sam2.info.kind,
  };
}

export async function startTracking(projectId: string, req: TrackRequest): Promise<Job> {
  const project = await requireProject(projectId);
  const last = project.video.frameCount - 1;
  for (const k of req.keyframes) {
    if (k.frameIndex > last) throw new AppError("VALIDATION_ERROR", { message: "A keyframe is outside the video." });
  }
  const startFrame = Math.min(req.range?.start ?? 0, last);
  const endFrame = Math.min(req.range?.end ?? last, last);
  const input: SegmentJobInput = {
    kind: "track",
    trackId: req.trackId,
    name: req.name,
    keyframes: req.keyframes,
    startFrame,
    endFrame,
    direction: req.direction,
    preserveOutside: req.preserveOutside,
  };
  const job = await getJobQueue().enqueue({
    type: "segment",
    projectId,
    label: req.name ? `Tracking ${req.name}` : "Tracking object",
    input,
    trackId: req.trackId,
    frameRange: { start: startFrame, end: endFrame },
  });
  await recordJob(projectId, job.id);
  return job;
}

// ---------------------------------------------------------------------------
// Tracks (client-side edits persisted)
// ---------------------------------------------------------------------------
export async function saveTrack(projectId: string, track: Track): Promise<Track> {
  const project = await requireProject(projectId);
  if (track.width !== project.analysis.width || track.height !== project.analysis.height) {
    throw new AppError("VALIDATION_ERROR", { message: "The mask size doesn't match this project." });
  }
  const n = track.width * track.height;
  for (const [k, counts] of Object.entries(track.frames)) {
    if (Number(k) >= project.video.frameCount) throw new AppError("VALIDATION_ERROR", { message: "A mask frame is outside the video." });
    let sum = 0;
    for (const c of counts) sum += c;
    if (sum !== n) throw new AppError("VALIDATION_ERROR", { message: "A mask is corrupted." });
  }
  return getProjectRepository().saveTrack(projectId, { ...track, updatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
export async function startExport(projectId: string, req: ExportRequest): Promise<{ job: Job; exportId: string }> {
  const repo = getProjectRepository();
  const project = await requireProject(projectId);
  const composite = req.composite ?? project.composite;
  const last = project.video.frameCount - 1;
  if (req.settings.range && req.settings.range.start > last) {
    throw new AppError("VALIDATION_ERROR", { message: "The export range is outside the video." });
  }
  await assertDiskSpace(exportsDir(projectId));
  const exportId = newId("exp");
  const input: ExportJobInput = { exportId, settings: req.settings, composite };
  const spec = FORMAT_SPECS[req.settings.format];
  const job = await getJobQueue().enqueue({ type: "export", projectId, label: `Export ${spec.label}`, input });
  await repo.update(projectId, (p) => {
    p.exportSettings = req.settings;
    p.composite = composite;
    p.jobIds = [...p.jobIds, job.id].slice(-500);
  });
  // Metadata for the download endpoint; the job fills in the rest.
  await writeJsonAtomic(path.join(exportsDir(projectId), `${exportId}.meta.json`), { exportId, jobId: job.id, format: spec.format });
  return { job, exportId };
}
