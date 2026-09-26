"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Film, TriangleAlert } from "lucide-react";
import { api } from "@/lib/client/api";
import { needsVp9Preview, previewSrc } from "@/lib/client/codecs";
import { Progress, Spinner } from "@/components/ui/misc";
import { cn } from "@/lib/utils/cn";
import { useEditor } from "@/stores/editor";
import { useEditorUi } from "../editor/EditorContext";
import { EffectPreview } from "./EffectPreview";
import { InteractionLayer } from "./InteractionLayer";
import { MaskOverlay } from "./MaskOverlay";

/**
 * Central canvas: the <video> element (streamed with HTTP range requests),
 * the effect preview, the mask overlay and the tool interaction layer, all
 * sharing one transformed "stage" so zoom/pan keep them aligned.
 */
export function VideoStage() {
  const { video } = useEditorUi();
  const project = useEditor((s) => s.project)!;
  const zoom = useEditor((s) => s.zoom);
  const effect = useEditor((s) => s.doc.composite.effect);
  const previewEffect = useEditor((s) => s.previewEffect);
  const hasSubject = useEditor((s) => s.doc.order.length > 0);
  const segmenting = useEditor((s) => s.segmenting);
  const busyAI = useEditor((s) => Object.values(s.jobs).some((j) => j.type === "segment" && (j.status === "queued" || j.status === "processing")));
  const ingest = useEditor((s) => Object.values(s.jobs).find((j) => j.type === "ingest" && j.projectId === s.project?.id && (j.status === "queued" || j.status === "processing")));

  const containerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [videoError, setVideoError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Returning to "fit" recenters the canvas (state adjusted during render, not in an effect).
  const [prevZoom, setPrevZoom] = useState(zoom);
  if (zoom !== prevZoom) {
    setPrevZoom(zoom);
    if (zoom === "fit") setPan({ x: 0, y: 0 });
  }

  const vw = project.video.width;
  const vh = project.video.height;
  const fit = box.w && box.h ? Math.min((box.w - 24) / vw, (box.h - 24) / vh) : 0;
  const scale = zoom === "fit" ? fit : zoom;

  const setVideoRef = useCallback((el: HTMLVideoElement | null) => video.attach(el), [video]);

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) {
      if (zoom !== "fit") setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      return;
    }
    const next = Math.min(8, Math.max(0.1, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    useEditor.getState().set("zoom", next);
  };

  // Keep ctrl+wheel from zooming the page.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const prevent = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    el.addEventListener("wheel", prevent, { passive: false });
    return () => el.removeEventListener("wheel", prevent);
  }, []);

  const src = previewSrc(project);
  const vp9 = needsVp9Preview(project);
  const proxyPending = src === null;
  const proxyFailed = vp9 ? project.media.vp9Proxy?.status === "failed" : project.media.proxy.status === "failed";

  // Browsers without an H.264 decoder get a VP9 preview, generated on demand.
  const vp9Status = project.media.vp9Proxy?.status ?? "none";
  useEffect(() => {
    if (!vp9 || vp9Status === "ready" || vp9Status === "failed") return;
    let cancelled = false;
    api
      .requestPreviewProxy(project.id)
      .then(({ project: p, job }) => {
        if (cancelled) return;
        useEditor.getState().setProject(p);
        if (job) useEditor.getState().upsertJob(job);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [vp9, vp9Status, project.id]);
  const showEffect = previewEffect && effect !== "none" && hasSubject;

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_center,#12151a_0%,#0a0b0d_70%)]"
      onWheel={onWheel}
    >
      {scale > 0 && !proxyPending && (
        <div
          className={cn(
            "absolute left-1/2 top-1/2 overflow-hidden rounded-[2px] shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_20px_60px_-20px_rgba(0,0,0,0.8)]",
            showEffect && effect === "remove_background" ? "checkerboard" : "bg-black",
          )}
          style={{
            width: vw * scale,
            height: vh * scale,
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
          }}
        >
          <video
            key={src}
            ref={setVideoRef}
            src={src ?? undefined}
            poster={project.media.poster ? api.mediaUrl(project.id, "poster") : undefined}
            className={cn("absolute inset-0 size-full", showEffect && "invisible")}
            preload="auto"
            playsInline
            onLoadedData={() => {
              setLoaded(true);
              setVideoError(null);
              video.seekFrame(useEditor.getState().currentFrame);
            }}
            onError={() => setVideoError("Your browser couldn't play this video.")}
          />
          {showEffect && <EffectPreview />}
          <MaskOverlay outlineOnly={showEffect} />
          <InteractionLayer onPan={(dx, dy) => setPan((p) => ({ x: p.x + dx, y: p.y + dy }))} />
        </div>
      )}

      {proxyPending && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-lg border border-border bg-panel p-5 text-center">
            {proxyFailed ? (
              <>
                <TriangleAlert className="mx-auto mb-2 size-6 text-warning" />
                <p className="text-sm font-medium">We couldn&apos;t prepare a preview of this video.</p>
                <p className="mt-1 text-[13px] text-muted">Try re-exporting it as H.264 MP4 and uploading again.</p>
              </>
            ) : (
              <>
                <Film className="mx-auto mb-2 size-6 text-muted" />
                <p className="text-sm font-medium">Preparing a browser-friendly preview…</p>
                <p className="mt-1 text-[13px] text-muted">
                  {vp9
                    ? "Your browser can't decode H.264 video, so we're creating a WebM preview once."
                    : "This format can't play directly in browsers, so we're converting it once."}
                </p>
                <Progress className="mt-4" value={(ingest?.progress.fraction ?? 0) * 100} />
              </>
            )}
          </div>
        </div>
      )}

      {!loaded && !proxyPending && !videoError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner className="size-6 text-muted" />
        </div>
      )}

      {videoError && (
        <div className="absolute inset-x-0 top-4 mx-auto w-fit rounded-md border border-danger/30 bg-panel px-3 py-2 text-[13px] text-danger">
          {videoError}
        </div>
      )}

      {!hasSubject && !segmenting && !busyAI && loaded && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-border-strong bg-panel/95 px-3.5 py-1.5 text-[12.5px] text-muted shadow-lg animate-fade-in">
          <span className="size-1.5 rounded-full bg-accent" />
          Click an object to select it — or describe it to the AI
        </div>
      )}

      {segmenting && (
        <div className="pointer-events-none absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border-strong bg-panel/95 px-3 py-1.5 text-xs text-muted shadow-lg">
          <Spinner className="size-3.5 text-accent" />
          Segmenting…
        </div>
      )}
    </div>
  );
}
