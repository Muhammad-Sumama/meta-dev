"use client";

import { Minus, Plus, ScanLine } from "lucide-react";
import { startTracking } from "@/lib/client/actions";
import { useEditor } from "@/stores/editor";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/misc";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Hint } from "@/components/ui/tooltip";

const HINTS: Record<string, string> = {
  select: "Click an object to select it. Click again to add, Alt+click to remove. Shift+click starts a new object.",
  track: "Click an object — it's segmented and tracked through the whole video.",
  box: "Drag a rough box around an object.",
  brush: "Paint to add to the selected object's mask.",
  eraser: "Paint to remove from the selected object's mask.",
  hand: "Drag to pan. Ctrl/⌘ + scroll to zoom.",
};

/** Contextual options for the active tool, including edit scope (frame vs. sequence). */
export function ToolOptions() {
  const tool = useEditor((s) => s.tool);
  const selectMode = useEditor((s) => s.selectMode);
  const editScope = useEditor((s) => s.editScope);
  const brushSize = useEditor((s) => s.brushSize);
  const selected = useEditor((s) => (s.selectedTrackId ? s.doc.tracks[s.selectedTrackId] : null));
  const tracking = useEditor((s) => Object.values(s.jobs).some((j) => j.type === "segment" && j.trackId === s.selectedTrackId && (j.status === "queued" || j.status === "processing")));
  const set = useEditor((s) => s.set);
  const hasFrames = selected ? Object.keys(selected.frames).length > 0 : false;

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-panel px-3 text-[12px]">
      {tool === "select" && (
        <ToggleGroup type="single" value={selectMode} onValueChange={(v) => v && set("selectMode", v as "add" | "subtract")} aria-label="Selection mode">
          <ToggleGroupItem value="add" aria-label="Add to selection">
            <Plus /> Add
          </ToggleGroupItem>
          <ToggleGroupItem value="subtract" aria-label="Remove from selection">
            <Minus /> Subtract
          </ToggleGroupItem>
        </ToggleGroup>
      )}

      {(tool === "brush" || tool === "eraser") && (
        <div className="flex items-center gap-2">
          <span className="text-muted">Size</span>
          <Slider className="w-28" aria-label="Brush size" min={1} max={80} step={1} value={[brushSize]} onValueChange={([v]) => set("brushSize", v)} />
          <span className="w-8 font-mono text-[11px] text-faint tabular">{brushSize}px</span>
        </div>
      )}

      {(tool === "select" || tool === "brush" || tool === "eraser") && (
        <>
          <Separator orientation="vertical" className="h-5" />
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap text-muted">Apply to</span>
            <ToggleGroup type="single" value={editScope} onValueChange={(v) => v && set("editScope", v as "frame" | "sequence")} aria-label="Edit scope">
              <Hint label={tool === "select" ? "Edits change only the current frame" : "Strokes change only the current frame"}>
                <ToggleGroupItem value="frame">This frame</ToggleGroupItem>
              </Hint>
              <Hint label={tool === "select" ? "After a click, re-track forward from this frame" : "Strokes apply to every masked frame of the object"}>
                <ToggleGroupItem value="sequence">Whole sequence</ToggleGroupItem>
              </Hint>
            </ToggleGroup>
          </div>
        </>
      )}

      <p className="hidden min-w-0 truncate text-faint lg:block">{HINTS[tool]}</p>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {selected ? (
          <>
            <span className="flex items-center gap-1.5 text-muted">
              <span className="size-2.5 rounded-[3px]" style={{ background: selected.color }} />
              <span className="max-w-32 truncate">{selected.name}</span>
            </span>
            <Button size="xs" variant="secondary" disabled={!hasFrames || tracking} onClick={() => void startTracking(selected.id, { mode: "full" })}>
              <ScanLine /> {tracking ? "Tracking…" : "Track"}
            </Button>
          </>
        ) : (
          <span className="text-faint">No object selected</span>
        )}
      </div>
    </div>
  );
}
