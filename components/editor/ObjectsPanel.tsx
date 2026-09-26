"use client";

import { useState } from "react";
import { Ellipsis, Eye, EyeOff, Hand, Plus, Repeat, ScanLine, Sparkles, Trash } from "lucide-react";
import { clearFrame, createEmptyTrack, deleteTrack, renameTrack, startTracking, toggleTrackVisibility } from "@/lib/client/actions";
import { addTrack } from "@/lib/client/doc";
import { isEmptyMask } from "@/lib/mask/rle";
import type { Track } from "@/lib/schemas/project";
import { cn } from "@/lib/utils/cn";
import { useEditor } from "@/stores/editor";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/ui/tooltip";

function maskedCount(t: Track) {
  let n = 0;
  for (const k in t.frames) if (!isEmptyMask(t.frames[k])) n++;
  return n;
}

export function ObjectsPanel() {
  const order = useEditor((s) => s.doc.order);
  const tracks = useEditor((s) => s.doc.tracks);
  const selectedId = useEditor((s) => s.selectedTrackId);
  const frame = useEditor((s) => s.currentFrame);
  const jobs = useEditor((s) => s.jobs);
  const [editing, setEditing] = useState<string | null>(null);

  const trackingIds = new Set(
    Object.values(jobs)
      .filter((j) => j.type === "segment" && (j.status === "queued" || j.status === "processing") && j.trackId)
      .map((j) => j.trackId!),
  );

  const newObject = () => {
    const t = createEmptyTrack();
    useEditor.getState().commit("New object", (doc) => addTrack(doc, t), { select: t.id });
    useEditor.getState().setTool("select");
  };

  return (
    <section aria-labelledby="objects-title" className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <h2 id="objects-title" className="text-[13px] font-semibold">
          Objects <span className="font-normal text-faint">{order.length || ""}</span>
        </h2>
        <Hint label="New object — then click it in the video">
          <Button variant="ghost" size="icon-xs" aria-label="New object" onClick={newObject}>
            <Plus />
          </Button>
        </Hint>
      </div>

      {order.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12px] leading-relaxed text-muted">
          No objects yet. Ask the AI above, or click an object in the video with the Select tool.
        </p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Objects">
          {order.map((id) => {
            const t = tracks[id];
            if (!t) return null;
            const selected = id === selectedId;
            const count = maskedCount(t);
            return (
              <li
                key={id}
                className={cn(
                  "group rounded-md border transition-colors",
                  selected ? "border-border-strong bg-panel-3" : "border-transparent hover:bg-panel-2",
                )}
              >
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <span className="size-3 shrink-0 rounded-[3px] ring-1 ring-black/40" style={{ background: t.color }} />
                  {editing === id ? (
                    <input
                      autoFocus
                      defaultValue={t.name}
                      aria-label="Object name"
                      maxLength={80}
                      className="min-w-0 flex-1 rounded-sm border border-accent/50 bg-background px-1 text-[13px] outline-none"
                      onBlur={(e) => {
                        renameTrack(id, e.target.value);
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-[13px]"
                      aria-pressed={selected}
                      onClick={() => useEditor.getState().selectTrack(id)}
                      onDoubleClick={() => setEditing(id)}
                      title="Click to select · double-click to rename"
                    >
                      {t.name}
                    </button>
                  )}
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-faint">
                    {t.source === "ai" ? <Sparkles className="size-3" aria-label="AI" /> : <Hand className="size-3" aria-label="Manual" />}
                    <span className="tabular">{count} fr</span>
                  </span>
                  <button
                    type="button"
                    aria-label={t.visible ? `Hide ${t.name}` : `Show ${t.name}`}
                    className="rounded-sm p-1 text-faint hover:bg-panel-3 hover:text-foreground"
                    onClick={() => toggleTrackVisibility(id)}
                  >
                    {t.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" aria-label={`More actions for ${t.name}`} className="rounded-sm p-1 text-faint hover:bg-panel-3 hover:text-foreground">
                        <Ellipsis className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(id)}>Rename</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void startTracking(id, { mode: "full" })} disabled={!count}>
                        <ScanLine /> Track through video
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void startTracking(id, { mode: "from-here" })} disabled={!t.frames[frame]}>
                        <Repeat /> Re-track from this frame
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => clearFrame(id, frame)} disabled={!t.frames[frame]}>
                        Clear mask on this frame
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => deleteTrack(id)} className="text-danger data-[highlighted]:text-danger [&_svg]:text-danger">
                        <Trash /> Delete object
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {selected && (
                  <div className="flex gap-1.5 px-2 pb-2">
                    <Button
                      size="xs"
                      variant="secondary"
                      className="flex-1"
                      disabled={!count || trackingIds.has(id)}
                      onClick={() => void startTracking(id, { mode: "full" })}
                    >
                      <ScanLine /> {trackingIds.has(id) ? "Tracking…" : "Track through video"}
                    </Button>
                    <Hint label="Re-track forward from the current frame, keeping earlier frames">
                      <Button size="xs" variant="ghost" aria-label="Re-track from this frame" disabled={!t.frames[frame] || trackingIds.has(id)} onClick={() => void startTracking(id, { mode: "from-here" })}>
                        <Repeat />
                      </Button>
                    </Hint>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
