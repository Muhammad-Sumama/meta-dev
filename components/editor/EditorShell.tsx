"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowLeft, X } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import { autosave } from "@/lib/client/autosave";
import { VideoController } from "@/lib/client/video";
import type { ExportKind } from "@/lib/schemas/project";
import { useJobPolling } from "@/hooks/useJobPolling";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useEditor } from "@/stores/editor";
import { useSystem } from "@/stores/system";
import { Button } from "@/components/ui/button";
import { Separator, Spinner } from "@/components/ui/misc";
import { AIPanel, type AIPanelHandle } from "@/components/ai/AIPanel";
import { ExportDialog } from "@/components/export/ExportDialog";
import { Timeline } from "@/components/timeline/Timeline";
import { TransportBar } from "@/components/video/TransportBar";
import { VideoStage } from "@/components/video/VideoStage";
import { EditorContext, type EditorUi } from "./EditorContext";
import { ObjectsPanel } from "./ObjectsPanel";
import { OutputPanel } from "./OutputPanel";
import { SettingsDialog } from "./SettingsDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { ToolOptions } from "./ToolOptions";
import { ToolRail } from "./ToolRail";
import { TopBar } from "./TopBar";

export function EditorShell({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<{ title: string; hint?: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreset, setExportPreset] = useState<ExportKind | undefined>();
  const [exportOpenId, setExportOpenId] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const aiRef = useRef<AIPanelHandle>(null);
  const project = useEditor((s) => s.project);
  const rightPanelOpen = useEditor((s) => s.rightPanelOpen);

  const video = useMemo(
    () =>
      new VideoController(
        (f) => useEditor.getState().setCurrentFrame(f),
        (p) => useEditor.getState().setPlaying(p),
      ),
    [],
  );

  const ui: EditorUi = useMemo(
    () => ({
      video,
      openExport: (preset) => {
        setExportPreset(preset);
        setExportOpenId((n) => n + 1);
        setExportOpen(true);
      },
      openSettings: () => setSettingsOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
      focusCommand: () => {
        if (window.matchMedia("(max-width: 1023px)").matches) useEditor.getState().set("rightPanelOpen", true);
        setTimeout(() => aiRef.current?.focus(), 50);
      },
    }),
    [video],
  );

  // Load project + full tracks.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bundle = await api.getProject(projectId);
        const tracks = await Promise.all(bundle.tracks.map((t) => api.getTrack(projectId, t.id).then((r) => r.track)));
        if (cancelled) return;
        useEditor.getState().init(bundle.project, tracks, bundle.jobs);
        video.configure(bundle.project.video.fps, bundle.project.video.frameCount);
        autosave.start(projectId);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadError(errorText(err));
        setStatus("error");
      }
    })();
    void useSystem.getState().refresh();
    return () => {
      cancelled = true;
      void autosave.flush().finally(() => autosave.stop());
    };
  }, [projectId, video]);

  // Save before leaving the page.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState().saveState;
      if (s === "dirty" || s === "saving") {
        void autosave.flush();
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  useJobPolling(status === "ready" ? projectId : undefined);
  useShortcuts(status === "ready" ? ui : null);

  if (status === "loading" || (status === "ready" && !project)) {
    return (
      <div className="flex h-dvh items-center justify-center gap-3 text-sm text-muted" role="status">
        <Spinner className="size-5 text-accent" /> Loading project…
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-base font-medium">{loadError?.title ?? "We couldn't open this project."}</p>
        {loadError?.hint && <p className="max-w-md text-sm text-muted">{loadError.hint}</p>}
        <Button asChild variant="secondary">
          <Link href="/editor">
            <ArrowLeft /> Back to projects
          </Link>
        </Button>
      </div>
    );
  }

  const panels = (
    <>
      <AIPanel ref={aiRef} onOpenExport={(p) => ui.openExport(p)} />
      <Separator />
      <ObjectsPanel />
      <Separator />
      <OutputPanel />
    </>
  );

  return (
    <EditorContext.Provider value={ui}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <div className="hidden sm:flex">
            <ToolRail />
          </div>
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Video editor">
            <ToolOptions />
            <VideoStage />
            <TransportBar />
            <div className="sm:hidden">
              <ToolRail orientation="horizontal" />
            </div>
          </main>
          <aside aria-label="AI and objects" className="hidden w-[340px] shrink-0 flex-col overflow-y-auto border-l border-border bg-panel lg:flex">
            {panels}
          </aside>
        </div>
        <div className="h-[168px] shrink-0 sm:h-[200px]">
          <Timeline />
        </div>
      </div>

      {/* Slide-over panel for tablets and phones */}
      <DialogPrimitive.Root open={rightPanelOpen} onOpenChange={(o) => useEditor.getState().set("rightPanelOpen", o)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-40 flex w-[min(360px,100vw)] flex-col overflow-y-auto border-l border-border bg-panel shadow-2xl outline-none animate-fade-in lg:hidden">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <DialogPrimitive.Title className="text-[13px] font-semibold">AI & objects</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">Ask the AI, manage objects and output settings.</DialogPrimitive.Description>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-xs" aria-label="Close panel">
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
            {panels}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} preset={exportPreset} openId={exportOpenId} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </EditorContext.Provider>
  );
}
