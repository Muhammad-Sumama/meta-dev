"use client";

import { create } from "zustand";
import type { Doc } from "@/lib/client/doc";
import { isTerminal, JOB_STAGE_RANK, type Job } from "@/lib/schemas/job";
import { DEFAULT_COMPOSITE, type CommandRecord, type Project, type Track } from "@/lib/schemas/project";

export type Tool = "select" | "track" | "box" | "brush" | "eraser" | "hand";

export const TOOL_SHORTCUTS: Record<Tool, string> = {
  select: "V",
  track: "T",
  box: "M",
  brush: "B",
  eraser: "E",
  hand: "H",
};

interface HistoryEntry {
  label: string;
  doc: Doc;
  selectedTrackId: string | null;
}

export type SaveState = "saved" | "saving" | "dirty" | "error";

export interface EditorState {
  project: Project | null;
  doc: Doc;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selectedTrackId: string | null;

  currentFrame: number;
  playing: boolean;

  tool: Tool;
  selectMode: "add" | "subtract";
  editScope: "frame" | "sequence";
  /** Brush radius in mask (analysis) pixels. */
  brushSize: number;
  masksVisible: boolean;
  maskOpacity: number;
  showOutlines: boolean;
  previewEffect: boolean;
  zoom: "fit" | number;

  jobs: Record<string, Job>;
  commands: CommandRecord[];
  segmenting: boolean;
  saveState: SaveState;
  rightPanelOpen: boolean;

  init(project: Project, tracks: Track[], jobs: Job[]): void;
  setProject(project: Project): void;
  commit(label: string, update: (doc: Doc) => Doc, opts?: { select?: string | null }): void;
  undo(): string | null;
  redo(): string | null;
  selectTrack(id: string | null): void;

  setCurrentFrame(frame: number): void;
  setPlaying(playing: boolean): void;
  setTool(tool: Tool): void;
  set<K extends keyof EditorState>(key: K, value: EditorState[K]): void;

  upsertJob(job: Job): void;
  addCommand(record: CommandRecord): void;
  updateCommand(id: string, patch: Partial<CommandRecord>): void;
}

const HISTORY_LIMIT = 100;

const emptyDoc: Doc = { tracks: {}, order: [], composite: DEFAULT_COMPOSITE };

export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  doc: emptyDoc,
  past: [],
  future: [],
  selectedTrackId: null,
  currentFrame: 0,
  playing: false,
  tool: "select",
  selectMode: "add",
  editScope: "frame",
  brushSize: 8,
  masksVisible: true,
  maskOpacity: 0.55,
  showOutlines: true,
  previewEffect: true,
  zoom: "fit",
  jobs: {},
  commands: [],
  segmenting: false,
  saveState: "saved",
  rightPanelOpen: false,

  init(project, tracks, jobs) {
    const sorted = [...tracks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    set({
      project,
      doc: {
        tracks: Object.fromEntries(sorted.map((t) => [t.id, t])),
        order: sorted.map((t) => t.id),
        composite: project.composite,
      },
      past: [],
      future: [],
      selectedTrackId: sorted.at(-1)?.id ?? null,
      currentFrame: 0,
      playing: false,
      jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
      commands: project.commands,
      saveState: "saved",
    });
  },

  setProject(project) {
    set({ project });
  },

  commit(label, update, opts) {
    const { doc, past, selectedTrackId } = get();
    const next = update(doc);
    if (next === doc) return;
    set({
      doc: next,
      past: [...past, { label, doc, selectedTrackId }].slice(-HISTORY_LIMIT),
      future: [],
      ...(opts && "select" in opts ? { selectedTrackId: opts.select ?? null } : {}),
    });
  },

  undo() {
    const { past, future, doc, selectedTrackId } = get();
    const prev = past.at(-1);
    if (!prev) return null;
    set({
      doc: prev.doc,
      past: past.slice(0, -1),
      future: [{ label: prev.label, doc, selectedTrackId }, ...future].slice(0, HISTORY_LIMIT),
      selectedTrackId: prev.doc.tracks[selectedTrackId ?? ""] ? selectedTrackId : prev.selectedTrackId,
    });
    return prev.label;
  },

  redo() {
    const { past, future, doc, selectedTrackId } = get();
    const next = future[0];
    if (!next) return null;
    set({
      doc: next.doc,
      future: future.slice(1),
      past: [...past, { label: next.label, doc, selectedTrackId }].slice(-HISTORY_LIMIT),
      selectedTrackId: next.doc.tracks[selectedTrackId ?? ""] ? selectedTrackId : next.selectedTrackId,
    });
    return next.label;
  },

  selectTrack(id) {
    set({ selectedTrackId: id });
  },

  setCurrentFrame(frame) {
    const p = get().project;
    const max = p ? p.video.frameCount - 1 : 0;
    const f = Math.max(0, Math.min(max, Math.round(frame)));
    if (f !== get().currentFrame) set({ currentFrame: f });
  },

  setPlaying(playing) {
    set({ playing });
  },

  setTool(tool) {
    set({ tool });
  },

  set(key, value) {
    set({ [key]: value } as Partial<EditorState>);
  },

  upsertJob(job) {
    set((s) => {
      const prev = s.jobs[job.id];
      // Updates arrive over two paths (HTTP responses, live events) in any order: never move a job backwards.
      if (prev && (JOB_STAGE_RANK[prev.status] > JOB_STAGE_RANK[job.status] || (isTerminal(prev.status) && isTerminal(job.status)))) return s;
      return { jobs: { ...s.jobs, [job.id]: { ...prev, ...job } } };
    });
  },

  addCommand(record) {
    set((s) => ({ commands: [...s.commands.filter((c) => c.id !== record.id), record] }));
  },

  updateCommand(id, patch) {
    set((s) => ({ commands: s.commands.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  },
}));

export const selectSelectedTrack = (s: EditorState) => (s.selectedTrackId ? s.doc.tracks[s.selectedTrackId] ?? null : null);
