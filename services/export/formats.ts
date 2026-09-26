import type { ExportFormat, ExportSettings } from "@/lib/schemas/project";
import type { FFmpegCapabilities } from "../video/ffmpeg";

export interface FormatSpec {
  format: ExportFormat;
  label: string;
  extension: string;
  mime: string;
  /** Stores transparency. */
  alpha: boolean;
  /** Writes the mask/matte instead of the composited picture. */
  matte: boolean;
  /** Produces a zip of images. */
  sequence: boolean;
  audio: boolean;
  requires: keyof FFmpegCapabilities["encoders"] | null;
}

export const FORMAT_SPECS: Record<ExportFormat, FormatSpec> = {
  mp4_h264: { format: "mp4_h264", label: "MP4 (H.264)", extension: "mp4", mime: "video/mp4", alpha: false, matte: false, sequence: false, audio: true, requires: "h264" },
  webm_vp9: { format: "webm_vp9", label: "WebM (VP9)", extension: "webm", mime: "video/webm", alpha: false, matte: false, sequence: false, audio: true, requires: "vp9" },
  webm_vp9_alpha: { format: "webm_vp9_alpha", label: "WebM VP9 with transparency", extension: "webm", mime: "video/webm", alpha: true, matte: false, sequence: false, audio: true, requires: "vp9" },
  mov_prores4444: { format: "mov_prores4444", label: "MOV ProRes 4444 with transparency", extension: "mov", mime: "video/quicktime", alpha: true, matte: false, sequence: false, audio: true, requires: "prores" },
  png_zip: { format: "png_zip", label: "PNG sequence (.zip)", extension: "zip", mime: "application/zip", alpha: true, matte: false, sequence: true, audio: false, requires: "png" },
  mask_mp4: { format: "mask_mp4", label: "Matte video (MP4, white = subject)", extension: "mp4", mime: "video/mp4", alpha: false, matte: true, sequence: false, audio: false, requires: "h264" },
  mask_png_zip: { format: "mask_png_zip", label: "Mask PNG sequence (.zip)", extension: "zip", mime: "application/zip", alpha: false, matte: true, sequence: true, audio: false, requires: "png" },
  project_json: { format: "project_json", label: "OpenSAM project (.json)", extension: "opensam.json", mime: "application/json", alpha: false, matte: false, sequence: false, audio: false, requires: null },
};

export const FORMATS_BY_KIND: Record<ExportSettings["kind"], ExportFormat[]> = {
  video: ["mp4_h264", "webm_vp9", "webm_vp9_alpha", "mov_prores4444"],
  mask: ["mask_mp4", "mask_png_zip"],
  png_sequence: ["png_zip"],
  project: ["project_json"],
};

const CRF = {
  h264: { high: 17, medium: 21, low: 26 },
  vp9: { high: 24, medium: 31, low: 38 },
} as const;

/** Video encoder arguments (input is raw frames on stdin as input #0). */
export function encoderArgs(spec: FormatSpec, quality: ExportSettings["quality"]): string[] {
  switch (spec.format) {
    case "mp4_h264":
    case "mask_mp4":
      return ["-c:v", "libx264", "-preset", "medium", "-crf", String(CRF.h264[quality]), "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
    case "webm_vp9":
      return ["-c:v", "libvpx-vp9", "-crf", String(CRF.vp9[quality]), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p"];
    case "webm_vp9_alpha":
      return ["-c:v", "libvpx-vp9", "-crf", String(CRF.vp9[quality]), "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0"];
    case "mov_prores4444":
      return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", "-qscale:v", quality === "high" ? "4" : quality === "medium" ? "9" : "14"];
    case "png_zip":
    case "mask_png_zip":
      return ["-c:v", "png", "-compression_level", "6"];
    case "project_json":
      return [];
  }
}

export function audioArgs(spec: FormatSpec): string[] {
  if (spec.format === "webm_vp9" || spec.format === "webm_vp9_alpha") return ["-c:a", "libopus", "-b:a", "160k"];
  return ["-c:a", "aac", "-b:a", "192k"];
}

export function outputDimensions(
  settings: Pick<ExportSettings, "resolution">,
  source: { width: number; height: number },
): { width: number; height: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  if (settings.resolution === "source") return { width: even(source.width), height: even(source.height) };
  const target = Math.min(Number(settings.resolution), source.height);
  return { width: even((target * source.width) / source.height), height: even(target) };
}

export function isFormatAvailable(spec: FormatSpec, caps: FFmpegCapabilities): boolean {
  if (!spec.requires) return true;
  return caps.available && caps.encoders[spec.requires];
}
