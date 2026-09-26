import { ExportRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, rateLimit, route } from "@/lib/server/api";
import { startExport } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

export const POST = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  rateLimit(request, "export", 30);
  const body = await parseBody(request, ExportRequestSchema);
  const res = await startExport(projectId, body);
  return json(res, { status: 202 });
});
