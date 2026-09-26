import { SegmentRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, rateLimit, route } from "@/lib/server/api";
import { segmentOnce } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

/**
 * Interactive single-frame segmentation (click / box). Synchronous because it
 * is fast (one frame) and the user is waiting on it; tracking uses jobs.
 * Body: { frameIndex, points: [{x,y,label}], box?: {x0,y0,x1,y1} } — normalized coords.
 */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  rateLimit(request, "segment", 240);
  const body = await parseBody(request, SegmentRequestSchema);
  return json(await segmentOnce(projectId, body, request.signal));
});
