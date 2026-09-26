import { PatchProjectSchema } from "@/lib/schemas/api";
import { json, parseBody, route } from "@/lib/server/api";
import { getProjectRepository, requireProject } from "@/services/projects";
import { deleteProject, getProjectBundle } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { projectId } = await params;
  return json(await getProjectBundle(projectId));
});

export const PATCH = route(async (request: Request, { params }: Ctx) => {
  const { projectId } = await params;
  await requireProject(projectId);
  const patch = await parseBody(request, PatchProjectSchema);
  const project = await getProjectRepository().update(projectId, (p) => {
    if (patch.name) p.name = patch.name;
    if (patch.composite) p.composite = patch.composite;
    if (patch.exportSettings) p.exportSettings = patch.exportSettings;
  });
  return json({ project });
});

export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { projectId } = await params;
  await deleteProject(projectId);
  return json({ ok: true });
});
