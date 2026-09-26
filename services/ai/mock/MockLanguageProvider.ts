import { parseWithRules, RULES_VERSION } from "@/services/llama/rules";
import type { LanguageProvider, LanguageRequest, ProviderHealth, ProviderInfo } from "../types";

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  MOCK LANGUAGE PROVIDER  (no model)
 * ─────────────────────────────────────────────────────────────────────────
 * Deterministic grammar/lexicon parser standing in for Llama. It understands
 * the common phrasing of the supported actions, object categories, colors,
 * clothing, positions and time ranges, but not open-ended language. Its
 * output goes through the same validation as real model output.
 */
export class MockLanguageProvider implements LanguageProvider {
  readonly info: ProviderInfo = {
    id: "rules",
    name: "Built-in command parser",
    kind: "mock",
    model: RULES_VERSION,
    description: "Rule-based natural-language parser (no model). Handles common editing phrasing.",
  };

  async health(): Promise<ProviderHealth> {
    return { status: "ready", message: "Built-in parser is always available." };
  }

  async interpret(req: LanguageRequest): Promise<unknown> {
    return parseWithRules(req.text);
  }
}
