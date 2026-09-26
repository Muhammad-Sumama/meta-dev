"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

/**
 * Before/after comparison of the demo clip. The "after" video was rendered by
 * OpenSAM Studio itself (scripts/generate-hero.ts: three AI commands, then a
 * highlight export) using the bundled mock provider.
 */
export function HeroPreview() {
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(52);
  const dragging = useRef(false);

  useEffect(() => {
    const id = setInterval(() => {
      const va = a.current;
      const vb = b.current;
      if (va && vb && Math.abs(va.currentTime - vb.currentTime) > 0.06) vb.currentTime = va.currentTime;
    }, 500);
    return () => clearInterval(id);
  }, []);

  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setSplit(Math.min(98, Math.max(2, ((clientX - r.left) / r.width) * 100)));
  };

  return (
    <figure className="relative">
      <div className="overflow-hidden rounded-xl border border-border-strong bg-panel shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex h-9 items-center gap-2 border-b border-border px-3">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#3a3e46]" />
            <span className="size-2.5 rounded-full bg-[#3a3e46]" />
            <span className="size-2.5 rounded-full bg-[#3a3e46]" />
          </span>
          <span className="ml-2 flex items-center gap-1.5 rounded-md border border-border bg-panel-2 px-2 py-0.5 text-[11.5px] text-muted">
            <Sparkles className="size-3 text-accent" /> Track the red car, the man in the blue shirt and the dog
          </span>
        </div>
        <div
          ref={box}
          className="relative aspect-video cursor-ew-resize select-none bg-black"
          onPointerDown={(e) => {
            dragging.current = true;
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            move(e.clientX);
          }}
          onPointerMove={(e) => dragging.current && move(e.clientX)}
          onPointerUp={() => (dragging.current = false)}
        >
          <video ref={a} className="absolute inset-0 size-full" autoPlay muted loop playsInline aria-label="Original demo clip">
            <source src="/demo/street-scene.webm" type="video/webm" />
            <source src="/demo/street-scene.mp4" type="video/mp4" />
          </video>
          <video
            ref={b}
            className="absolute inset-0 size-full"
            style={{ clipPath: `inset(0 0 0 ${split}%)` }}
            autoPlay
            muted
            loop
            playsInline
            aria-label="OpenSAM Studio output with the tracked subjects highlighted"
          >
            <source src="/demo/hero-output.webm" type="video/webm" />
            <source src="/demo/hero-output.mp4" type="video/mp4" />
          </video>
          <div className="pointer-events-none absolute inset-y-0 w-px bg-accent shadow-[0_0_10px_rgba(198,244,50,0.6)]" style={{ left: `${split}%` }}>
            <div className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-accent bg-background text-[10px] text-accent">
              ⇆
            </div>
          </div>
          <span className="pointer-events-none absolute left-2 top-2 rounded-sm bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white/80">Original</span>
          <span className="pointer-events-none absolute right-2 top-2 rounded-sm bg-black/60 px-1.5 py-0.5 text-[10.5px] text-white/80">Tracked output</span>
          <input
            type="range"
            min={2}
            max={98}
            value={Math.round(split)}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label="Compare original and output"
            className="sr-only"
          />
        </div>
        <div className="flex h-10 items-center gap-2 border-t border-border px-3">
          <span className="w-12 shrink-0 font-mono text-[10px] text-faint">MASKS</span>
          <div className="relative h-4 flex-1 rounded-[3px] bg-panel-3">
            <div className="absolute inset-y-0 left-0 w-[88%] rounded-[3px] bg-[#c6f432]/75" />
          </div>
          <div className="relative h-4 flex-1 rounded-[3px] bg-panel-3">
            <div className="absolute inset-y-0 left-0 w-full rounded-[3px] bg-[#22d3ee]/70" />
          </div>
          <div className="relative h-4 flex-1 rounded-[3px] bg-panel-3">
            <div className="absolute inset-y-0 left-0 w-full rounded-[3px] bg-[#f472b6]/70" />
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-[12px] text-faint">Drag to compare. Output rendered by OpenSAM Studio in mock mode.</figcaption>
    </figure>
  );
}
