"use client";

import { useEffect, useState } from "react";
import { CircleCheck, CircleX, RefreshCw, TriangleAlert } from "lucide-react";
import { api, errorText, type HealthInfo } from "@/lib/client/api";
import { cn } from "@/lib/utils/cn";
import type { ParsedCommand } from "@/lib/schemas/command";
import { useEditor } from "@/stores/editor";
import { useSystem } from "@/stores/system";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge, Input, Spinner } from "@/components/ui/misc";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

function StatusIcon({ status }: { status: string }) {
  if (status === "ready") return <CircleCheck className="size-4 text-success" />;
  if (status === "degraded") return <TriangleAlert className="size-4 text-warning" />;
  return <CircleX className="size-4 text-danger" />;
}

function QueueStatus({ queue }: { queue: HealthInfo["queue"] }) {
  if ("error" in queue) {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[12px] text-danger">
        <StatusIcon status="unavailable" /> {queue.error}
      </p>
    );
  }
  const idle = Object.entries(queue.workers ?? {}).filter(([, n]) => n === 0).map(([type]) => type);
  return (
    <div className="mt-1.5 text-[12px] text-muted">
      <p>
        {queue.backend === "redis" ? "Redis job queue" : "In-process jobs"} · {queue.running} running / {queue.queued} queued
        {queue.workers
          ? ` · workers: ${Object.entries(queue.workers)
              .map(([type, n]) => `${type} ${n}`)
              .join(", ")}`
          : ` (concurrency ${queue.concurrency})`}
      </p>
      {idle.length > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-warning">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          No worker is taking {idle.join(", ")} jobs — they will wait until one starts (npm run worker).
        </p>
      )}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { health, loading, refresh } = useSystem();
  const showOutlines = useEditor((s) => s.showOutlines);
  const maskOpacity = useEditor((s) => s.maskOpacity);
  const set = useEditor((s) => s.set);
  const [probe, setProbe] = useState("Blur the background behind the woman on the left");
  const [parsed, setParsed] = useState<ParsedCommand | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const test = async () => {
    setProbing(true);
    setProbeError(null);
    try {
      setParsed(await api.parse(probe));
    } catch (err) {
      setParsed(null);
      setProbeError(errorText(err).title);
    } finally {
      setProbing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>AI providers, video processing and editor preferences.</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto px-5 py-4 text-[13px]">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">AI providers</h3>
              <Button variant="ghost" size="xs" onClick={() => void refresh()} disabled={loading}>
                {loading ? <Spinner className="size-3" /> : <RefreshCw />} Refresh
              </Button>
            </div>
            {health ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { title: "Language (command understanding)", p: health.ai.language },
                  { title: "Segmentation & tracking", p: health.ai.segmentation },
                ].map(({ title, p }) => (
                  <div key={title} className="rounded-md border border-border bg-panel-2 p-3">
                    <p className="text-[11.5px] text-faint">{title}</p>
                    <p className="mt-1 flex items-center gap-2 font-medium">
                      <StatusIcon status={p.health.status} /> {p.name}
                      <Badge variant={p.kind === "mock" ? "warning" : "success"}>{p.kind === "mock" ? "Mock" : "Production"}</Badge>
                    </p>
                    <p className="mt-1 text-[12px] leading-snug text-muted">{p.health.message}</p>
                    <p className="mt-1 text-[11.5px] leading-snug text-faint">{p.description}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted">{loading ? "Checking…" : "Status unavailable."}</p>
            )}
            <p className="text-[12px] leading-relaxed text-faint">
              Providers are chosen with environment variables on the server (<code className="font-mono text-muted">LLM_PROVIDER</code>,{" "}
              <code className="font-mono text-muted">SEGMENTATION_PROVIDER</code>). API keys never reach the browser. See the README section “Connecting Llama / SAM 2”.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Test command understanding</h3>
            <div className="flex gap-2">
              <Input value={probe} onChange={(e) => setProbe(e.target.value)} aria-label="Test command" onKeyDown={(e) => e.key === "Enter" && void test()} />
              <Button size="sm" variant="secondary" onClick={() => void test()} disabled={probing || !probe.trim()}>
                {probing ? <Spinner className="size-3.5" /> : "Parse"}
              </Button>
            </div>
            {probeError && <p className="text-danger">{probeError}</p>}
            {parsed && (
              <div>
                <p className="mb-1 text-[11.5px] text-faint">
                  Parsed by {parsed.source === "llama" ? `Llama (${parsed.model})` : parsed.source === "fallback" ? "the fallback parser" : "the built-in parser"} in {parsed.latencyMs} ms
                </p>
                <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-[11px] leading-relaxed text-muted">
                  {JSON.stringify(parsed.command, null, 2)}
                </pre>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Video processing</h3>
            {health ? (
              <div className="rounded-md border border-border bg-panel-2 p-3">
                <p className="flex items-center gap-2 font-medium">
                  <StatusIcon status={health.ffmpeg.available ? "ready" : "unavailable"} />
                  FFmpeg {health.ffmpeg.version ?? "not found"}
                  {health.ffmpeg.source && <Badge>{health.ffmpeg.source.ffmpeg}</Badge>}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(health.ffmpeg.encoders).map(([k, v]) => (
                    <Badge key={k} variant={v ? "default" : "danger"}>
                      {k}
                      {v ? "" : " ✕"}
                    </Badge>
                  ))}
                </div>
                <p className="mt-2 text-[12px] text-muted">
                  Upload limit {health.config.maxUploadMb} MB · max length {Math.round(health.config.maxDurationSeconds / 60)} min · masks computed at {health.config.analysisMaxSize}px
                </p>
                <QueueStatus queue={health.queue} />
                <p className={cn("mt-1 text-[12px]", health.storage.ok ? "text-muted" : "text-danger")}>
                  Projects stored in {health.storage.backend === "postgres" ? "PostgreSQL" : "JSON files"}
                  {health.storage.ok ? "" : ` — ${health.storage.message}`}
                </p>
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">Editor</h3>
            <label className="flex items-center justify-between">
              Mask outlines
              <Switch checked={showOutlines} onCheckedChange={(v) => set("showOutlines", v)} aria-label="Mask outlines" />
            </label>
            <div className="flex items-center justify-between gap-4">
              <span>Mask opacity</span>
              <Slider className="max-w-48" aria-label="Mask opacity" min={0.05} max={1} step={0.05} value={[maskOpacity]} onValueChange={([v]) => set("maskOpacity", v)} />
            </div>
          </section>

          <p className="text-[11.5px] leading-relaxed text-faint">
            OpenSAM Studio is an independent tool built around open AI models including SAM 2 and Llama. It is not affiliated with or endorsed by Meta.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
