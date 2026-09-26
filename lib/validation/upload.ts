/**
 * Upload validation shared by the browser (fast feedback) and the server
 * (authoritative). The server additionally sniffs magic bytes and probes the
 * stream with ffprobe — extensions and MIME types alone are never trusted.
 */

export const ALLOWED_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv"] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/x-m4v",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/matroska",
  "application/octet-stream",
  "",
] as const;

export const ACCEPT_ATTRIBUTE = "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.m4v,.mov,.webm,.mkv";

export type ContainerKind = "mp4" | "mov" | "webm" | "mkv";

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

export interface ClientValidationResult {
  ok: boolean;
  error?: string;
}

export function validateFileClientSide(
  file: { name: string; size: number; type: string },
  maxBytes: number,
): ClientValidationResult {
  const ext = extensionOf(file.name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `“${ext || "no extension"}” files aren't supported. Upload an MP4, MOV, or WebM video.` };
  }
  if (file.type && !file.type.startsWith("video/") && file.type !== "application/octet-stream") {
    return { ok: false, error: "That file doesn't look like a video. Upload an MP4, MOV, or WebM video." };
  }
  if (file.size <= 0) return { ok: false, error: "This file is empty." };
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `This file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is ${Math.round(maxBytes / 1024 / 1024)} MB — try a shorter clip.`,
    };
  }
  return { ok: true };
}

const QT_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Identifies the container from the first bytes of the file.
 * Returns null for anything that isn't an ISO-BMFF/QuickTime or EBML file.
 */
export function sniffContainer(head: Uint8Array): ContainerKind | null {
  if (head.length < 12) return null;
  // EBML (Matroska/WebM)
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const text = ascii(head, 0, Math.min(head.length, 256));
    if (text.includes("webm")) return "webm";
    if (text.includes("matroska")) return "mkv";
    return null;
  }
  const type = ascii(head, 4, 8);
  if (type === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (brand === "qt  ") return "mov";
    return "mp4";
  }
  if (QT_ATOMS.has(type)) return "mov";
  return null;
}

export const MIME_BY_CONTAINER: Record<ContainerKind, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

/**
 * Produces a display-safe file name: no directories, control characters or
 * shell/HTML-significant characters. Stored files never use this name — they
 * are saved under generated names — it is only kept as metadata.
 */
export function sanitizeFileName(name: string, maxLength = 120): string {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFKC");
  let clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*`$;&{}[\]\\]/g, "_");
  clean = clean.replace(/\s+/g, " ").replace(/_+/g, "_").trim();
  clean = clean.replace(/^\.+/, "");
  if (!clean) clean = "video";
  if (clean.length > maxLength) {
    const ext = extensionOf(clean);
    clean = clean.slice(0, maxLength - ext.length) + ext;
  }
  return clean;
}

export function projectNameFromFile(name: string): string {
  const clean = sanitizeFileName(name);
  const ext = extensionOf(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  return stem.replace(/[_-]+/g, " ").trim().slice(0, 120) || "Untitled project";
}
