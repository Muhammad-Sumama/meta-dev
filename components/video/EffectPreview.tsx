"use client";

import { useEffect, useRef } from "react";
import { growMask } from "@/lib/compositing/alpha";
import { paintAlpha, trackMaskAt } from "@/lib/client/maskRender";
import { useCleanPlate } from "@/hooks/useCleanPlate";
import { useEditor } from "@/stores/editor";
import { useEditorUi } from "../editor/EditorContext";

interface Layers {
  alpha: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  subject: HTMLCanvasElement;
  tmp: HTMLCanvasElement;
  img: ImageData | null;
}

function ensureSize(c: HTMLCanvasElement, w: number, h: number) {
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
}

/**
 * Renders one frame of the output effect with Canvas 2D. Mirrors the export
 * compositor (lib/compositing) closely enough to judge the result live.
 */
function drawEffectFrame(canvas: HTMLCanvasElement, v: HTMLVideoElement, layersRef: { current: Layers | null }, plate: HTMLCanvasElement | null, frame: number) {
  const s = useEditor.getState();
  const p = s.project;
  if (!p || v.readyState < 2) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const mw = p.analysis.width;
  const mh = p.analysis.height;
  if (!layersRef.current) {
    const mk = () => document.createElement("canvas");
    layersRef.current = { alpha: mk(), mask: mk(), subject: mk(), tmp: mk(), img: null };
  }
  const L = layersRef.current;
  for (const c of [L.mask, L.subject, L.tmp]) ensureSize(c, W, H);
  if (L.alpha.width !== mw || L.alpha.height !== mh) {
    ensureSize(L.alpha, mw, mh);
    L.img = null;
  }
  const actx = L.alpha.getContext("2d")!;
  L.img ??= actx.createImageData(mw, mh);

  // Subject alpha at mask resolution (union of subject tracks, grown/shrunk).
  const comp = s.doc.composite;
  const subjectIds = comp.subjectTrackIds.length ? comp.subjectTrackIds : s.doc.order.filter((id) => s.doc.tracks[id]?.visible);
  const masks: Uint8Array[] = [];
  for (const id of subjectIds) {
    const t = s.doc.tracks[id];
    const m = t ? trackMaskAt(t, frame) : null;
    if (m) masks.push(m);
  }
  const toMask = mh / p.video.height;
  const expandPx = comp.expand * toMask + (comp.effect === "remove_object" ? 2 : 0);
  let alphaSrc: Uint8Array | null = masks[0] ?? null;
  if (masks.length > 1 || (alphaSrc && Math.abs(expandPx) >= 0.5)) {
    const union = new Uint8Array(mw * mh);
    for (const m of masks) for (let i = 0; i < m.length; i++) if (m[i]) union[i] = 1;
    alphaSrc = Math.abs(expandPx) >= 0.5 ? growMask(union, mw, mh, expandPx) : union;
  }
  paintAlpha(L.img, alphaSrc ? [alphaSrc] : []);
  actx.putImageData(L.img, 0, 0);

  // Feathered matte at preview resolution.
  const featherPx = (comp.feather * H) / p.video.height + H / mh / 2;
  const mctx = L.mask.getContext("2d")!;
  mctx.clearRect(0, 0, W, H);
  mctx.filter = featherPx >= 0.5 ? `blur(${featherPx.toFixed(1)}px)` : "none";
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(L.alpha, 0, 0, W, H);
  mctx.filter = "none";

  // Subject layer = video masked by the matte.
  const sctx = L.subject.getContext("2d")!;
  sctx.globalCompositeOperation = "source-over";
  sctx.clearRect(0, 0, W, H);
  sctx.drawImage(v, 0, 0, W, H);
  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(L.mask, 0, 0);
  sctx.globalCompositeOperation = "source-over";

  const maskedLayer = (source: CanvasImageSource, filter = "none") => {
    const tctx = L.tmp.getContext("2d")!;
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, W, H);
    tctx.filter = filter;
    tctx.drawImage(source, 0, 0, W, H);
    tctx.filter = "none";
    tctx.globalCompositeOperation = "destination-in";
    tctx.drawImage(L.mask, 0, 0);
    tctx.globalCompositeOperation = "source-over";
    return L.tmp;
  };

  const blurPx = Math.max(1, H * (0.004 + 0.03 * comp.blurStrength));
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, W, H);
  switch (comp.effect) {
    case "remove_background":
      ctx.drawImage(L.subject, 0, 0);
      break;
    case "replace_background":
      ctx.fillStyle = comp.backgroundColor;
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(L.subject, 0, 0);
      break;
    case "blur_background":
      ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
      ctx.drawImage(v, 0, 0, W, H);
      ctx.filter = "none";
      ctx.drawImage(L.subject, 0, 0);
      break;
    case "blur_object":
      ctx.drawImage(v, 0, 0, W, H);
      ctx.drawImage(maskedLayer(v, `blur(${blurPx.toFixed(1)}px)`), 0, 0);
      break;
    case "highlight":
      ctx.filter = `grayscale(0.65) brightness(${(1 - comp.dim * 0.85).toFixed(2)})`;
      ctx.drawImage(v, 0, 0, W, H);
      ctx.filter = "none";
      ctx.drawImage(L.subject, 0, 0);
      break;
    case "remove_object":
      ctx.drawImage(v, 0, 0, W, H);
      if (plate) ctx.drawImage(maskedLayer(plate), 0, 0);
      break;
    default:
      ctx.drawImage(v, 0, 0, W, H);
  }
}

/** Live preview of the output effect, redrawn on every presented video frame. */
export function EffectPreview() {
  const { video } = useEditorUi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layersRef = useRef<Layers | null>(null);
  const project = useEditor((s) => s.project);
  const composite = useEditor((s) => s.doc.composite);
  const doc = useEditor((s) => s.doc);
  const frame = useEditor((s) => s.currentFrame);
  const plate = useCleanPlate(composite.effect === "remove_object");

  // Every presented frame during playback.
  useEffect(
    () =>
      video.subscribeFrames((f) => {
        if (canvasRef.current && video.el) drawEffectFrame(canvasRef.current, video.el, layersRef, plate.current, f);
      }),
    [video, plate],
  );

  // Document edits, seeks and plate updates while paused.
  useEffect(() => {
    const el = video.el;
    const redraw = () => {
      if (canvasRef.current && el) drawEffectFrame(canvasRef.current, el, layersRef, plate.current, useEditor.getState().currentFrame);
    };
    redraw();
    if (!el) return;
    el.addEventListener("seeked", redraw);
    el.addEventListener("loadeddata", redraw);
    return () => {
      el.removeEventListener("seeked", redraw);
      el.removeEventListener("loadeddata", redraw);
    };
  }, [video, plate, doc, frame]);

  const scale = project ? Math.min(1, 1280 / project.video.width) : 1;
  return (
    <>
      <canvas
        ref={canvasRef}
        width={Math.round((project?.video.width ?? 2) * scale)}
        height={Math.round((project?.video.height ?? 2) * scale)}
        aria-label="Effect preview"
        className="pointer-events-none absolute inset-0 size-full"
      />
      {composite.effect === "remove_object" && plate.status === "building" && (
        <span className="pointer-events-none absolute bottom-2 left-2 rounded-sm bg-black/70 px-2 py-1 text-[11px] text-white/85">Building clean plate…</span>
      )}
    </>
  );
}
