"use client";

import { createContext, useContext } from "react";
import type { VideoController } from "@/lib/client/video";

export interface EditorUi {
  video: VideoController;
  openExport(preset?: "video" | "mask" | "png_sequence" | "project"): void;
  openSettings(): void;
  openShortcuts(): void;
  focusCommand(): void;
}

export const EditorContext = createContext<EditorUi | null>(null);

export function useEditorUi(): EditorUi {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditorUi must be used inside the editor");
  return ctx;
}
