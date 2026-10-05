import "server-only";
import { getConfig } from "@/lib/server/config";
import { LlamaProvider } from "../llama/LlamaProvider";
import { LlamaService } from "../llama/LlamaService";
import { SAM2Provider } from "../sam2/SAM2Provider";
import { SAM2Service } from "../sam2/SAM2Service";
import { ffmpegFrameSource } from "./frameSource";
import { MockLanguageProvider } from "./mock/MockLanguageProvider";
import { MockSegmentationProvider } from "./mock/MockSegmentationProvider";
import type { AIProvider } from "./types";

/**
 * THE switch between mock and production inference.
 *
 *   LLM_PROVIDER=mock | llama               → MockLanguageProvider | LlamaProvider
 *   SEGMENTATION_PROVIDER=mock | sam2 | sam3 → MockSegmentationProvider | SAM2Provider
 *     (sam3: the same HTTP contract, served with MODEL_FAMILY=sam3)
 *
 * Nothing else in the application knows which implementation is active;
 * the UI reads `info.kind` to label mock results honestly.
 */

export interface AIServices extends AIProvider {
  llama: LlamaService;
  sam2: SAM2Service;
}

const g = globalThis as unknown as { __opensamAI?: { key: string; classes: unknown[]; services: AIServices } };

// Class identities change when a module is hot-reloaded in development; a
// cached instance built from stale classes is discarded.
const CLASSES: unknown[] = [LlamaProvider, LlamaService, SAM2Provider, SAM2Service, MockLanguageProvider, MockSegmentationProvider];

export function getAIServices(): AIServices {
  const cfg = getConfig();
  const key = [cfg.LLM_PROVIDER, cfg.LLAMA_BASE_URL, cfg.LLAMA_MODEL, cfg.SEGMENTATION_PROVIDER, cfg.SAM2_SERVICE_URL].join("|");
  const cached = g.__opensamAI;
  if (cached?.key === key && cached.classes.every((c, i) => c === CLASSES[i])) return cached.services;

  const language =
    cfg.LLM_PROVIDER === "llama"
      ? new LlamaProvider({ baseUrl: cfg.LLAMA_BASE_URL, model: cfg.LLAMA_MODEL, apiKey: cfg.LLAMA_API_KEY, timeoutMs: cfg.LLAMA_TIMEOUT_MS })
      : new MockLanguageProvider();

  const segmentation =
    cfg.SEGMENTATION_PROVIDER === "sam2" || cfg.SEGMENTATION_PROVIDER === "sam3"
      ? new SAM2Provider({
          family: cfg.SEGMENTATION_PROVIDER,
          baseUrl: cfg.SAM2_SERVICE_URL.split(",").map((u) => u.trim()),
          apiKey: cfg.SAM2_API_KEY,
          timeoutMs: cfg.SAM2_TIMEOUT_MS,
          sharedStorage: cfg.SAM2_SHARED_STORAGE,
        })
      : new MockSegmentationProvider({ frameSourceFactory: (src) => ffmpegFrameSource(src) });

  const services: AIServices = {
    language,
    segmentation,
    llama: new LlamaService(language, { fallbackToRules: cfg.LLAMA_FALLBACK_TO_RULES }),
    sam2: new SAM2Service(segmentation),
  };
  g.__opensamAI = { key, classes: CLASSES, services };
  return services;
}
