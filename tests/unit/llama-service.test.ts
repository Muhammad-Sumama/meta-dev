import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { LlamaProvider } from "@/services/llama/LlamaProvider";
import { LlamaService } from "@/services/llama/LlamaService";
import { generateEditingPlan } from "@/services/llama/plan";
import { MockLanguageProvider } from "@/services/ai/mock/MockLanguageProvider";

function chat(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { "content-type": "application/json" } });
}

function provider(fetchImpl: typeof fetch, timeoutMs = 2000) {
  return new LlamaProvider({ baseUrl: "http://llama.test/v1", model: "llama3.1:8b", apiKey: "secret", timeoutMs, fetchImpl });
}

const GOOD = JSON.stringify({ action: "track", target: { type: "vehicle", description: "red car", attributes: { colors: ["red"] } }, tracking: true, output: "mask" });

describe("LlamaProvider (OpenAI-compatible HTTP)", () => {
  it("sends a JSON-mode chat completion with the key server-side", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("llama3.1:8b");
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.messages.at(-1).content).toBe("Track the red car");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
      return chat(GOOD);
    }) as unknown as typeof fetch;
    const out = await provider(fetchImpl).interpret({ text: "Track the red car" });
    expect(out).toBe(GOOD);
    expect(fetchImpl).toHaveBeenCalledWith("http://llama.test/v1/chat/completions", expect.anything());
  });

  it("maps HTTP failures to user-facing errors", async () => {
    const cases: Array<[number, string]> = [
      [401, "MODEL_UNAVAILABLE"],
      [404, "MODEL_UNAVAILABLE"],
      [429, "RATE_LIMITED"],
      [500, "MODEL_UNAVAILABLE"],
    ];
    for (const [status, code] of cases) {
      const p = provider((async () => new Response("{}", { status })) as unknown as typeof fetch);
      await expect(p.interpret({ text: "x" })).rejects.toMatchObject({ code });
    }
    const down = provider((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await expect(down.interpret({ text: "x" })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  it("times out slow models", async () => {
    const slow = provider(
      ((_: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })) as unknown as typeof fetch,
      50,
    );
    await expect(slow.interpret({ text: "x" })).rejects.toMatchObject({ code: "AI_TIMEOUT" });
  });
});

describe("LlamaService", () => {
  it("validates model output", async () => {
    const svc = new LlamaService(provider((async () => chat(GOOD)) as unknown as typeof fetch));
    const res = await svc.parseCommand("Track the red car");
    expect(res.source).toBe("llama");
    expect(res.command.target?.description).toBe("red car");
    expect(res.warnings).toEqual([]);
  });

  it("repairs malformed output once, passing the validation error back", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.messages.at(-1).content);
      return calls.length === 1 ? chat('{"action": "track", "target": {"description": ') : chat(GOOD);
    }) as unknown as typeof fetch;
    const res = await new LlamaService(provider(fetchImpl)).parseCommand("Track the red car");
    expect(res.source).toBe("llama");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/invalid/i);
  });

  it("falls back to the built-in parser when the model is unavailable", async () => {
    const svc = new LlamaService(provider((async () => new Response("{}", { status: 503 })) as unknown as typeof fetch));
    const res = await svc.parseCommand("Track the red car");
    expect(res.source).toBe("fallback");
    expect(res.warnings[0]).toMatch(/built-in parser/);
    expect(res.command.action).toBe("track");
  });

  it("surfaces the error when fallback is disabled", async () => {
    const svc = new LlamaService(provider((async () => new Response("{}", { status: 503 })) as unknown as typeof fetch), { fallbackToRules: false });
    await expect(svc.parseCommand("Track the red car")).rejects.toBeInstanceOf(AppError);
  });

  it("uses rules directly in mock mode", async () => {
    const res = await new LlamaService(new MockLanguageProvider()).parseCommand("Isolate the dog");
    expect(res.source).toBe("rules");
    expect(res.command.effect.type).toBe("remove_background");
    expect(await new LlamaService(new MockLanguageProvider()).identifyTarget("Track the blue car")).toMatchObject({ type: "vehicle" });
  });
});

describe("editing plans", () => {
  const ctx = { fps: 30, frameCount: 300, frameIndex: 42, trackCount: 1 };
  const svc = new LlamaService(new MockLanguageProvider());

  it("locates, segments and tracks a described target", async () => {
    const { command } = await svc.parseCommand("Blur the background behind the dog for the first 2 seconds");
    const plan = generateEditingPlan(command, ctx);
    expect(plan.requiresSegmentation).toBe(true);
    expect(plan.steps.map((s) => s.kind)).toEqual(["locate", "segment", "track", "apply_effect"]);
    expect(plan.steps[2]).toMatchObject({ startFrame: 0, endFrame: 60 });
  });

  it("applies effect-only commands to the selection", async () => {
    const { command } = await svc.parseCommand("Remove the background");
    const plan = generateEditingPlan(command, { ...ctx, selectedTrackId: "trk_aaaaaaaaaaaa" });
    expect(plan.requiresSegmentation).toBe(false);
    expect(plan.steps[0]).toEqual({ kind: "use_selection", trackId: "trk_aaaaaaaaaaaa" });
  });

  it("asks for a selection when none exists", async () => {
    const { command } = await svc.parseCommand("Remove the background");
    expect(() => generateEditingPlan(command, ctx)).toThrowError(expect.objectContaining({ code: "NO_SELECTION" }));
  });

  it("restricts single-frame commands to the current frame", async () => {
    const { command } = await svc.parseCommand("Select the dog on this frame");
    const plan = generateEditingPlan(command, ctx);
    expect(plan.steps.map((s) => s.kind)).toEqual(["locate", "segment"]);
  });
});
