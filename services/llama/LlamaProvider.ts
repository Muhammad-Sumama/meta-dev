import { AppError } from "@/lib/errors";
import type { CallOptions, LanguageProvider, LanguageRequest, ProviderHealth, ProviderInfo } from "../ai/types";
import { buildMessages } from "./prompt";

/**
 * Production language provider: Llama served behind any OpenAI-compatible
 * Chat Completions endpoint — Ollama (`/v1`), vLLM, llama.cpp server,
 * Together, Groq, Fireworks, etc.
 *
 *   LLM_PROVIDER=llama
 *   LLAMA_BASE_URL=http://localhost:11434/v1
 *   LLAMA_MODEL=llama3.1:8b
 *   LLAMA_API_KEY=…            (only if your endpoint needs one; server-side only)
 */
export interface LlamaProviderConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class LlamaProvider implements LanguageProvider {
  readonly info: ProviderInfo;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: LlamaProviderConfig) {
    this.info = {
      id: "llama",
      name: "Llama",
      kind: "production",
      model: cfg.model,
      description: `Llama via OpenAI-compatible API at ${new URL(cfg.baseUrl).host}`,
    };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private url(path: string) {
    return `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(this.url("/models"), { headers: this.headers(), signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { status: "unavailable", message: `Endpoint responded ${res.status}.` };
      const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
      const ids = body?.data?.map((m) => m.id).filter(Boolean) ?? [];
      const hasModel = !ids.length || ids.includes(this.cfg.model);
      return {
        status: hasModel ? "ready" : "degraded",
        message: hasModel ? `Connected (${this.cfg.model}).` : `Connected, but model “${this.cfg.model}” isn't listed.`,
        latencyMs: Date.now() - t0,
      };
    } catch {
      return { status: "unavailable", message: "Can't reach the Llama endpoint." };
    }
  }

  async interpret(req: LanguageRequest, opts: CallOptions = {}): Promise<string> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const messages = buildMessages(
      req.text,
      req.previousOutput && req.validationError ? { previousOutput: req.previousOutput, validationError: req.validationError } : undefined,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(this.url("/chat/completions"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          temperature: 0,
          max_tokens: 500,
          response_format: { type: "json_object" },
        }),
        signal,
      });
    } catch (err) {
      if (timeout.aborted) throw new AppError("AI_TIMEOUT", { cause: err });
      if (opts.signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      throw new AppError("MODEL_UNAVAILABLE", { message: "We couldn't reach the language model.", cause: err });
    }
    if (res.status === 429) throw new AppError("RATE_LIMITED", { message: "The language model is rate limiting requests." });
    if (res.status === 401 || res.status === 403) {
      throw new AppError("MODEL_UNAVAILABLE", { message: "The language model rejected our credentials.", hint: "Check LLAMA_API_KEY." });
    }
    if (res.status === 404) {
      throw new AppError("MODEL_UNAVAILABLE", { message: `The model “${this.cfg.model}” wasn't found.`, hint: "Check LLAMA_MODEL (e.g. run `ollama pull llama3.1:8b`)." });
    }
    if (!res.ok) throw new AppError("MODEL_UNAVAILABLE", { cause: new Error(`HTTP ${res.status}`) });

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new AppError("INVALID_AI_RESPONSE", { cause });
    }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AppError("INVALID_AI_RESPONSE", { message: "The language model returned an empty answer." });
    }
    return content;
  }
}
