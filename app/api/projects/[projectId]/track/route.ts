import { TrackRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, rateLimit, route } from "@/lib/server/api";
import { startTracking } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

/** Starts a tracking job from keyframe prompts (points, box, or mask per frame). */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  rateLimit(request, "track", 60);
  const body = await parseBody(request, TrackRequestSchema, 20_000_000);
  const job = await startTracking(projectId, body);
  return json({ job }, { status: 202 });
});
