import path from "node:path";
import { AppError } from "@/lib/errors";
import { route } from "@/lib/server/api";
import { serveFile } from "@/lib/server/files";
import type { ExportResult } from "@/services/export/ExportService";
import { getJobQueue } from "@/services/jobs/runtime";
import { requireProject } from "@/services/projects";
import { readJson } from "@/services/storage/fs";
import { assertId, exportsDir } from "@/services/storage/paths";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string; exportId: string }> };

/** Downloads a finished export. */
export const GET = route(async (request: Request, { params }: Ctx) => {
  const { projectId, exportId } = await params;
  await requireProject(projectId);
  assertId("export", exportId);
  const meta = await readJson<{ jobId: string }>(path.join(exportsDir(projectId), `${exportId}.meta.json`));
  if (!meta) throw new AppError("NOT_FOUND", { message: "That export doesn't exist." });
  const job = await getJobQueue().get(meta.jobId);
  if (!job || job.status !== "completed" || !job.result) {
    throw new AppError("CONFLICT", { message: "This export isn't finished yet." });
  }
  const result = job.result as ExportResult;
  return serveFile(request, path.join(exportsDir(projectId), result.fileName), {
    contentType: result.mime,
    downloadName: result.downloadName,
  });
});
