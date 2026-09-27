import { AppError } from "@/lib/errors";
import { route } from "@/lib/server/api";
import type { ExportResult } from "@/services/export/ExportService";
import { getJobQueue } from "@/services/jobs/runtime";
import { requireProject } from "@/services/projects";
import { assertId } from "@/services/storage/paths";
import { readProjectJson, serveProjectFile } from "@/services/storage/projectMedia";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string; exportId: string }> };

/** Downloads a finished export. */
export const GET = route(async (request: Request, { params }: Ctx) => {
  const { projectId, exportId } = await params;
  await requireProject(projectId);
  assertId("export", exportId);
  const result = await readProjectJson<ExportResult>(projectId, `exports/${exportId}.result.json`);
  if (!result) {
    const meta = await readProjectJson<{ jobId: string }>(projectId, `exports/${exportId}.meta.json`);
    if (!meta) throw new AppError("NOT_FOUND", { message: "That export doesn't exist." });
    const job = await getJobQueue().get(meta.jobId);
    if (job?.status === "failed" || job?.status === "cancelled") throw new AppError("CONFLICT", { message: "This export didn't finish." });
    throw new AppError("CONFLICT", { message: "This export isn't finished yet." });
  }
  return serveProjectFile(request, projectId, `exports/${result.fileName}`, {
    contentType: result.mime,
    downloadName: result.downloadName,
  });
});
