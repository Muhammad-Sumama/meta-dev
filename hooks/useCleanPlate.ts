"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildAlpha } from "@/lib/compositing/alpha";
import { computeCleanPlate, type PlateSample } from "@/lib/compositing/cleanPlate";
import { previewSrc } from "@/lib/client/codecs";
import { trackMaskAt } from "@/lib/client/maskRender";
import { useEditor } from "@/stores/editor";

export type PlateStatus = "idle" | "building" | "ready" | "error";

/**
 * Builds a clean plate in the browser for the "remove object" preview, using
 * the same algorithm as export (lib/compositing/cleanPlate.ts) at preview
 * resolution. Frames are sampled with a hidden <video> element so playback
 * isn't disturbed.
 */
export function useCleanPlate(enabled: boolean) {
  const plateRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<{ version: number; status: PlateStatus }>({ version: 0, status: "idle" });
  const project = useEditor((s) => s.project);
  const composite = useEditor((s) => s.doc.composite);
  const tracks = useEditor((s) => s.doc.tracks);
  const order = useEditor((s) => s.doc.order);

  const subjectIds = composite.subjectTrackIds.length ? composite.subjectTrackIds : order.filter((id) => tracks[id]?.visible);
  const key = subjectIds.map((id) => `${id}:${tracks[id]?.updatedAt ?? ""}`).join("|");

  useEffect(() => {
    const src = project ? previewSrc(project) : null;
    if (!enabled || !project || !key || !src) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.src = src;

    const seek = (t: number) =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          video.removeEventListener("seeked", done);
          video.removeEventListener("error", fail);
          resolve();
        };
        const fail = () => reject(new Error("seek failed"));
        video.addEventListener("seeked", done);
        video.addEventListener("error", fail);
        video.currentTime = t;
      });

    (async () => {
      setState((s) => ({ ...s, status: "building" }));
      await new Promise<void>((resolve, reject) => {
        if (video.readyState >= 1) return resolve();
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("load failed")), { once: true });
      });
      const scale = Math.min(1, 640 / project.video.width);
      const W = Math.max(2, Math.round(project.video.width * scale));
      const H = Math.max(2, Math.round(project.video.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const s = useEditor.getState();
      const subject = subjectIds.map((id) => s.doc.tracks[id]).filter(Boolean);
      const K = Math.min(14, project.video.frameCount);
      const samples: PlateSample[] = [];
      for (let k = 0; k < K; k++) {
        if (cancelled) return;
        const frame = Math.floor(((k + 0.5) * project.video.frameCount) / K);
        await seek((frame + 0.5) / project.video.fps);
        ctx.drawImage(video, 0, 0, W, H);
        const rgba = new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer);
        const masks = subject.map((t) => trackMaskAt(t, frame)).filter((m): m is Uint8Array => m !== null);
        const alpha = masks.length
          ? buildAlpha(masks, project.analysis.width, project.analysis.height, W, H, { expand: 3, feather: 2, sourceHeight: project.video.height })
          : new Uint8Array(W * H);
        samples.push({ rgba, alpha });
      }
      const { plate } = computeCleanPlate(samples, W, H);
      if (cancelled) return;
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const img = new ImageData(W, H);
      img.data.set(plate);
      out.getContext("2d")!.putImageData(img, 0, 0);
      plateRef.current = out;
      setState((st) => ({ version: st.version + 1, status: "ready" }));
    })().catch(() => {
      if (!cancelled) setState((st) => ({ ...st, status: "error" }));
    });

    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the subject tracks
  }, [enabled, project?.id, key, project?.media.vp9Proxy?.status]);

  return useMemo(
    () => ({
      get current() {
        return plateRef.current;
      },
      version: state.version,
      status: state.status,
    }),
    [state],
  );
}
