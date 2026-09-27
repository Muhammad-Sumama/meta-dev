import "server-only";
import type { HandlerRegistry } from "@/services/jobs/types";
import { exportWorker } from "./export.worker";
import { ingestWorker } from "./ingest.worker";
import { segmentationWorker } from "./segmentation.worker";

/** Registers every job handler (the web process in memory mode, or a worker process). */
export function registerWorkers(queue: HandlerRegistry) {
  queue.register("ingest", ingestWorker);
  queue.register("segment", segmentationWorker);
  queue.register("export", exportWorker);
}
