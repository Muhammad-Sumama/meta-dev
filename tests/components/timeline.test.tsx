import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/timeline/Timeline";
import { useEditor } from "@/stores/editor";
import { makeProject, makeTrack, renderInEditor } from "./helpers";

describe("Timeline", () => {
  beforeEach(() => {
    const frames = Array.from({ length: 100 }, (_, i) => i + 50); // 50..149
    useEditor.getState().init(makeProject(), [makeTrack("trk_aaaaaaaaaaaa", frames)], []);
    useEditor.getState().selectTrack(null);
  });

  it("shows video metadata, tracks and mask segments", () => {
    renderInEditor(<Timeline />);
    expect(screen.getByText("street-scene.mp4")).toBeInTheDocument();
    expect(screen.getByText(/960×540 · 30 fps · 10.0s · 365 KB/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Red car: AI tracked, frames 51–150/ })).toBeInTheDocument();
  });

  it("exposes the playhead as an accessible slider", async () => {
    useEditor.getState().setCurrentFrame(30);
    const { video } = renderInEditor(<Timeline />);
    const slider = screen.getByRole("slider", { name: "Playhead position" });
    expect(slider).toHaveAttribute("aria-valuenow", "30");
    expect(slider).toHaveAttribute("aria-valuemax", "299");
    slider.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(video.step).toHaveBeenCalledWith(1, 30);
    await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(video.step).toHaveBeenCalledWith(-10, 30);
    await userEvent.keyboard("{End}");
    expect(video.seekFrame).toHaveBeenCalledWith(299);
  });

  it("scrubs to the clicked position", () => {
    const { video } = renderInEditor(<Timeline />);
    const slider = screen.getByRole("slider", { name: "Playhead position" });
    slider.getBoundingClientRect = () => ({ left: 0, top: 0, width: 616, height: 100, right: 616, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(slider, { button: 0, clientX: 8 + 300, pointerId: 1 });
    expect(video.seekFrame).toHaveBeenCalled();
    const frame = video.seekFrame.mock.calls[0][0] as number;
    expect(frame).toBeGreaterThan(0);
    expect(frame).toBeLessThan(299);
  });

  it("selects a mask segment and jumps into it", async () => {
    useEditor.getState().setCurrentFrame(10);
    const { video } = renderInEditor(<Timeline />);
    await userEvent.click(screen.getByRole("button", { name: /Red car: AI tracked/ }));
    expect(useEditor.getState().selectedTrackId).toBe("trk_aaaaaaaaaaaa");
    expect(video.seekFrame).toHaveBeenCalledWith(50);
  });

  it("shows processing state for running AI jobs", () => {
    useEditor.getState().upsertJob({
      id: "job_aaaaaaaaaaaa",
      type: "segment",
      projectId: "prj_aaaaaaaaaaaa",
      label: "Track the dog",
      status: "processing",
      progress: { stage: "tracking", message: "Tracking frame 120 / 300", current: 120, total: 300, fraction: 0.4 },
      input: {},
      createdAt: "",
      frameRange: { start: 0, end: 299 },
    });
    renderInEditor(<Timeline />);
    const bar = screen.getByRole("progressbar", { name: /Track the dog: Tracking frame 120 \/ 300/ });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
  });

  it("toggles object visibility from the lane header", async () => {
    renderInEditor(<Timeline />);
    await userEvent.click(screen.getByRole("button", { name: "Hide Red car" }));
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.visible).toBe(false);
    expect(useEditor.getState().past.at(-1)?.label).toBe("Hide object");
  });
});
