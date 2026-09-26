"use client";

/**
 * Frame-accurate control of an HTMLVideoElement.
 *
 * - Seeks (and pauses) land mid-frame ((f + 0.5) / fps): the picture there
 *   is exactly frame f as the server samples it, even for variable frame
 *   rate, and rounding never shows the neighboring frame.
 * - During playback the presented frame comes from
 *   requestVideoFrameCallback (exact media time of the composited frame),
 *   falling back to requestAnimationFrame + currentTime.
 */
type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class VideoController {
  el: VideoWithRVFC | null = null;
  fps = 30;
  frameCount = 1;
  private loopId: number | null = null;
  private usingRvfc = false;
  private detach: (() => void) | null = null;
  private frameListeners = new Set<(frame: number) => void>();

  constructor(
    private readonly onFrame: (frame: number) => void,
    private readonly onPlayingChange: (playing: boolean) => void,
  ) {}

  configure(fps: number, frameCount: number) {
    this.fps = fps;
    this.frameCount = Math.max(1, frameCount);
  }

  /** Extra per-frame subscribers (e.g. the effect preview renderer). */
  subscribeFrames(cb: (frame: number) => void) {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  private emit(frame: number) {
    this.onFrame(frame);
    for (const cb of this.frameListeners) cb(frame);
  }

  attach(el: HTMLVideoElement | null) {
    this.detach?.();
    this.stopLoop();
    this.el = el as VideoWithRVFC | null;
    if (!el) return;
    const onPlay = () => {
      this.onPlayingChange(true);
      this.startLoop();
    };
    const onPause = () => {
      this.onPlayingChange(false);
      this.stopLoop();
      const f = this.frameAt(el.currentTime);
      // Park on the slot center so the picture is exactly frame f as the
      // server defines it (matters for variable-frame-rate video).
      const center = this.timeOf(f, el);
      if (!el.ended && Math.abs(el.currentTime - center) > 1e-4) el.currentTime = center;
      this.emit(f);
    };
    const onSeeked = () => {
      if (el.paused) this.emit(this.frameAt(el.currentTime));
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("seeked", onSeeked);
    this.detach = () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("seeked", onSeeked);
    };
  }

  frameAt(time: number) {
    return Math.max(0, Math.min(this.frameCount - 1, Math.floor(time * this.fps + 1e-3)));
  }

  /** Mid-frame time of frame `f`: the picture there is frame f on the server's grid (services/video/frames.ts). */
  private timeOf(f: number, el: HTMLVideoElement) {
    const duration = Number.isFinite(el.duration) ? el.duration : Infinity;
    return Math.min((f + 0.5) / this.fps, Math.max(0, duration - 0.001));
  }

  private startLoop() {
    const el = this.el;
    if (!el || this.loopId !== null) return;
    if (el.requestVideoFrameCallback) {
      this.usingRvfc = true;
      const tick = (_now: number, meta: { mediaTime: number }) => {
        this.emit(Math.max(0, Math.min(this.frameCount - 1, Math.round(meta.mediaTime * this.fps))));
        if (!el.paused) this.loopId = el.requestVideoFrameCallback!(tick);
        else this.loopId = null;
      };
      this.loopId = el.requestVideoFrameCallback(tick);
    } else {
      this.usingRvfc = false;
      const tick = () => {
        this.emit(this.frameAt(el.currentTime));
        this.loopId = el.paused ? null : requestAnimationFrame(tick);
      };
      this.loopId = requestAnimationFrame(tick);
    }
  }

  private stopLoop() {
    if (this.loopId === null) return;
    if (this.usingRvfc) this.el?.cancelVideoFrameCallback?.(this.loopId);
    else cancelAnimationFrame(this.loopId);
    this.loopId = null;
  }

  get playing() {
    return Boolean(this.el && !this.el.paused && !this.el.ended);
  }

  play() {
    const el = this.el;
    if (!el) return;
    if (el.ended || this.frameAt(el.currentTime) >= this.frameCount - 1) el.currentTime = 0;
    void el.play().catch(() => this.onPlayingChange(false));
  }

  pause() {
    this.el?.pause();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seekFrame(frame: number) {
    const el = this.el;
    const f = Math.max(0, Math.min(this.frameCount - 1, Math.round(frame)));
    if (el) {
      if (!el.paused) el.pause();
      el.currentTime = this.timeOf(f, el);
    }
    this.emit(f);
  }

  step(delta: number, current: number) {
    this.seekFrame(current + delta);
  }
}
