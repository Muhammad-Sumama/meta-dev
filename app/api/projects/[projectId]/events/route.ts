import { rateLimit, route } from "@/lib/server/api";
import { jobEventStream } from "@/services/jobs/events";
import { getJobQueue } from "@/services/jobs/runtime";
import { requireProject } from "@/services/projects";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

/** Live job updates for a project as server-sent events (see services/jobs/events.ts). */
export const GET = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  rateLimit(request, "events", 60);
  await requireProject(projectId);
  return new Response(jobEventStream(getJobQueue(), projectId, request.signal), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});
