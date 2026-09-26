import { AppError } from "@/lib/errors";
import { json, route } from "@/lib/server/api";
import { getJobQueue } from "@/services/jobs/runtime";
import { assertId } from "@/services/storage/paths";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ jobId: string }> };

export const GET = route(async (_req: Request, { params }: Ctx) => {
  const { jobId } = await params;
  assertId("job", jobId);
  const job = await getJobQueue().get(jobId);
  if (!job) throw new AppError("NOT_FOUND", { message: "That job doesn't exist." });
  return json({ job });
});

/** Cancels a queued or running job. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const { jobId } = await params;
  assertId("job", jobId);
  return json({ job: await getJobQueue().cancel(jobId) });
});
