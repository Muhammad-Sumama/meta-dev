import "server-only";
import { z, ZodError } from "zod";
import { AppError, toAppError } from "@/lib/errors";

/**
 * Route-handler helpers: uniform error responses, body validation, and a
 * small in-memory rate limiter. Error responses only ever contain the
 * user-facing message/hint from the error catalog.
 */

export function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...(init.headers ?? {}) } });
}

export function errorResponse(err: unknown): Response {
  let appErr: AppError;
  if (err instanceof ZodError) {
    const first = err.issues[0];
    appErr = new AppError("VALIDATION_ERROR", {
      message: first ? `${first.path.join(".") || "request"}: ${first.message}` : undefined,
    });
  } else {
    appErr = toAppError(err);
    if (!(err instanceof AppError)) console.error("[api] unhandled error:", err);
    else if (appErr.status >= 500 && appErr.cause) console.error(`[api] ${appErr.code}:`, appErr.cause);
  }
  const retryAfter = appErr.code === "RATE_LIMITED" ? { "retry-after": "5" } : undefined;
  return json({ error: appErr.toJSON() }, { status: appErr.status, headers: retryAfter });
}

type Handler<C> = (request: Request, ctx: C) => Promise<Response>;

export function route<C>(handler: Handler<C>): Handler<C> {
  return async (request, ctx) => {
    try {
      return await handler(request, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function parseBody<T extends z.ZodType>(request: Request, schema: T, maxBytes = 1_000_000): Promise<z.infer<T>> {
  const len = Number(request.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new AppError("VALIDATION_ERROR", { message: "The request is too large." });
  const text = await request.text();
  if (text.length > maxBytes) throw new AppError("VALIDATION_ERROR", { message: "The request is too large." });
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new AppError("VALIDATION_ERROR", { message: "The request body isn't valid JSON." });
  }
  return schema.parse(raw);
}

// ---------------------------------------------------------------------------
// Rate limiting (per client, per bucket). In production, put this in Redis.
// ---------------------------------------------------------------------------
const g = globalThis as unknown as { __opensamRate?: Map<string, { tokens: number; at: number }> };
const buckets = (g.__opensamRate ??= new Map());

export function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || "local";
}

export function rateLimit(request: Request, bucket: string, perMinute: number) {
  const key = `${bucket}:${clientKey(request)}`;
  const now = Date.now();
  const entry = buckets.get(key) ?? { tokens: perMinute, at: now };
  entry.tokens = Math.min(perMinute, entry.tokens + ((now - entry.at) / 60_000) * perMinute);
  entry.at = now;
  if (entry.tokens < 1) {
    buckets.set(key, entry);
    throw new AppError("RATE_LIMITED");
  }
  entry.tokens -= 1;
  buckets.set(key, entry);
  if (buckets.size > 5000) buckets.clear();
}
