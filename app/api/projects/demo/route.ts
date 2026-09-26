import { json, rateLimit, route } from "@/lib/server/api";
import { createDemoProject } from "@/services/projects/ProjectService";

export const runtime = "nodejs";

/** Creates a project from the bundled demo clip. */
export const POST = route(async (request: Request) => {
  rateLimit(request, "demo", 30);
  const { project, job } = await createDemoProject();
  return json({ project, job }, { status: 201 });
});
