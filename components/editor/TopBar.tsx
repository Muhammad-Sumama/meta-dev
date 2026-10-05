"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, CircleAlert, Download, Keyboard, PanelRight, Redo2, Settings, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils/cn";
import { useEditor } from "@/stores/editor";
import { useSystem } from "@/stores/system";
import { Button } from "@/components/ui/button";
import { Badge, Spinner } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { Logo } from "@/components/brand/Logo";
import { useEditorUi } from "./EditorContext";

export function TopBar() {
  const ui = useEditorUi();
  const project = useEditor((s) => s.project)!;
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past.at(-1)?.label);
  const redoLabel = useEditor((s) => s.future[0]?.label);
  const health = useSystem((s) => s.health);
  const [name, setName] = useState(project.name);
  const mock = health ? health.ai.segmentation.kind === "mock" || health.ai.language.kind === "mock" : false;

  const saveName = async () => {
    const clean = name.trim();
    if (!clean || clean === project.name) return setName(project.name);
    try {
      const res = await api.patchProject(project.id, { name: clean });
      useEditor.getState().setProject(res.project);
    } catch {
      toast.error("Couldn't rename the project.");
      setName(project.name);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 sm:px-3">
      <Link href="/" className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-panel-3" aria-label="OpenSAM Studio home">
        <Logo className="size-6" />
        <span className="hidden text-[14px] font-semibold tracking-tight md:inline">OpenSAM Studio</span>
      </Link>
      <span className="hidden h-5 w-px bg-border sm:block" />
      <input
        aria-label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={saveName}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="min-w-0 max-w-[40vw] truncate rounded-sm bg-transparent px-1.5 py-1 text-[13px] text-foreground/90 hover:bg-panel-3 focus:bg-panel-3 focus:outline-none sm:max-w-64"
      />
      <SaveIndicator state={saveState} />
      {project.isDemo && <Badge variant="info" className="hidden sm:inline-flex">Demo</Badge>}
      {health && (
        <Hint
          label={
            mock
              ? "Running with mock inference: classical computer vision stands in for SAM 3 / SAM 2, and a rule-based parser stands in for Llama. See Settings."
              : "Connected to production models."
          }
        >
          <Badge variant={mock ? "warning" : "success"} className="hidden cursor-default md:inline-flex">
            {mock ? "Mock AI" : "Live models"}
          </Badge>
        </Hint>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        <Hint label={undoLabel ? `Undo ${undoLabel}` : "Undo"} shortcut={["⌘/Ctrl", "Z"]}>
          <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={() => useEditor.getState().undo()}>
            <Undo2 />
          </Button>
        </Hint>
        <Hint label={redoLabel ? `Redo ${redoLabel}` : "Redo"} shortcut={["⌘/Ctrl", "Shift", "Z"]}>
          <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={() => useEditor.getState().redo()}>
            <Redo2 />
          </Button>
        </Hint>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <Hint label="Keyboard shortcuts" shortcut="?">
          <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts" onClick={ui.openShortcuts} className="hidden sm:inline-flex">
            <Keyboard />
          </Button>
        </Hint>
        <Hint label="Settings">
          <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={ui.openSettings}>
            <Settings />
          </Button>
        </Hint>
        <Hint label="AI & objects panel">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Toggle AI panel"
            className="lg:hidden"
            onClick={() => useEditor.getState().set("rightPanelOpen", !useEditor.getState().rightPanelOpen)}
          >
            <PanelRight />
          </Button>
        </Hint>
        <Hint label="Export" shortcut={["⌘/Ctrl", "E"]}>
          <Button size="sm" className="ml-1" onClick={() => ui.openExport()}>
            <Download /> <span className="hidden sm:inline">Export</span>
          </Button>
        </Hint>
      </div>
    </header>
  );
}

function SaveIndicator({ state }: { state: "saved" | "saving" | "dirty" | "error" }) {
  return (
    <span
      aria-live="polite"
      className={cn("hidden items-center gap-1 text-[11.5px] sm:flex", state === "error" ? "text-danger" : "text-faint")}
    >
      {state === "saving" && <Spinner className="size-3" />}
      {state === "saved" && <Check className="size-3" />}
      {state === "error" && <CircleAlert className="size-3" />}
      {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : "Couldn't save — retrying"}
    </span>
  );
}
