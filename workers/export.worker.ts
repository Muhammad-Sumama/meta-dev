import "server-only";
import { runExport, type ExportJobInput, type ExportResult } from "@/services/export/ExportService";
import type { JobHandler } from "@/services/jobs/types";
import { requireProject } from "@/services/projects";

export const exportWorker: JobHandler<ExportJobInput, ExportResult> = async ({ job, signal, progress }) => {
  const project = await requireProject(job.projectId);
  progress({ stage: "preparing", message: "Preparing export…", fraction: 0 });
  return runExport(project, job.input, { signal, progress });
};
