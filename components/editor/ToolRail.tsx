"use client";

import { Brush, Eraser, Hand, MousePointer2, ScanLine, SquareDashed, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { TOOL_SHORTCUTS, useEditor, type Tool } from "@/stores/editor";
import { Hint } from "@/components/ui/tooltip";

export const TOOLS: Array<{ id: Tool; label: string; description: string; icon: LucideIcon }> = [
  { id: "select", label: "Select", description: "Click an object to segment it", icon: MousePointer2 },
  { id: "track", label: "Track", description: "Click an object to select and track it", icon: ScanLine },
  { id: "box", label: "Box", description: "Drag a rough box around an object", icon: SquareDashed },
  { id: "brush", label: "Brush", description: "Paint to add to the mask", icon: Brush },
  { id: "eraser", label: "Eraser", description: "Paint to remove from the mask", icon: Eraser },
  { id: "hand", label: "Hand", description: "Drag to pan the canvas", icon: Hand },
];

export function ToolRail({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const vertical = orientation === "vertical";
  return (
    <nav
      aria-label="Tools"
      className={cn(
        "flex shrink-0 bg-panel",
        vertical ? "w-[60px] flex-col items-center gap-1 border-r border-border py-2" : "h-12 items-center justify-around gap-1 border-t border-border px-2",
      )}
    >
      <div role="radiogroup" aria-label="Tool" className={cn("flex gap-1", vertical ? "flex-col" : "flex-row")}>
        {TOOLS.map((t) => {
          const active = tool === t.id;
          const Icon = t.icon;
          return (
            <Hint key={t.id} label={`${t.label} — ${t.description}`} shortcut={TOOL_SHORTCUTS[t.id]} side={vertical ? "right" : "top"}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={`${t.label} tool (${TOOL_SHORTCUTS[t.id]})`}
                onClick={() => setTool(t.id)}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 rounded-md text-[10px] font-medium transition-colors",
                  vertical ? "h-12 w-12" : "h-10 w-12",
                  active ? "bg-accent/12 text-accent" : "text-muted hover:bg-panel-3 hover:text-foreground",
                )}
              >
                <Icon className="size-[18px]" strokeWidth={active ? 2.2 : 1.8} />
                <span>{t.label}</span>
              </button>
            </Hint>
          );
        })}
      </div>
    </nav>
  );
}
