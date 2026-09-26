"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Film, Minus, Plus } from "lucide-react";
import { toggleTrackVisibility } from "@/lib/client/actions";
import { api } from "@/lib/client/api";
import { coverageRanges } from "@/lib/mask/rle";
import type { Job } from "@/lib/schemas/job";
import type { Track } from "@/lib/schemas/project";
import { cn } from "@/lib/utils/cn";
import { formatBytes, formatFps, formatTime } from "@/lib/utils/format";
import { useEditor } from "@/stores/editor";
import { Hint } from "@/components/ui/tooltip";
import { useEditorUi } from "../editor/EditorContext";

const GUTTER = 148;
const LANE_H = 30;
const VIDEO_LANE_H = 40;
const RULER_H = 22;

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function tickLabel(t: number, step: number) {
  if (step < 1) return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  return formatTime(t);
}

export function Timeline() {
  const { video } = useEditorUi();
  const project = useEditor((s) => s.project)!;
  const frame = useEditor((s) => s.currentFrame);
  const order = useEditor((s) => s.doc.order);
  const tracks = useEditor((s) => s.doc.tracks);
  const selectedId = useEditor((s) => s.selectedTrackId);
  const jobs = useEditor((s) => s.jobs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(600);
  const [zoom, setZoom] = useState(1);
  const scrubbing = useRef(false);

  const { fps, frameCount, duration } = project.video;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setViewport(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const contentW = Math.max(viewport - 16, 100) * zoom;
  const pxPerFrame = contentW / frameCount;
  const xOf = (f: number) => f * pxPerFrame;

  const step = TICK_STEPS.find((s) => (s * fps * pxPerFrame) >= 64) ?? 600;
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  }, [duration, step]);

  // Keep the playhead in view while playing / stepping when zoomed in.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom === 1) return;
    const x = xOf(frame);
    if (x < el.scrollLeft + 20 || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - el.clientWidth / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, zoom]);

  const frameFromEvent = (e: React.PointerEvent) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left + el.scrollLeft - 8;
    return Math.max(0, Math.min(frameCount - 1, Math.floor(x / pxPerFrame)));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-segment]")) return;
    scrubbing.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    video.seekFrame(frameFromEvent(e));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (scrubbing.current) video.seekFrame(frameFromEvent(e));
  };
  const onPointerUp = () => {
    scrubbing.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -10, PageDown: 10 };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      video.step((e.shiftKey ? 10 : 1) * map[e.key], frame);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      video.seekFrame(e.key === "Home" ? 0 : frameCount - 1);
    }
  };

  const activeSegmentJobs = Object.values(jobs).filter(
    (j) => j.type === "segment" && j.projectId === project.id && (j.status === "queued" || j.status === "processing"),
  );
  const pendingNew = activeSegmentJobs.filter((j) => !j.trackId || !tracks[j.trackId]);

  return (
    <section aria-label="Timeline" className="flex h-full min-h-0 flex-col border-t border-border bg-panel">
      <header className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">Timeline</h2>
        <p className="min-w-0 truncate text-[11.5px] text-muted" title={project.video.originalName}>
          <span className="text-foreground/85">{project.video.originalName}</span>
          <span className="hidden sm:inline">
            {" · "}
            {project.video.width}×{project.video.height} · {formatFps(fps)} · {duration.toFixed(1)}s · {formatBytes(project.video.sizeBytes)}
          </span>
        </p>
        <div className="ml-auto flex items-center gap-1">
          <Hint label="Zoom timeline out">
            <button type="button" aria-label="Zoom timeline out" className="rounded-sm p-1 text-muted hover:bg-panel-3 hover:text-foreground disabled:opacity-40" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
              <Minus className="size-3.5" />
            </button>
          </Hint>
          <span className="w-9 text-center font-mono text-[10.5px] text-faint tabular">{Math.round(zoom * 100)}%</span>
          <Hint label="Zoom timeline in">
            <button type="button" aria-label="Zoom timeline in" className="rounded-sm p-1 text-muted hover:bg-panel-3 hover:text-foreground disabled:opacity-40" disabled={zoom >= 40} onClick={() => setZoom((z) => Math.min(40, z * 1.5))}>
              <Plus className="size-3.5" />
            </button>
          </Hint>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 items-start overflow-y-auto">
        {/* Lane labels */}
        <div className="sticky left-0 shrink-0 border-r border-border" style={{ width: GUTTER }}>
          <div style={{ height: RULER_H }} className="border-b border-border" />
          <div className="flex items-center gap-2 px-3 text-[12px] text-muted" style={{ height: VIDEO_LANE_H }}>
            <Film className="size-3.5 shrink-0" /> Video
          </div>
          <div>
            {order.map((id) => {
              const t = tracks[id];
              if (!t) return null;
              return (
                <div
                  key={id}
                  className={cn("group flex items-center gap-2 pl-3 pr-1 text-[12px]", id === selectedId ? "bg-panel-3 text-foreground" : "text-muted")}
                  style={{ height: LANE_H }}
                >
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => useEditor.getState().selectTrack(id)}>
                    <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: t.color }} />
                    <span className="truncate">{t.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t.visible ? `Hide ${t.name}` : `Show ${t.name}`}
                    className="rounded-sm p-1 text-faint opacity-60 hover:bg-panel-3 hover:text-foreground group-hover:opacity-100"
                    onClick={() => toggleTrackVisibility(id)}
                  >
                    {t.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                  </button>
                </div>
              );
            })}
            {pendingNew.map((j) => (
              <div key={j.id} className="flex items-center gap-2 px-3 text-[12px] text-muted" style={{ height: LANE_H }}>
                <span className="size-2.5 shrink-0 animate-pulse rounded-[3px] bg-accent/70" />
                <span className="truncate italic">{j.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable lanes */}
        <div
          ref={scrollRef}
          role="slider"
          tabIndex={0}
          aria-label="Playhead position"
          aria-valuemin={0}
          aria-valuemax={frameCount - 1}
          aria-valuenow={frame}
          aria-valuetext={`Frame ${frame + 1} of ${frameCount}, ${formatTime(frame / fps)}`}
          className="relative min-w-0 flex-1 self-stretch overflow-x-auto overflow-y-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          onWheel={(e) => {
            if (e.ctrlKey || e.metaKey) setZoom((z) => Math.min(40, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
          }}
        >
          <div className="relative px-2" style={{ width: contentW + 16 }}>
            {/* Ruler */}
            <div className="relative cursor-ew-resize border-b border-border" style={{ height: RULER_H }}>
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full" style={{ left: t * fps * pxPerFrame }}>
                  <div className="h-2 w-px bg-border-strong" />
                  <span className="absolute left-1 top-1.5 whitespace-nowrap font-mono text-[10px] text-faint tabular">{tickLabel(t, step)}</span>
                </div>
              ))}
            </div>

            {/* Video lane */}
            <Filmstrip projectId={project.id} width={contentW} />

            {/* Mask lanes */}
            {order.map((id) =>
              tracks[id] ? (
                <MaskLane
                  key={id}
                  track={tracks[id]}
                  pxPerFrame={pxPerFrame}
                  selected={id === selectedId}
                  jobs={activeSegmentJobs.filter((j) => j.trackId === id)}
                  onSelect={(f) => {
                    useEditor.getState().selectTrack(id);
                    const cur = useEditor.getState().currentFrame;
                    if (f !== null && !tracks[id].frames[cur]) video.seekFrame(f);
                  }}
                />
              ) : null,
            )}
            {pendingNew.map((j) => (
              <div key={j.id} className="relative" style={{ height: LANE_H }}>
                <ProcessingBar job={j} pxPerFrame={pxPerFrame} />
              </div>
            ))}

            {/* Playhead */}
            <div className="pointer-events-none absolute bottom-0 top-0 z-10" style={{ left: 8 + xOf(frame) + pxPerFrame / 2 }}>
              <div className="absolute -left-[5px] top-0 h-2.5 w-[11px] rounded-b-[3px] bg-accent" />
              <div className="absolute left-0 top-0 h-full w-px bg-accent shadow-[0_0_6px_rgba(198,244,50,0.5)]" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const Filmstrip = memo(function Filmstrip({ projectId, width }: { projectId: string; width: number }) {
  const strip = useEditor((s) => s.project?.media.filmstrip);
  const ready = strip?.status === "ready" && strip.count > 0;
  const tileH = VIDEO_LANE_H - 6;
  const tileW = ready ? (strip.tileWidth * tileH) / strip.tileHeight : 60;
  const n = Math.max(1, Math.ceil(width / tileW));
  return (
    <div className="relative flex overflow-hidden border-b border-border py-[3px]" style={{ height: VIDEO_LANE_H }}>
      {ready ? (
        Array.from({ length: n }, (_, i) => {
          const idx = Math.min(strip.count - 1, Math.floor((i * strip.count) / n));
          return (
            <div
              key={i}
              className="h-full shrink-0 border-r border-black/40 bg-no-repeat first:rounded-l-[3px] last:rounded-r-[3px]"
              style={{
                width: Math.min(tileW, width - i * tileW),
                backgroundImage: `url(${api.mediaUrl(projectId, "filmstrip")})`,
                backgroundSize: `${strip.count * tileW}px ${tileH}px`,
                backgroundPosition: `-${idx * tileW}px 0`,
              }}
            />
          );
        })
      ) : (
        <div className="h-full w-full rounded-[3px] bg-panel-3/60" />
      )}
    </div>
  );
});

const MaskLane = memo(function MaskLane({
  track,
  pxPerFrame,
  selected,
  jobs,
  onSelect,
}: {
  track: Track;
  pxPerFrame: number;
  selected: boolean;
  jobs: Job[];
  onSelect(frame: number | null): void;
}) {
  const ranges = useMemo(() => coverageRanges(track.frames, 2), [track.frames]);
  const keyframes = useMemo(() => [...new Set(track.prompts.map((p) => p.frameIndex))], [track.prompts]);
  const label = track.source === "ai" ? "AI tracked" : track.trackedRange ? "Tracked" : "Manual mask";
  return (
    <div className={cn("relative border-b border-border/60", selected && "bg-white/[0.025]")} style={{ height: LANE_H }}>
      {ranges.map(([a, b]) => {
        const w = Math.max(3, (b - a + 1) * pxPerFrame);
        return (
          <button
            key={a}
            type="button"
            data-segment
            onClick={() => onSelect(a)}
            aria-label={`${track.name}: ${label}, frames ${a + 1}–${b + 1}`}
            className={cn(
              "absolute top-[5px] flex h-[20px] items-center overflow-hidden rounded-[3px] px-1.5 text-left text-[10.5px] font-medium text-black/80 transition-[filter,box-shadow] hover:brightness-110",
              selected ? "ring-1 ring-white/70" : "opacity-85",
              !track.visible && "opacity-35",
            )}
            style={{ left: a * pxPerFrame, width: w, background: `color-mix(in oklab, ${track.color} 80%, transparent)` }}
          >
            {w > 70 && <span className="truncate">{label}</span>}
          </button>
        );
      })}
      {keyframes.map((f) => (
        <span
          key={f}
          aria-hidden="true"
          title={`Prompt on frame ${f + 1}`}
          className="pointer-events-none absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-black/60 bg-white"
          style={{ left: (f + 0.5) * pxPerFrame }}
        />
      ))}
      {jobs.map((j) => (
        <ProcessingBar key={j.id} job={j} pxPerFrame={pxPerFrame} />
      ))}
    </div>
  );
});

function ProcessingBar({ job, pxPerFrame }: { job: Job; pxPerFrame: number }) {
  const range = job.frameRange ?? { start: 0, end: 0 };
  const w = (range.end - range.start + 1) * pxPerFrame;
  return (
    <div
      className="processing-stripes absolute top-[5px] h-[20px] overflow-hidden rounded-[3px] border border-accent/40 animate-stripes"
      style={{ left: range.start * pxPerFrame, width: Math.max(4, w) }}
      role="progressbar"
      aria-label={`${job.label}: ${job.progress.message}`}
      aria-valuenow={Math.round(job.progress.fraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full bg-accent/35 transition-[width] duration-300" style={{ width: `${job.progress.fraction * 100}%` }} />
      {w > 120 && (
        <span className="absolute inset-0 flex items-center px-2 text-[10.5px] font-medium text-foreground/90">
          {job.status === "queued" ? "Queued…" : job.progress.message}
        </span>
      )}
    </div>
  );
}
