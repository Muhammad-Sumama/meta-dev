import { SaveTrackRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, route } from "@/lib/server/api";
import { getProjectRepository, requireProject } from "@/services/projects";
import { saveTrack } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { projectId } = await params;
  await requireProject(projectId);
  return json({ tracks: await getProjectRepository().listTracks(projectId) });
});

/** Creates a track from client-side edits (e.g. a manual selection). */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  const track = await parseBody(request, SaveTrackRequestSchema, 50_000_000);
  return json({ track: await saveTrack(projectId, track) }, { status: 201 });
});
