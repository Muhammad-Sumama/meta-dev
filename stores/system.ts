"use client";

import { create } from "zustand";
import { api, type HealthInfo } from "@/lib/client/api";

interface SystemState {
  health: HealthInfo | null;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
}

export const useSystem = create<SystemState>()((set) => ({
  health: null,
  loading: false,
  error: null,
  async refresh() {
    set({ loading: true });
    try {
      set({ health: await api.health(), error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },
}));
