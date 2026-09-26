import "server-only";
import type { JobQueue } from "@/services/jobs/JobQueue";
import { exportWorker } from "./export.worker";
import { ingestWorker } from "./ingest.worker";
import { segmentationWorker } from "./segmentation.worker";

/** Registers every job handler. A standalone worker process would call this too. */
export function registerWorkers(queue: JobQueue) {
  queue.register("ingest", ingestWorker);
  queue.register("segment", segmentationWorker);
  queue.register("export", exportWorker);
}
