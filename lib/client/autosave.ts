"use client";

import type { Composite, Track } from "@/lib/schemas/project";
import { useEditor } from "@/stores/editor";
import { api } from "./api";

/**
 * Persists document changes (track masks, composite) to the server.
 *
 * Tracks are compared by object identity against the last saved version, so
 * only edited tracks are uploaded. Undo/redo just produce another document
 * state, which syncs the same way (including deletes and re-creates).
 */
class AutosaveManager {
  private saved = new Map<string, Track>();
  private savedComposite: Composite | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private projectId: string | null = null;

  start(projectId: string) {
    this.stop();
    this.projectId = projectId;
    const { doc } = useEditor.getState();
    this.saved = new Map(Object.entries(doc.tracks));
    this.savedComposite = doc.composite;
    this.unsubscribe = useEditor.subscribe((s, prev) => {
      if (s.doc !== prev.doc) this.schedule();
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.projectId = null;
  }

  /** Records a track as already persisted (e.g. created server-side by a job). */
  markSaved(track: Track) {
    this.saved.set(track.id, track);
  }

  markCompositeSaved(c: Composite) {
    this.savedComposite = c;
  }

  private schedule() {
    const s = useEditor.getState();
    if (s.saveState !== "saving") s.set("saveState", "dirty");
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 700);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) await this.running;
    this.running = this.save().finally(() => (this.running = null));
    return this.running;
  }

  private async save() {
    const pid = this.projectId;
    if (!pid) return;
    const store = useEditor.getState();
    const { doc } = store;
    const changed = Object.values(doc.tracks).filter((t) => this.saved.get(t.id) !== t);
    const removed = [...this.saved.keys()].filter((id) => !doc.tracks[id]);
    const compositeChanged = doc.composite !== this.savedComposite;
    if (!changed.length && !removed.length && !compositeChanged) {
      if (store.saveState !== "saved") store.set("saveState", "saved");
      return;
    }
    store.set("saveState", "saving");
    try {
      for (const t of changed) {
        await api.saveTrack(pid, t);
        this.saved.set(t.id, t);
      }
      for (const id of removed) {
        await api.deleteTrack(pid, id).catch((err) => {
          if ((err as { code?: string }).code !== "NOT_FOUND") throw err;
        });
        this.saved.delete(id);
      }
      if (compositeChanged) {
        await api.patchProject(pid, { composite: doc.composite });
        this.savedComposite = doc.composite;
      }
      const latest = useEditor.getState();
      latest.set("saveState", latest.doc === doc ? "saved" : "dirty");
      if (latest.doc !== doc) this.schedule();
    } catch (err) {
      console.error("[autosave]", err);
      useEditor.getState().set("saveState", "error");
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), 5000);
    }
  }
}

export const autosave = new AutosaveManager();
