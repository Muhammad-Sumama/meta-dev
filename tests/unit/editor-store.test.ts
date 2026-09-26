import { beforeEach, describe, expect, it } from "vitest";
import { applyStroke, clearFrame, deleteTrack, renameTrack, updateComposite } from "@/lib/client/actions";
import { addTrack } from "@/lib/client/doc";
import { decodeMask, encodeMask, maskArea } from "@/lib/mask/rle";
import { DEFAULT_COMPOSITE, type Project, type Track } from "@/lib/schemas/project";
import { useEditor } from "@/stores/editor";

const W = 32;
const H = 16;

function project(): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: "prj_aaaaaaaaaaaa",
    name: "Test",
    isDemo: false,
    createdAt: now,
    updatedAt: now,
    video: { originalName: "a.mp4", fileName: "source.mp4", sizeBytes: 1, mimeType: "video/mp4", container: "mp4", codec: "h264", width: 64, height: 32, rotation: 0, fps: 30, frameCount: 10, duration: 1 / 3, hasAudio: false, browserPlayable: true },
    media: { proxy: { status: "not_needed" }, vp9Proxy: { status: "none" }, poster: false, filmstrip: { status: "pending", count: 0, tileWidth: 0, tileHeight: 0 } },
    analysis: { width: W, height: H },
    composite: DEFAULT_COMPOSITE,
    commands: [],
    jobIds: [],
  };
}

function track(id: string, frames: Record<number, number[]> = {}): Track {
  return { id, name: id, color: "#c6f432", visible: true, source: "manual", provider: "manual", width: W, height: H, prompts: [], frames, createdAt: "", updatedAt: "" };
}

const blank = () => encodeMask(new Uint8Array(W * H));

describe("editor store & history", () => {
  beforeEach(() => {
    useEditor.getState().init(project(), [], []);
  });

  it("commits, undoes and redoes document changes", () => {
    const s = useEditor.getState();
    s.commit("Add A", (d) => addTrack(d, track("trk_aaaaaaaaaaaa")), { select: "trk_aaaaaaaaaaaa" });
    expect(useEditor.getState().doc.order).toEqual(["trk_aaaaaaaaaaaa"]);
    expect(useEditor.getState().selectedTrackId).toBe("trk_aaaaaaaaaaaa");
    renameTrack("trk_aaaaaaaaaaaa", "Dog");
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.name).toBe("Dog");

    expect(useEditor.getState().undo()).toBe("Rename object");
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.name).toBe("trk_aaaaaaaaaaaa");
    expect(useEditor.getState().undo()).toBe("Add A");
    expect(useEditor.getState().doc.order).toEqual([]);
    expect(useEditor.getState().undo()).toBeNull();

    expect(useEditor.getState().redo()).toBe("Add A");
    expect(useEditor.getState().redo()).toBe("Rename object");
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.name).toBe("Dog");
    expect(useEditor.getState().redo()).toBeNull();
  });

  it("clears the redo stack on new edits and caps history", () => {
    const s = useEditor.getState();
    s.commit("Add A", (d) => addTrack(d, track("trk_aaaaaaaaaaaa")));
    useEditor.getState().undo();
    useEditor.getState().commit("Add B", (d) => addTrack(d, track("trk_bbbbbbbbbbbb")));
    expect(useEditor.getState().future).toHaveLength(0);
    for (let i = 0; i < 150; i++) updateComposite(`Feather ${i}`, { feather: i % 20 });
    expect(useEditor.getState().past.length).toBeLessThanOrEqual(100);
  });

  it("paints on the current frame only, or on the whole sequence", () => {
    const s = useEditor.getState();
    s.commit("Add", (d) => addTrack(d, track("trk_aaaaaaaaaaaa", { 0: blank(), 1: blank(), 2: blank() })), { select: "trk_aaaaaaaaaaaa" });
    s.set("brushSize", 2);
    s.setCurrentFrame(1);
    applyStroke([{ x: 5, y: 5 }, { x: 10, y: 5 }], "add");
    let t = useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa;
    expect(maskArea(t.frames[1])).toBeGreaterThan(0);
    expect(t.frames[0]).toEqual(blank());

    useEditor.getState().set("editScope", "sequence");
    applyStroke([{ x: 20, y: 8 }], "add");
    t = useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa;
    for (const f of [0, 1, 2]) expect(decodeMask(t.frames[f], W * H)[8 * W + 20]).toBe(1);

    useEditor.getState().set("editScope", "frame");
    applyStroke([{ x: 20, y: 8 }], "erase");
    t = useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa;
    expect(decodeMask(t.frames[1], W * H)[8 * W + 20]).toBe(0);
    expect(decodeMask(t.frames[2], W * H)[8 * W + 20]).toBe(1);

    expect(useEditor.getState().undo()).toBe("Erase");
    expect(decodeMask(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.frames[1], W * H)[8 * W + 20]).toBe(1);
  });

  it("creates a manual object when painting with nothing selected", () => {
    useEditor.getState().setCurrentFrame(3);
    applyStroke([{ x: 4, y: 4 }], "add");
    const s = useEditor.getState();
    expect(s.doc.order).toHaveLength(1);
    expect(s.selectedTrackId).toBe(s.doc.order[0]);
    expect(Object.keys(s.doc.tracks[s.doc.order[0]].frames)).toEqual(["3"]);
  });

  it("clears frames and deletes objects (undoably)", () => {
    const s = useEditor.getState();
    s.commit("Add", (d) => addTrack(d, track("trk_aaaaaaaaaaaa", { 0: encodeMask(new Uint8Array(W * H).fill(1)) })));
    clearFrame("trk_aaaaaaaaaaaa", 0);
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.frames[0]).toBeUndefined();
    useEditor.getState().set("selectedTrackId", "trk_aaaaaaaaaaaa");
    updateComposite("Subject", { subjectTrackIds: ["trk_aaaaaaaaaaaa"] });
    deleteTrack("trk_aaaaaaaaaaaa");
    expect(useEditor.getState().doc.order).toEqual([]);
    expect(useEditor.getState().doc.composite.subjectTrackIds).toEqual([]);
    expect(useEditor.getState().selectedTrackId).toBeNull();
    useEditor.getState().undo();
    expect(useEditor.getState().doc.order).toEqual(["trk_aaaaaaaaaaaa"]);
  });

  it("clamps the playhead to the video", () => {
    useEditor.getState().setCurrentFrame(999);
    expect(useEditor.getState().currentFrame).toBe(9);
    useEditor.getState().setCurrentFrame(-4);
    expect(useEditor.getState().currentFrame).toBe(0);
  });
});
