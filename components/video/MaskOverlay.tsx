"use client";

import { useEffect, useRef } from "react";
import { paintOverlay } from "@/lib/client/maskRender";
import { useDraft } from "@/stores/draft";
import { useEditor } from "@/stores/editor";

/** Colored mask overlay drawn at mask resolution and scaled by CSS. */
export function MaskOverlay({ outlineOnly = false }: { outlineOnly?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<ImageData | null>(null);
  const project = useEditor((s) => s.project);
  const frame = useEditor((s) => s.currentFrame);
  const tracks = useEditor((s) => s.doc.tracks);
  const order = useEditor((s) => s.doc.order);
  const selectedId = useEditor((s) => s.selectedTrackId);
  const visible = useEditor((s) => s.masksVisible);
  const opacity = useEditor((s) => s.maskOpacity);
  const outlines = useEditor((s) => s.showOutlines);
  const draftVersion = useDraft((s) => s.version);

  const w = project?.analysis.width ?? 1;
  const h = project?.analysis.height ?? 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!imageRef.current || imageRef.current.width !== w || imageRef.current.height !== h) {
      imageRef.current = ctx.createImageData(w, h);
    }
    const draft = useDraft.getState();
    const list = order.map((id) => tracks[id]).filter(Boolean);
    if (draft.trackId === "__new__" && draft.mask) {
      // Brush stroke that will create a new object on release.
      list.push({ id: "__new__", name: "", color: "#c6f432", visible: true, source: "manual", provider: "manual", width: w, height: h, prompts: [], frames: {}, createdAt: "", updatedAt: "" });
    }
    paintOverlay(imageRef.current, list, frame, {
      selectedId,
      outlines: outlines || outlineOnly,
      draft: draft.trackId && draft.mask ? { trackId: draft.trackId, mask: draft.mask } : null,
    });
    if (outlineOnly) {
      const d = imageRef.current.data;
      for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) d[i] = 0;
    }
    ctx.putImageData(imageRef.current, 0, 0);
  }, [w, h, frame, tracks, order, selectedId, outlines, outlineOnly, draftVersion]);

  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      aria-hidden="true"
      data-layer="masks"
      className="pointer-events-none absolute inset-0 size-full transition-opacity duration-150"
      style={{ opacity: visible ? (outlineOnly ? 0.9 : Math.max(0.05, opacity * 1.6)) : 0 }}
    />
  );
}
