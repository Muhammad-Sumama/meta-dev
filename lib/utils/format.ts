export function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, "0");
}

/** 00:01:23 or 01:23 (hours omitted when zero). */
export function formatTime(seconds: number, opts: { forceHours?: boolean } = {}): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 || opts.forceHours ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** SMPTE-style timecode HH:MM:SS:FF. */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.floor(frame));
  const rate = Math.max(1, Math.round(fps));
  const totalSeconds = Math.floor(f / rate);
  const ff = f % rate;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatFps(fps: number): string {
  if (!Number.isFinite(fps)) return "—";
  const rounded = Math.round(fps * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded} fps` : `${rounded.toFixed(2)} fps`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return formatTime(seconds);
}

export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
}

export function timeToFrame(time: number, fps: number, frameCount?: number): number {
  const f = Math.floor(time * fps + 1e-6);
  return frameCount ? Math.min(Math.max(0, f), frameCount - 1) : Math.max(0, f);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
