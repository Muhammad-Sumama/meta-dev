"use client";

import { ChevronLeft, ChevronRight, Eye, EyeOff, Maximize, Pause, Play, SkipBack, SkipForward, Sparkles, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/misc";
import { Slider } from "@/components/ui/slider";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/cn";
import { formatTimecode } from "@/lib/utils/format";
import { useEditor } from "@/stores/editor";
import { useEditorUi } from "../editor/EditorContext";

export function TransportBar() {
  const { video } = useEditorUi();
  const project = useEditor((s) => s.project)!;
  const frame = useEditor((s) => s.currentFrame);
  const playing = useEditor((s) => s.playing);
  const zoom = useEditor((s) => s.zoom);
  const masksVisible = useEditor((s) => s.masksVisible);
  const opacity = useEditor((s) => s.maskOpacity);
  const previewEffect = useEditor((s) => s.previewEffect);
  const effect = useEditor((s) => s.doc.composite.effect);
  const set = useEditor((s) => s.set);

  const { fps, frameCount } = project.video;
  const zoomValue = typeof zoom === "number" ? zoom : null;
  const stepZoom = (dir: 1 | -1) => {
    const base = zoomValue ?? 1;
    set("zoom", Math.min(8, Math.max(0.1, dir > 0 ? base * 1.25 : base / 1.25)));
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-t border-border bg-panel px-2 sm:gap-2 sm:px-3">
      <div className="flex items-center">
        <Hint label="First frame" shortcut="Home">
          <Button variant="ghost" size="icon-sm" aria-label="First frame" onClick={() => video.seekFrame(0)} className="hidden sm:inline-flex">
            <SkipBack />
          </Button>
        </Hint>
        <Hint label="Previous frame" shortcut="←">
          <Button variant="ghost" size="icon-sm" aria-label="Previous frame" onClick={() => video.step(-1, frame)}>
            <ChevronLeft />
          </Button>
        </Hint>
        <Hint label={playing ? "Pause" : "Play"} shortcut="Space">
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => video.toggle()}
            className="mx-0.5 rounded-full"
          >
            {playing ? <Pause className="fill-current" /> : <Play className="translate-x-px fill-current" />}
          </Button>
        </Hint>
        <Hint label="Next frame" shortcut="→">
          <Button variant="ghost" size="icon-sm" aria-label="Next frame" onClick={() => video.step(1, frame)}>
            <ChevronRight />
          </Button>
        </Hint>
        <Hint label="Last frame" shortcut="End">
          <Button variant="ghost" size="icon-sm" aria-label="Last frame" onClick={() => video.seekFrame(frameCount - 1)} className="hidden sm:inline-flex">
            <SkipForward />
          </Button>
        </Hint>
      </div>

      <div className="flex min-w-0 items-baseline gap-2 font-mono text-[12px] tabular" aria-live="off">
        <span className="text-foreground" aria-label="Current timecode">{formatTimecode(frame, fps)}</span>
        <span className="hidden text-faint sm:inline">/ {formatTimecode(frameCount - 1, fps)}</span>
        <span className="hidden text-faint md:inline">
          · frame {frame + 1}/{frameCount}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Hint label={masksVisible ? "Hide masks" : "Show masks"} shortcut="O">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-pressed={masksVisible}
            aria-label={masksVisible ? "Hide masks" : "Show masks"}
            onClick={() => set("masksVisible", !masksVisible)}
          >
            {masksVisible ? <Eye /> : <EyeOff />}
          </Button>
        </Hint>
        <div className="hidden w-24 items-center lg:flex" title="Mask opacity">
          <Slider
            aria-label="Mask opacity"
            min={0.05}
            max={1}
            step={0.05}
            value={[opacity]}
            onValueChange={([v]) => set("maskOpacity", v)}
            disabled={!masksVisible}
          />
        </div>
        <Hint label={previewEffect ? "Show masks only" : "Preview the output effect"} shortcut="P">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={previewEffect}
            onClick={() => set("previewEffect", !previewEffect)}
            className={cn("hidden sm:inline-flex", previewEffect && effect !== "none" && "text-accent hover:text-accent")}
            disabled={effect === "none"}
          >
            <Sparkles />
            <span className="hidden xl:inline">Preview</span>
          </Button>
        </Hint>
        <Separator orientation="vertical" className="mx-1 hidden h-5 sm:block" />
        <Hint label="Zoom out">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => stepZoom(-1)} className="hidden sm:inline-flex">
            <ZoomOut />
          </Button>
        </Hint>
        <button
          type="button"
          className="hidden w-12 rounded-sm py-1 text-center font-mono text-[11px] text-muted tabular hover:bg-panel-3 hover:text-foreground sm:block"
          onClick={() => set("zoom", 1)}
          aria-label="Zoom to 100%"
          title="Zoom to 100%"
        >
          {zoomValue ? `${Math.round(zoomValue * 100)}%` : "Fit"}
        </button>
        <Hint label="Zoom in">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => stepZoom(1)} className="hidden sm:inline-flex">
            <ZoomIn />
          </Button>
        </Hint>
        <Hint label="Fit to canvas" shortcut="F">
          <Button variant="ghost" size="icon-sm" aria-label="Fit to canvas" onClick={() => set("zoom", "fit")}>
            <Maximize />
          </Button>
        </Hint>
      </div>
    </div>
  );
}
