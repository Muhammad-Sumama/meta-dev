import { AppError } from "@/lib/errors";
import { SaveTrackRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, route } from "@/lib/server/api";
import { getProjectRepository, requireProject } from "@/services/projects";
import { saveTrack } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string; trackId: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { projectId, trackId } = await params;
  await requireProject(projectId);
  const track = await getProjectRepository().getTrack(projectId, trackId);
  if (!track) throw new AppError("NOT_FOUND", { message: "That object no longer exists." });
  return json({ track });
});

/** Saves the full track (masks + metadata) after edits in the browser. */
export const PUT = route(async (request: Request, { params }: Ctx) => {
  const { projectId, trackId } = await params;
  const track = await parseBody(request, SaveTrackRequestSchema, 50_000_000);
  if (track.id !== trackId) throw new AppError("VALIDATION_ERROR", { message: "Track id mismatch." });
  return json({ track: await saveTrack(projectId, track) });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { projectId, trackId } = await params;
  await requireProject(projectId);
  await getProjectRepository().deleteTrack(projectId, trackId);
  await getProjectRepository().update(projectId, (p) => {
    p.composite.subjectTrackIds = p.composite.subjectTrackIds.filter((id) => id !== trackId);
  });
  return json({ ok: true });
});
