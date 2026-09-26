import { CommandRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, rateLimit, route } from "@/lib/server/api";
import { requireProject } from "@/services/projects";
import { runCommand } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { projectId } = await params;
  const project = await requireProject(projectId);
  return json({ commands: project.commands });
});

/**
 * Natural-language command: parse (Llama or rules) → validate → plan →
 * start a segmentation job if needed. Returns immediately with the job.
 */
export const POST = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  rateLimit(request, "command", 60);
  const body = await parseBody(request, CommandRequestSchema);
  const res = await runCommand(projectId, body, request.signal);
  return json(res, { status: res.job ? 202 : 200 });
});
