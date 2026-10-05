import { openAsBlob } from "node:fs";
import { AppError } from "@/lib/errors";
import { decodeMask, encodeMask, isValidRLE } from "@/lib/mask/rle";
import type { FramePrompt, PointPrompt } from "@/lib/schemas/project";
import type {
  CallOptions,
  Detection,
  MaskResult,
  ProviderHealth,
  ProviderInfo,
  SegmentationProvider,
  TargetQuery,
  TrackCallbacks,
  TrackRequest,
  VideoSession,
  VideoSource,
} from "../ai/types";

/**
 * Production segmentation provider: an HTTP client for the SAM 2 inference
 * server(s) in `inference/` (FastAPI + PyTorch, GPU recommended).
 *
 *   SEGMENTATION_PROVIDER=sam2
 *   SAM2_SERVICE_URL=http://gpu-a:8008,http://gpu-b:8008   (one or more)
 *   SAM2_API_KEY=…                 (optional shared secret)
 *   SAM2_SHARED_STORAGE=true       (send file paths instead of uploading)
 *
 * Several servers form a pool. Each video session lives on one server
 * (SAM 2 keeps the decoded video in GPU memory), chosen by rendezvous
 * hashing of the session id — so every web and worker process picks the
 * same server without coordinating. A server that can't be reached or
 * reports 503 is skipped for `cooldownMs` and the session is re-created on
 * the next one; a server that forgot a session (restarted) gets it again.
 *
 * Wire format for masks: row-major RLE `counts` starting with a background
 * run, at the requested mask_width × mask_height (see inference/README.md).
 */

export interface SAM2ProviderConfig {
  /** One server, or several (the pool). */
  baseUrl: string | string[];
  apiKey?: string;
  timeoutMs: number;
  sharedStorage: boolean;
  fetchImpl?: typeof fetch;
  /** How long a failed server is skipped. */
  cooldownMs?: number;
  now?: () => number;
  /** Which model the servers run (inference server MODEL_FAMILY). Only changes labels. */
  family?: "sam2" | "sam3";
}

/** A server that can't take work right now (unreachable, or 503): try another. */
class ServerUnavailable extends AppError {
  constructor(
    readonly server: string,
    message: string,
    cause?: unknown,
  ) {
    super("MODEL_UNAVAILABLE", { message, cause });
  }
}

/** The server doesn't know the session (e.g. it restarted): create it again. */
class SessionGone extends Error {}

/** FNV-1a: stable across processes, so every process ranks servers the same way. */
function hash(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface WireMask {
  counts: number[];
  size: [number, number];
}

type Box = [number, number, number, number];

function boxToWire(b: { x0: number; y0: number; x1: number; y1: number } | undefined): Box | null {
  return b ? [b.x0, b.y0, b.x1, b.y1] : null;
}

export class SAM2Provider implements SegmentationProvider {
  readonly info: ProviderInfo;
  private readonly fetchImpl: typeof fetch;
  private readonly servers: string[];
  private readonly downUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly cfg: SAM2ProviderConfig) {
    this.info =
      cfg.family === "sam3"
        ? {
            id: "sam3",
            name: "SAM 3",
            kind: "production",
            description: "Segment Anything Model 3 (tracker + text concept detection) served by the OpenSAM inference server.",
          }
        : {
            id: "sam2",
            name: "SAM 2",
            kind: "production",
            description: "Segment Anything Model 2 video predictor served by the OpenSAM inference server.",
          };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.now ?? Date.now;
    this.servers = (Array.isArray(cfg.baseUrl) ? cfg.baseUrl : [cfg.baseUrl]).map((u) => u.trim().replace(/\/+$/, "")).filter(Boolean);
    if (!this.servers.length) throw new Error("SAM2Provider needs at least one server URL");
  }

  /** Servers in preference order for a session (rendezvous hashing). */
  rankServers(sessionId: string): string[] {
    return [...this.servers].sort((a, b) => hash(`${b}|${sessionId}`) - hash(`${a}|${sessionId}`) || a.localeCompare(b));
  }

  /** The session's server: its first-ranked server that isn't cooling down. */
  serverFor(sessionId: string): string {
    const ranked = this.rankServers(sessionId);
    const now = this.now();
    return ranked.find((s) => (this.downUntil.get(s) ?? 0) <= now) ?? ranked[0];
  }

  private markDown(server: string) {
    if (this.servers.length > 1) this.downUntil.set(server, this.now() + (this.cfg.cooldownMs ?? 15_000));
  }

  private headers(json = true): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
  }

  private async request(server: string, path: string, init: RequestInit, opts: CallOptions & { timeoutMs?: number } = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.cfg.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${server}${path}`, { ...init, signal });
    } catch (err) {
      if (opts.signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      if (timeout.aborted) throw new AppError("AI_TIMEOUT", { message: "The segmentation model took too long.", cause: err });
      throw new ServerUnavailable(server, `We couldn't reach the ${this.info.name} server.`, err);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError("MODEL_UNAVAILABLE", { message: `The ${this.info.name} server rejected our credentials.`, hint: "Check SAM2_API_KEY." });
    }
    if (res.status === 507 || res.status === 413) throw new AppError("INSUFFICIENT_RESOURCES", { message: "The GPU server ran out of memory for this video." });
    if (res.status === 503) throw new ServerUnavailable(server, `${this.info.name} is still loading or unavailable.`);
    return res;
  }

  /**
   * Runs `op` against the session's server. If the server forgot the session,
   * it is created again there; if the server is unavailable and the pool has
   * another, the session moves (the video is sent to the new server) and `op`
   * runs there.
   */
  private async onSessionServer<T>(session: VideoSession, opts: CallOptions, op: (server: string) => Promise<T>): Promise<T> {
    let server = this.serverFor(session.id);
    let recreate = false;
    let recreatedHere = false;
    for (let attempt = 0; attempt <= this.servers.length + 1; attempt++) {
      try {
        if (recreate) await this.ensureSession(server, session.source, opts);
        return await op(server);
      } catch (err) {
        if (err instanceof SessionGone && !recreatedHere) {
          recreate = recreatedHere = true;
          continue;
        }
        if (err instanceof ServerUnavailable && this.servers.length > 1) {
          this.markDown(err.server);
          const next = this.serverFor(session.id);
          if (next !== err.server) {
            server = next;
            recreate = true;
            recreatedHere = false;
            continue;
          }
        }
        if (err instanceof SessionGone) throw new AppError("SEGMENTATION_FAILED", { message: `The ${this.info.name} server lost this video's session. Try again.` });
        throw err;
      }
    }
    throw new AppError("MODEL_UNAVAILABLE", { message: `No ${this.info.name} server is available.` });
  }

  private async json<T>(res: Response, fallback: "SEGMENTATION_FAILED" | "TRACKING_FAILED"): Promise<T> {
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new AppError(fallback, { cause: new Error(`HTTP ${res.status}: ${detail.slice(0, 500)}`) });
    }
    try {
      return (await res.json()) as T;
    } catch (cause) {
      throw new AppError("INVALID_AI_RESPONSE", { cause });
    }
  }

  private decode(session: VideoSession, m: WireMask | undefined): Uint8Array {
    const n = session.width * session.height;
    if (!m || !isValidRLE(m.counts, n)) throw new AppError("INVALID_AI_RESPONSE", { message: "The segmentation server returned an invalid mask." });
    return decodeMask(m.counts, n);
  }

  private async serverHealth(server: string) {
    try {
      const res = await this.fetchImpl(`${server}/health`, { headers: this.headers(), signal: AbortSignal.timeout(4000) });
      const body = (await res.json().catch(() => ({}))) as { status?: string; model?: string; device?: string; grounding?: boolean };
      if (!res.ok || body.status === "error") return { status: "unavailable" as const, reachable: true, body };
      if (body.status === "loading") return { status: "degraded" as const, reachable: true, body };
      return { status: "ready" as const, reachable: true, body };
    } catch {
      return { status: "unavailable" as const, reachable: false, body: {} as { model?: string; device?: string; grounding?: boolean } };
    }
  }

  async health(): Promise<ProviderHealth> {
    const t0 = Date.now();
    const results = await Promise.all(this.servers.map((s) => this.serverHealth(s)));
    const ready = results.filter((r) => r.status === "ready");
    const grounding = ready.some((r) => r.body.grounding);
    const latencyMs = Date.now() - t0;
    if (this.servers.length === 1) {
      const [r] = results;
      if (r.status === "unavailable") return { status: "unavailable", message: r.reachable ? `${this.info.name} server reported an error.` : `Can't reach the ${this.info.name} server.` };
      if (r.status === "degraded") return { status: "degraded", message: `${this.info.name} is loading the model…` };
      return { status: "ready", message: `${this.info.name} ready (${r.body.model ?? "model"} on ${r.body.device ?? "device"}).`, latencyMs, details: { grounding } };
    }
    const total = this.servers.length;
    const details = { grounding, serversReady: ready.length, servers: total };
    if (ready.length === total) {
      const first = ready[0].body;
      return { status: "ready", message: `${total} ${this.info.name} servers ready (${first.model ?? "model"} on ${first.device ?? "device"}).`, latencyMs, details };
    }
    if (ready.length > 0) return { status: "degraded", message: `${ready.length} of ${total} ${this.info.name} servers ready; videos on the others move automatically.`, latencyMs, details };
    const loading = results.some((r) => r.status === "degraded");
    return { status: loading ? "degraded" : "unavailable", message: loading ? `${this.info.name} servers are loading the model…` : `Can't reach any ${this.info.name} server.`, details };
  }

  async initializeVideo(source: VideoSource, opts: CallOptions = {}): Promise<VideoSession> {
    const sessionId = `${source.projectId}-${source.version}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const session: VideoSession = {
      id: sessionId,
      providerId: this.info.id,
      source,
      width: source.maskWidth,
      height: source.maskHeight,
      notes: [],
    };
    await this.onSessionServer(session, opts, (server) => this.ensureSession(server, source, opts, sessionId));
    return session;
  }

  /** Reuses the server's session for this video, or creates it (sending the video). */
  private async ensureSession(server: string, source: VideoSource, opts: CallOptions, sessionId = `${source.projectId}-${source.version}`.replace(/[^A-Za-z0-9_-]/g, "_")) {
    const existing = await this.request(server, `/v1/sessions/${sessionId}`, { headers: this.headers() }, { ...opts, timeoutMs: 15_000 });
    if (existing.ok) return;
    const meta = { session_id: sessionId, mask_width: source.maskWidth, mask_height: source.maskHeight, fps: source.fps, frame_count: source.frameCount };
    let res: Response;
    if (this.cfg.sharedStorage) {
      res = await this.request(server, "/v1/sessions", { method: "POST", headers: this.headers(), body: JSON.stringify({ ...meta, video_path: source.filePath }) }, opts);
    } else {
      const form = new FormData();
      form.set("meta", JSON.stringify(meta));
      form.set("video", await openAsBlob(source.filePath), "source");
      res = await this.request(server, "/v1/sessions", { method: "POST", headers: this.headers(false), body: form }, opts);
    }
    await this.json<unknown>(res, "SEGMENTATION_FAILED");
  }

  /** POST to a session endpoint on its server; a 404 means the server forgot the session. */
  private post(session: VideoSession, endpoint: string, body: unknown, opts: CallOptions) {
    return this.onSessionServer(session, opts, async (server) => {
      const res = await this.request(server, `/v1/sessions/${session.id}/${endpoint}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, opts);
      if (res.status === 404) throw new SessionGone();
      return res;
    });
  }

  async locateObjects(session: VideoSession, frameIndices: number[], query: TargetQuery, opts: CallOptions = {}): Promise<Detection[]> {
    const res = await this.post(session, "ground", { frame_indices: frameIndices, text: query.description }, opts);
    if (res.status === 501) {
      throw new AppError("MODEL_UNAVAILABLE", {
        message: `Text grounding isn't enabled on the ${this.info.name} server.`,
        hint: "Enable GROUNDING_MODEL on the inference server, or click the object instead.",
      });
    }
    const body = await this.json<{ detections?: Array<{ frame_index: number; box: Box; score: number; label?: string }> }>(res, "SEGMENTATION_FAILED");
    return (body.detections ?? [])
      .filter((d) => Array.isArray(d.box) && d.box.length === 4 && d.box.every((v) => Number.isFinite(v)))
      .map((d) => ({
        frameIndex: d.frame_index,
        box: { x0: Math.max(0, d.box[0]), y0: Math.max(0, d.box[1]), x1: Math.min(1, d.box[2]), y1: Math.min(1, d.box[3]) },
        score: Math.max(0, Math.min(1, d.score)),
        label: d.label ?? query.description,
      }));
  }

  async segmentFrame(session: VideoSession, prompt: FramePrompt, opts: CallOptions = {}): Promise<MaskResult> {
    const res = await this.post(
      session,
      "segment",
      {
        frame_index: prompt.frameIndex,
        points: prompt.points.map((p) => [p.x, p.y]),
        labels: prompt.points.map((p) => p.label),
        box: boxToWire(prompt.box),
      },
      opts,
    );
    const body = await this.json<{ frame_index: number; score: number; mask: WireMask }>(res, "SEGMENTATION_FAILED");
    return { frameIndex: prompt.frameIndex, mask: this.decode(session, body.mask), score: body.score ?? 0 };
  }

  async refineMask(
    session: VideoSession,
    req: { frameIndex: number; mask: Uint8Array; points: PointPrompt[] },
    opts: CallOptions = {},
  ): Promise<MaskResult> {
    const res = await this.post(
      session,
      "segment",
      {
        frame_index: req.frameIndex,
        points: req.points.map((p) => [p.x, p.y]),
        labels: req.points.map((p) => p.label),
        mask: { counts: encodeMask(req.mask), size: [session.height, session.width] },
      },
      opts,
    );
    const body = await this.json<{ score: number; mask: WireMask }>(res, "SEGMENTATION_FAILED");
    return { frameIndex: req.frameIndex, mask: this.decode(session, body.mask), score: body.score ?? 0 };
  }

  async trackObject(session: VideoSession, req: TrackRequest, cb: TrackCallbacks): Promise<void> {
    // Failover applies until the stream starts; a stream that breaks midway fails the job.
    const res = await this.post(
      session,
      "propagate",
      {
        keyframes: req.keyframes.map((k) => ({
          frame_index: k.frameIndex,
          points: k.points.map((p) => [p.x, p.y]),
          labels: k.points.map((p) => p.label),
          box: boxToWire(k.box),
          mask: k.mask ? { counts: encodeMask(k.mask), size: [session.height, session.width] } : null,
        })),
        start_frame: req.startFrame,
        end_frame: req.endFrame,
        direction: req.direction,
      },
      { signal: cb.signal },
    );
    if (!res.ok || !res.body) await this.json(res, "TRACKING_FAILED");

    // NDJSON stream: progress / mask / error / done events.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finished = false;
    const handle = async (line: string) => {
      if (!line.trim()) return;
      let ev: { type?: string; frame_index?: number; counts?: number[]; done?: number; total?: number; message?: string };
      try {
        ev = JSON.parse(line);
      } catch (cause) {
        throw new AppError("INVALID_AI_RESPONSE", { cause });
      }
      if (ev.type === "mask" && typeof ev.frame_index === "number") {
        const mask = this.decode(session, { counts: ev.counts ?? [], size: [session.height, session.width] });
        await cb.onFrame(ev.frame_index, mask.some((v) => v) ? mask : null);
      } else if (ev.type === "progress") {
        cb.onProgress?.(ev.done ?? 0, ev.total ?? 0);
      } else if (ev.type === "error") {
        throw new AppError("TRACKING_FAILED", { cause: new Error(ev.message ?? `${this.info.name} propagation failed`) });
      } else if (ev.type === "done") {
        finished = true;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        await handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    await handle(buf);
    if (!finished) throw new AppError("TRACKING_FAILED", { message: `The ${this.info.name} server stopped before finishing.` });
  }

  async disposeVideo(session: VideoSession): Promise<void> {
    await this.request(this.serverFor(session.id), `/v1/sessions/${session.id}`, { method: "DELETE", headers: this.headers() }, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}
