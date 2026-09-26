"use client";

import { useRef, useState } from "react";
import { applyStroke, segmentPrompt, selectAndTrack } from "@/lib/client/actions";
import { decodeCached } from "@/lib/client/maskRender";
import { stampStroke, type Pt } from "@/lib/mask/edit";
import { maskForFrame } from "@/lib/mask/rle";
import { cn } from "@/lib/utils/cn";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";
import { useEditorUi } from "../editor/EditorContext";

interface Props {
  onPan(dx: number, dy: number): void;
}

const CURSORS = {
  select: "cursor-crosshair",
  track: "cursor-crosshair",
  box: "cursor-crosshair",
  brush: "cursor-none",
  eraser: "cursor-none",
  hand: "cursor-grab active:cursor-grabbing",
} as const;

/**
 * Pointer handling for the canvas tools. Produces the prompts the
 * segmentation backend receives: positive/negative points, boxes, and brush
 * masks — all in normalized coordinates.
 */
export function InteractionLayer({ onPan }: Props) {
  const { video } = useEditorUi();
  const ref = useRef<HTMLDivElement>(null);
  const tool = useEditor((s) => s.tool);
  const selectMode = useEditor((s) => s.selectMode);
  const brushSize = useEditor((s) => s.brushSize);
  const project = useEditor((s) => s.project);
  const frame = useEditor((s) => s.currentFrame);
  const selected = useEditor((s) => (s.selectedTrackId ? s.doc.tracks[s.selectedTrackId] : null));
  const segmenting = useEditor((s) => s.segmenting);

  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; scale: number } | null>(null);
  const drag = useRef<{ kind: "box" | "brush" | "pan"; start: { x: number; y: number }; last: { x: number; y: number }; pts: Pt[]; mask?: Uint8Array } | null>(null);

  if (!project) return null;
  const mw = project.analysis.width;
  const mh = project.analysis.height;

  const norm = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      px: e.clientX - r.left,
      py: e.clientY - r.top,
      scale: r.width / mw,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    video.pause();
    const p = norm(e);
    if (tool === "hand") {
      drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, last: { x: e.clientX, y: e.clientY }, pts: [] };
    } else if (tool === "box") {
      drag.current = { kind: "box", start: { x: p.x, y: p.y }, last: { x: p.x, y: p.y }, pts: [] };
      setBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    } else if (tool === "brush" || tool === "eraser") {
      const pt = { x: p.x * mw, y: p.y * mh };
      const current = selected ? maskForFrame(selected.frames, frame, 0) : null;
      const base = current ? decodeCached(current.counts, mw * mh).slice() : new Uint8Array(mw * mh);
      stampStroke(base, mw, mh, [pt], brushSize, tool === "brush" ? 1 : 0);
      drag.current = { kind: "brush", start: pt, last: pt, pts: [pt], mask: base };
      useDraft.getState().setDraft(selected?.id ?? "__new__", base);
    } else {
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = norm(e);
    if (tool === "brush" || tool === "eraser") setCursor({ x: p.px, y: p.py, scale: p.scale });
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      onPan(e.clientX - d.last.x, e.clientY - d.last.y);
      d.last = { x: e.clientX, y: e.clientY };
    } else if (d.kind === "box") {
      d.last = { x: p.x, y: p.y };
      setBox({ x0: Math.min(d.start.x, p.x), y0: Math.min(d.start.y, p.y), x1: Math.max(d.start.x, p.x), y1: Math.max(d.start.y, p.y) });
    } else if (d.kind === "brush" && d.mask) {
      const pt = { x: p.x * mw, y: p.y * mh };
      stampStroke(d.mask, mw, mh, [d.last, pt], brushSize, tool === "brush" ? 1 : 0);
      d.pts.push(pt);
      d.last = pt;
      useDraft.getState().setDraft(selected?.id ?? "__new__", d.mask);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "box") {
      setBox(null);
      const b = { x0: Math.min(d.start.x, d.last.x), y0: Math.min(d.start.y, d.last.y), x1: Math.max(d.start.x, d.last.x), y1: Math.max(d.start.y, d.last.y) };
      if ((b.x1 - b.x0) * mw > 3 && (b.y1 - b.y0) * mh > 3) void segmentPrompt({ frame, box: b });
    } else if (d.kind === "brush") {
      applyStroke(d.pts, tool === "brush" ? "add" : "erase");
      useDraft.getState().setDraft(null, null);
    }
  };

  const onClick = (e: React.MouseEvent) => {
    if (tool !== "select" && tool !== "track") return;
    const p = norm(e);
    const label: 0 | 1 = e.altKey || selectMode === "subtract" ? 0 : 1;
    if (tool === "track") void selectAndTrack(frame, { x: p.x, y: p.y, label: 1 });
    else void segmentPrompt({ frame, point: { x: p.x, y: p.y, label }, newObject: e.shiftKey || undefined });
  };

  const prompts = selected?.prompts.find((pr) => pr.frameIndex === frame);
  const radiusPx = cursor ? brushSize * cursor.scale : 0;

  return (
    <div
      ref={ref}
      role="application"
      aria-label={`Video canvas — ${tool} tool. ${tool === "select" ? "Click an object to select it." : tool === "box" ? "Drag a box around an object." : tool === "brush" ? "Paint to add to the mask." : tool === "eraser" ? "Paint to remove from the mask." : tool === "track" ? "Click an object to select and track it." : "Drag to pan."}`}
      className={cn("absolute inset-0 touch-none select-none", CURSORS[tool], segmenting && "cursor-progress")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onClick={onClick}
    >
      {prompts?.box && (
        <div
          className="pointer-events-none absolute border border-dashed border-accent/70"
          style={{
            left: `${prompts.box.x0 * 100}%`,
            top: `${prompts.box.y0 * 100}%`,
            width: `${(prompts.box.x1 - prompts.box.x0) * 100}%`,
            height: `${(prompts.box.y1 - prompts.box.y0) * 100}%`,
          }}
        />
      )}
      {prompts?.points.map((pt, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-[10px] font-bold leading-none text-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]",
            pt.label === 1 ? "bg-emerald-500" : "bg-rose-500",
          )}
          style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
        >
          {pt.label === 1 ? "+" : "−"}
        </span>
      ))}
      {box && (
        <div
          className="pointer-events-none absolute border-2 border-accent bg-accent/10"
          style={{ left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%`, width: `${(box.x1 - box.x0) * 100}%`, height: `${(box.y1 - box.y0) * 100}%` }}
        />
      )}
      {cursor && (tool === "brush" || tool === "eraser") && (
        <span
          aria-hidden="true"
          className={cn("pointer-events-none absolute rounded-full border", tool === "brush" ? "border-accent" : "border-rose-400 border-dashed")}
          style={{ left: cursor.x - radiusPx, top: cursor.y - radiusPx, width: radiusPx * 2, height: radiusPx * 2 }}
        />
      )}
    </div>
  );
}
