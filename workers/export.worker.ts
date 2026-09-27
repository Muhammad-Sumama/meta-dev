import "server-only";
import { runExport, type ExportJobInput, type ExportResult } from "@/services/export/ExportService";
import type { JobHandler } from "@/services/jobs/types";
import { requireJobProject } from "./project";
import { writeProjectJson } from "@/services/storage/projectMedia";

export const exportWorker: JobHandler<ExportJobInput, ExportResult> = async ({ job, signal, progress }) => {
  const project = await requireJobProject(job.projectId);
  progress({ stage: "preparing", message: "Preparing export…", fraction: 0 });
  const result = await runExport(project, job.input, { signal, progress });
  // Downloads read this, so exports stay downloadable after the job record expires.
  await writeProjectJson(project.id, `exports/${result.exportId}.result.json`, result);
  return result;
};
