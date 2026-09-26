"use client";

import type { Project } from "@/lib/schemas/project";
import { api } from "./api";

let h264: boolean | null = null;

/**
 * Whether this browser can decode H.264. Chrome, Edge, Safari and Firefox
 * can; some Linux Chromium builds, Electron shells and headless test browsers
 * ship without the codec.
 */
export function canPlayH264(): boolean {
  if (h264 === null) {
    if (typeof document === "undefined") return true;
    h264 = document.createElement("video").canPlayType('video/mp4; codecs="avc1.42E01E"') !== "";
  }
  return h264;
}

/** True when the default preview is H.264 but this browser can't play it. */
export function needsVp9Preview(project: Project): boolean {
  const previewIsH264 = project.media.proxy.status === "ready" || project.video.codec === "h264";
  return previewIsH264 && !canPlayH264();
}

/** URL of the preview stream this browser should play, or null while it's being prepared. */
export function previewSrc(project: Project): string | null {
  if (needsVp9Preview(project)) {
    return project.media.vp9Proxy?.status === "ready" ? `${api.mediaUrl(project.id, "preview")}?codec=vp9` : null;
  }
  if (!project.video.browserPlayable && project.media.proxy.status !== "ready") return null;
  return api.mediaUrl(project.id, "preview");
}
