"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import type { EditorUi } from "@/components/editor/EditorContext";
import { useEditor, type Tool } from "@/stores/editor";

const TOOL_KEYS: Record<string, Tool> = { v: "select", t: "track", m: "box", b: "brush", e: "eraser", h: "hand" };

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Editor keyboard shortcuts:
 *   Space play/pause · ←/→ frame step (Shift ×10) · Home/End
 *   V select · T track · M box · B brush · E eraser · H hand
 *   ⌘/Ctrl+Z undo · ⌘/Ctrl+Shift+Z (or Ctrl+Y) redo
 *   [ / ] brush size · O masks on/off · P effect preview · / ask AI · ? shortcuts
 */
export function useShortcuts(ui: EditorUi | null) {
  useEffect(() => {
    if (!ui) return;
    const onKey = (e: KeyboardEvent) => {
      // Dialogs and menus own their keyboard input (Escape closes them, arrows navigate).
      if (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = useEditor.getState();
      const key = e.key.toLowerCase();

      if (mod && key === "z") {
        if (isTyping(e.target)) return;
        e.preventDefault();
        const label = e.shiftKey ? s.redo() : s.undo();
        if (label) toast(`${e.shiftKey ? "Redo" : "Undo"}: ${label}`, { duration: 1400 });
        return;
      }
      if (mod && key === "y") {
        if (isTyping(e.target)) return;
        e.preventDefault();
        const label = s.redo();
        if (label) toast(`Redo: ${label}`, { duration: 1400 });
        return;
      }
      if (mod && key === "e") {
        e.preventDefault();
        ui.openExport();
        return;
      }
      if (mod || e.altKey || isTyping(e.target)) return;
      // Let focused buttons/sliders handle their own keys.
      const role = (e.target as HTMLElement | null)?.getAttribute?.("role");
      if (role === "slider" && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) return;

      switch (e.key) {
        case " ":
          if ((e.target as HTMLElement)?.tagName === "BUTTON") return;
          e.preventDefault();
          ui.video.toggle();
          return;
        case "ArrowLeft":
          e.preventDefault();
          ui.video.step(e.shiftKey ? -10 : -1, s.currentFrame);
          return;
        case "ArrowRight":
          e.preventDefault();
          ui.video.step(e.shiftKey ? 10 : 1, s.currentFrame);
          return;
        case "Home":
          e.preventDefault();
          ui.video.seekFrame(0);
          return;
        case "End":
          e.preventDefault();
          ui.video.seekFrame((s.project?.video.frameCount ?? 1) - 1);
          return;
        case "[":
          s.set("brushSize", Math.max(1, s.brushSize - (e.shiftKey ? 5 : 1)));
          return;
        case "]":
          s.set("brushSize", Math.min(80, s.brushSize + (e.shiftKey ? 5 : 1)));
          return;
        case "/":
          e.preventDefault();
          ui.focusCommand();
          return;
        case "?":
          e.preventDefault();
          ui.openShortcuts();
          return;
        case "Escape":
          if (s.selectedTrackId) s.selectTrack(null);
          return;
      }
      if (TOOL_KEYS[key]) {
        s.setTool(TOOL_KEYS[key]);
        return;
      }
      if (key === "o") s.set("masksVisible", !s.masksVisible);
      else if (key === "p") s.set("previewEffect", !s.previewEffect);
      else if (key === "f") s.set("zoom", "fit");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui]);
}

export const SHORTCUTS: Array<{ group: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    group: "Playback",
    items: [
      { keys: ["Space"], label: "Play / pause" },
      { keys: ["←"], label: "Previous frame" },
      { keys: ["→"], label: "Next frame" },
      { keys: ["Shift", "← / →"], label: "Jump 10 frames" },
      { keys: ["Home"], label: "First frame" },
      { keys: ["End"], label: "Last frame" },
    ],
  },
  {
    group: "Tools",
    items: [
      { keys: ["V"], label: "Select (click an object)" },
      { keys: ["T"], label: "Track (click to select and track)" },
      { keys: ["M"], label: "Box (drag around an object)" },
      { keys: ["B"], label: "Brush (paint mask)" },
      { keys: ["E"], label: "Eraser" },
      { keys: ["H"], label: "Hand (pan)" },
      { keys: ["[", "]"], label: "Brush size" },
      { keys: ["Alt", "Click"], label: "Remove from selection" },
      { keys: ["Esc"], label: "Deselect object" },
    ],
  },
  {
    group: "Editing & view",
    items: [
      { keys: ["⌘/Ctrl", "Z"], label: "Undo" },
      { keys: ["⌘/Ctrl", "Shift", "Z"], label: "Redo" },
      { keys: ["O"], label: "Show / hide masks" },
      { keys: ["P"], label: "Toggle effect preview" },
      { keys: ["F"], label: "Fit video to canvas" },
      { keys: ["/"], label: "Ask AI" },
      { keys: ["⌘/Ctrl", "E"], label: "Export" },
      { keys: ["?"], label: "Keyboard shortcuts" },
    ],
  },
];
