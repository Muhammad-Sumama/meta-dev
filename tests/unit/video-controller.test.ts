import { describe, expect, it } from "vitest";
import { VideoController } from "@/lib/client/video";

/** Just enough of HTMLVideoElement: events, seeks, play/pause and rVFC. */
class FakeVideo extends EventTarget {
  paused = true;
  ended = false;
  duration = 2;
  seeks: number[] = [];
  frameCallback: ((now: number, meta: { mediaTime: number }) => void) | null = null;
  private time = 0;

  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.seeks.push(t);
  }
  /** Playback advancing without a seek. */
  advanceTo(t: number) {
    this.time = t;
  }
  async play() {
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number }) => void) {
    this.frameCallback = cb;
    return 1;
  }
  cancelVideoFrameCallback() {
    this.frameCallback = null;
  }
}

function setup(fps = 24, frameCount = 48) {
  const frames: number[] = [];
  const playing: boolean[] = [];
  const ctl = new VideoController((f) => frames.push(f), (p) => playing.push(p));
  const el = new FakeVideo();
  ctl.configure(fps, frameCount);
  ctl.attach(el as unknown as HTMLVideoElement);
  return { ctl, el, frames, playing };
}

describe("VideoController", () => {
  it("seeks to the middle of the requested frame", () => {
    const { ctl, el, frames } = setup();
    ctl.seekFrame(10);
    expect(el.currentTime).toBeCloseTo(10.5 / 24, 9);
    expect(frames.at(-1)).toBe(10);
    ctl.seekFrame(500);
    expect(frames.at(-1)).toBe(47);
    expect(el.currentTime).toBeLessThan(el.duration);
  });

  it("reports the presented frame during playback from rVFC media time", async () => {
    const { ctl, el, frames, playing } = setup();
    ctl.play();
    await Promise.resolve();
    expect(playing.at(-1)).toBe(true);
    el.frameCallback!(0, { mediaTime: 7 / 24 });
    expect(frames.at(-1)).toBe(7);
    // Variable frame rate: a picture timestamped between slots belongs to the nearest one.
    el.frameCallback!(0, { mediaTime: 8.4 / 24 });
    expect(frames.at(-1)).toBe(8);
  });

  it("parks on the slot center when paused mid-frame, so picture and mask agree", async () => {
    const { ctl, el, frames } = setup();
    ctl.play();
    await Promise.resolve();
    el.advanceTo(10.1 / 24);
    ctl.pause();
    expect(frames.at(-1)).toBe(10);
    expect(el.seeks.at(-1)).toBeCloseTo(10.5 / 24, 9);
  });

  it("doesn't re-seek when already on a slot center or at the end", async () => {
    const { ctl, el } = setup();
    ctl.seekFrame(3);
    const seeks = el.seeks.length;
    await el.play();
    ctl.pause();
    expect(el.seeks.length).toBe(seeks);

    await el.play();
    el.advanceTo(el.duration);
    el.ended = true;
    el.dispatchEvent(new Event("ended"));
    expect(el.seeks.length).toBe(seeks);
  });
});
