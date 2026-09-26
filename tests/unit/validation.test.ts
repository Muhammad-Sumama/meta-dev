import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { CommandRequestSchema, ExportRequestSchema, KeyframeSchema, SegmentRequestSchema, TrackRequestSchema } from "@/lib/schemas/api";
import { TrackSchema } from "@/lib/schemas/project";
import { projectNameFromFile, sanitizeFileName, sniffContainer, validateFileClientSide } from "@/lib/validation/upload";
import { isBrowserPlayable, parseProbeOutput, parseRate } from "@/services/video/probe";

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("upload validation", () => {
  it("sniffs containers from magic bytes", () => {
    expect(sniffContainer(ascii("\0\0\0\x20ftypisom\0\0\x02\0"))).toBe("mp4");
    expect(sniffContainer(ascii("\0\0\0\x14ftypqt  \0\0\x02\0"))).toBe("mov");
    expect(sniffContainer(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...ascii("\x42\x82\x84webm0000")]))).toBe("webm");
    expect(sniffContainer(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...ascii("\x42\x82\x88matroska")]))).toBe("mkv");
    expect(sniffContainer(ascii("<!DOCTYPE html><html>"))).toBeNull();
    expect(sniffContainer(ascii("\x89PNG\r\n\x1a\n0000000"))).toBeNull();
    expect(sniffContainer(ascii("MZ"))).toBeNull();
  });

  it("sanitizes file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\clip.mp4")).toBe("clip.mp4");
    expect(sanitizeFileName("my video; rm -rf ~ $(whoami).mp4")).toBe("my video_ rm -rf ~ _(whoami).mp4");
    expect(sanitizeFileName("<script>.mov")).not.toMatch(/[<>]/);
    expect(sanitizeFileName("...hidden.mp4")).toBe("hidden.mp4");
    expect(sanitizeFileName("a".repeat(300) + ".webm").length).toBeLessThanOrEqual(120);
    expect(projectNameFromFile("summer_trip-final.mp4")).toBe("summer trip final");
  });

  it("gives friendly client-side errors", () => {
    expect(validateFileClientSide({ name: "notes.txt", size: 10, type: "text/plain" }, 1e9).error).toMatch(/aren't supported/);
    expect(validateFileClientSide({ name: "huge.mp4", size: 2e9, type: "video/mp4" }, 5e8).error).toMatch(/limit is 477 MB/);
    expect(validateFileClientSide({ name: "empty.mov", size: 0, type: "video/quicktime" }, 1e9).error).toMatch(/empty/);
    expect(validateFileClientSide({ name: "ok.webm", size: 1000, type: "video/webm" }, 1e9).ok).toBe(true);
  });
});

describe("ffprobe parsing", () => {
  const base = {
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.0", bit_rate: "300000" },
    streams: [
      { codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080, avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001", nb_frames: "299", duration: "9.976" },
      { codec_type: "audio", codec_name: "aac" },
    ],
  };

  it("reads metadata", () => {
    const p = parseProbeOutput(base);
    expect(p).toMatchObject({ width: 1920, height: 1080, codec: "h264", frameCount: 299, hasAudio: true, audioCodec: "aac" });
    expect(p.fps).toBeCloseTo(29.97, 2);
    expect(isBrowserPlayable("mp4", p)).toBe(true);
    expect(isBrowserPlayable("mov", p)).toBe(false);
  });

  it("swaps dimensions for rotated phone video", () => {
    const rotated = structuredClone(base) as typeof base & { streams: Array<Record<string, unknown>> };
    rotated.streams[0].side_data_list = [{ rotation: -90 }];
    const p = parseProbeOutput(rotated);
    expect(p).toMatchObject({ width: 1080, height: 1920, rotation: 270 });
  });

  it("estimates frame count when the container doesn't store it", () => {
    const noCount = structuredClone(base);
    delete (noCount.streams[0] as Record<string, unknown>).nb_frames;
    expect(parseProbeOutput(noCount).frameCount).toBe(Math.round(9.976 * (30000 / 1001)));
  });

  it("rejects files without a readable video stream", () => {
    expect(() => parseProbeOutput({ streams: [{ codec_type: "audio" }], format: {} })).toThrow(AppError);
    expect(() => parseProbeOutput({ streams: [{ codec_type: "video", width: 10, height: 10, avg_frame_rate: "0/0" }] })).toThrow(/frame rate/);
    expect(parseRate("25/1")).toBe(25);
    expect(parseRate("0/0")).toBeNull();
  });
});

describe("API request schemas", () => {
  it("requires a prompt for segmentation", () => {
    expect(SegmentRequestSchema.safeParse({ frameIndex: 0 }).success).toBe(false);
    expect(SegmentRequestSchema.safeParse({ frameIndex: 0, points: [{ x: 0.5, y: 0.5, label: 1 }] }).success).toBe(true);
    expect(SegmentRequestSchema.safeParse({ frameIndex: 0, points: [{ x: 1.5, y: 0.5, label: 1 }] }).success).toBe(false);
    expect(SegmentRequestSchema.safeParse({ frameIndex: 0, box: { x0: 0.5, y0: 0.5, x1: 0.4, y1: 0.9 } }).success).toBe(false);
  });

  it("validates tracking and command requests", () => {
    expect(KeyframeSchema.safeParse({ frameIndex: 3 }).success).toBe(false);
    expect(TrackRequestSchema.safeParse({ keyframes: [{ frameIndex: 3, mask: [10, 5, 85] }] }).success).toBe(true);
    expect(TrackRequestSchema.safeParse({ keyframes: [] }).success).toBe(false);
    expect(CommandRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(CommandRequestSchema.safeParse({ text: "x".repeat(501) }).success).toBe(false);
    expect(CommandRequestSchema.safeParse({ text: "Track the dog", selectedTrackId: "../../etc" }).success).toBe(false);
  });

  it("validates export settings", () => {
    expect(ExportRequestSchema.safeParse({ settings: { kind: "video", format: "mp4_h264" } }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ settings: { kind: "video", format: "exe" } }).success).toBe(false);
    expect(ExportRequestSchema.safeParse({ settings: { kind: "video", format: "mp4_h264", range: { start: 10, end: 2 } } }).success).toBe(false);
  });

  it("rejects tracks with unsafe ids or frame keys", () => {
    const track = {
      id: "trk_aaaaaaaaaaaa",
      name: "Dog",
      color: "#c6f432",
      source: "manual",
      width: 4,
      height: 4,
      frames: { "0": [16] },
      createdAt: "",
      updatedAt: "",
    };
    expect(TrackSchema.safeParse(track).success).toBe(true);
    expect(TrackSchema.safeParse({ ...track, id: "../x" }).success).toBe(false);
    expect(TrackSchema.safeParse({ ...track, frames: { __proto__x: [16] } }).success).toBe(false);
    expect(TrackSchema.safeParse({ ...track, color: "red; background:url(x)" }).success).toBe(false);
  });
});
