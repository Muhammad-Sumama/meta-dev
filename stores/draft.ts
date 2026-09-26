"use client";

import { create } from "zustand";

/** Transient in-progress brush stroke (not part of the undoable document). */
interface DraftState {
  trackId: string | null;
  mask: Uint8Array | null;
  version: number;
  setDraft(trackId: string | null, mask: Uint8Array | null): void;
}

export const useDraft = create<DraftState>()((set) => ({
  trackId: null,
  mask: null,
  version: 0,
  setDraft(trackId, mask) {
    set((s) => ({ trackId, mask, version: s.version + 1 }));
  },
}));
