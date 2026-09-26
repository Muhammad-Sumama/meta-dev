import { render } from "@testing-library/react";
import { vi } from "vitest";
import { EditorContext, type EditorUi } from "@/components/editor/EditorContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VideoController } from "@/lib/client/video";
import { DEFAULT_COMPOSITE, type Project, type Track } from "@/lib/schemas/project";
import { encodeMask } from "@/lib/mask/rle";

export const MW = 16;
export const MH = 8;

export function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "prj_aaaaaaaaaaaa",
    name: "Street scene",
    isDemo: true,
    createdAt: now,
    updatedAt: now,
    video: { originalName: "street-scene.mp4", fileName: "source.mp4", sizeBytes: 373532, mimeType: "video/mp4", container: "mp4", codec: "h264", width: 960, height: 540, rotation: 0, fps: 30, frameCount: 300, duration: 10, hasAudio: false, browserPlayable: true },
    media: { proxy: { status: "not_needed" }, vp9Proxy: { status: "none" }, poster: true, filmstrip: { status: "ready", count: 20, tileWidth: 96, tileHeight: 54 } },
    analysis: { width: MW, height: MH },
    composite: DEFAULT_COMPOSITE,
    commands: [],
    jobIds: [],
    ...overrides,
  };
}

export function makeTrack(id: string, frames: number[], extra: Partial<Track> = {}): Track {
  const full = encodeMask(new Uint8Array(MW * MH).fill(1));
  return {
    id,
    name: "Red car",
    color: "#c6f432",
    visible: true,
    source: "ai",
    provider: "mock",
    width: MW,
    height: MH,
    prompts: [{ frameIndex: frames[0] ?? 0, points: [] }],
    frames: Object.fromEntries(frames.map((f) => [String(f), full])),
    createdAt: "",
    updatedAt: "",
    ...extra,
  };
}

export function fakeVideo() {
  return {
    seekFrame: vi.fn(),
    step: vi.fn(),
    toggle: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    subscribeFrames: vi.fn(() => () => {}),
    attach: vi.fn(),
  } as unknown as VideoController & { seekFrame: ReturnType<typeof vi.fn>; step: ReturnType<typeof vi.fn> };
}

export function renderInEditor(ui: React.ReactElement, video = fakeVideo()) {
  const ctx: EditorUi = { video, openExport: vi.fn(), openSettings: vi.fn(), openShortcuts: vi.fn(), focusCommand: vi.fn() };
  const result = render(
    <TooltipProvider>
      <EditorContext.Provider value={ctx}>{ui}</EditorContext.Provider>
    </TooltipProvider>,
  );
  return { ...result, video, ctx };
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
