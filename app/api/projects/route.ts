import { json, rateLimit, route } from "@/lib/server/api";
import { getProjectRepository } from "@/services/projects";
import { createProjectFromUpload } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

export const GET = route(async () => {
  return json({ projects: await getProjectRepository().list() });
});

/**
 * Upload a video and create a project.
 * Body: raw file bytes (streamed to disk). Header `x-file-name`: URI-encoded name.
 */
export const POST = route(async (request: Request) => {
  rateLimit(request, "upload", 20);
  const { project, job } = await createProjectFromUpload(request);
  return json({ project, job }, { status: 201 });
});
