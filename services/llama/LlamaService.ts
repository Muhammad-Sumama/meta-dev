import { AppError, toAppError } from "@/lib/errors";
import type { EditCommand, EditingPlan, ParsedCommand, Target } from "@/lib/schemas/command";
import type { CallOptions, LanguageProvider } from "../ai/types";
import { normalizeCommand } from "./normalize";
import { generateEditingPlan, type PlanContext } from "./plan";
import { parseWithRules, RULES_VERSION } from "./rules";

/**
 * Natural language → validated EditCommand → EditingPlan.
 *
 * - The provider's answer is never trusted: normalizeCommand() validates it.
 * - A malformed answer gets one repair attempt with the validation error.
 * - If the model is unreachable, times out, or stays invalid, and
 *   LLAMA_FALLBACK_TO_RULES is on, the built-in parser answers instead and the
 *   result is flagged `source: "fallback"` with a user-visible warning.
 */
export class LlamaService {
  constructor(
    private readonly provider: LanguageProvider,
    private readonly opts: { fallbackToRules: boolean } = { fallbackToRules: true },
  ) {}

  get info() {
    return this.provider.info;
  }

  async parseCommand(text: string, callOpts: CallOptions = {}): Promise<ParsedCommand> {
    const t0 = Date.now();
    const clean = text.trim().slice(0, 500);
    if (!clean) throw new AppError("VALIDATION_ERROR", { message: "Type what you want to do." });

    if (this.provider.info.kind === "mock") {
      const command = normalizeCommand(await this.provider.interpret({ text: clean }, callOpts));
      return { command, source: "rules", warnings: [], model: this.provider.info.model ?? RULES_VERSION, latencyMs: Date.now() - t0 };
    }

    let lastError: AppError | null = null;
    try {
      const first = await this.provider.interpret({ text: clean }, callOpts);
      try {
        return this.ok(normalizeCommand(first), t0);
      } catch (err) {
        const e = toAppError(err);
        if (e.code === "COMMAND_NOT_UNDERSTOOD") throw e;
        // One repair attempt, telling the model what was wrong.
        const second = await this.provider.interpret(
          {
            text: clean,
            previousOutput: typeof first === "string" ? first : JSON.stringify(first),
            validationError: e.cause instanceof Error ? e.cause.message : e.message,
          },
          callOpts,
        );
        return this.ok(normalizeCommand(second), t0);
      }
    } catch (err) {
      lastError = toAppError(err);
      if (lastError.code === "JOB_CANCELLED") throw lastError;
      if (lastError.code === "COMMAND_NOT_UNDERSTOOD") throw lastError;
    }

    if (!this.opts.fallbackToRules) throw lastError;
    console.warn(`[llama] falling back to rules: ${lastError.code}`, lastError.cause ?? "");
    const command = normalizeCommand(parseWithRules(clean));
    const reason =
      lastError.code === "AI_TIMEOUT"
        ? "Llama took too long"
        : lastError.code === "INVALID_AI_RESPONSE"
          ? "Llama returned an invalid answer"
          : "Llama is unavailable";
    return {
      command,
      source: "fallback",
      warnings: [`${reason}, so the built-in parser handled this request.`],
      model: RULES_VERSION,
      latencyMs: Date.now() - t0,
    };
  }

  private ok(command: EditCommand, t0: number): ParsedCommand {
    return { command, source: "llama", warnings: [], model: this.provider.info.model ?? "llama", latencyMs: Date.now() - t0 };
  }

  async identifyTarget(text: string, callOpts?: CallOptions): Promise<Target | null> {
    return (await this.parseCommand(text, callOpts)).command.target;
  }

  generateEditingPlan(command: EditCommand, ctx: PlanContext): EditingPlan {
    return generateEditingPlan(command, ctx);
  }
}
