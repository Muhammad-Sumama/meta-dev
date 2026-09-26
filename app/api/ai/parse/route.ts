import { ParseRequestSchema } from "@/lib/schemas/api";
import { json, parseBody, rateLimit, route } from "@/lib/server/api";
import { getAIServices } from "@/services/ai/registry";

export const runtime = "nodejs";

/** Parses a command without running it (used by Settings → "Test language model"). */
export const POST = route(async (request: Request) => {
  rateLimit(request, "parse", 60);
  const { text } = await parseBody(request, ParseRequestSchema);
  const parsed = await getAIServices().llama.parseCommand(text, { signal: request.signal });
  return json(parsed);
});
