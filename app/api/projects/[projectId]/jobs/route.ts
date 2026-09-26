import { json, route } from "@/lib/server/api";
import { getJobQueue } from "@/services/jobs/runtime";
import { requireProject } from "@/services/projects";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  await requireProject(projectId);
  const activeOnly = new URL(request.url).searchParams.get("active") === "1";
  const jobs = await getJobQueue().list({ projectId, activeOnly });
  return json({ jobs: jobs.slice(0, 50) });
});
