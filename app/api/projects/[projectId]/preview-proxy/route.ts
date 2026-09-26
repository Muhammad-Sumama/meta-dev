import { json, rateLimit, route } from "@/lib/server/api";
import { requestVp9Proxy } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

/** Requests a VP9/WebM preview (for browsers that can't decode H.264). */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  rateLimit(request, "proxy", 20);
  return json(await requestVp9Proxy(projectId), { status: 202 });
});
