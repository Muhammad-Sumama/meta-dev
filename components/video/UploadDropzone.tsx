"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { CircleAlert, FileVideoCamera, Upload, X } from "lucide-react";
import { ApiError, uploadVideo } from "@/lib/client/api";
import { cn } from "@/lib/utils/cn";
import { formatBytes } from "@/lib/utils/format";
import { ACCEPT_ATTRIBUTE, validateFileClientSide } from "@/lib/validation/upload";
import { Button } from "@/components/ui/button";
import { Progress, Spinner } from "@/components/ui/misc";

type Phase =
  | { kind: "idle" }
  | { kind: "uploading"; file: File; loaded: number; total: number; startedAt: number; speed: number }
  | { kind: "processing"; file: File }
  | { kind: "error"; message: string; hint?: string; file?: File };

/**
 * Drag-and-drop uploader. Validates type/size locally for instant feedback;
 * the server re-validates (magic bytes + ffprobe) because the browser can't
 * be trusted. Shows real upload progress via XHR.
 */
export function UploadDropzone({ maxUploadMb = 500, onUploaded }: { maxUploadMb?: number; onUploaded?: (projectId: string) => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const start = async (file: File) => {
    const check = validateFileClientSide(file, maxUploadMb * 1024 * 1024);
    if (!check.ok) {
      setPhase({ kind: "error", message: check.error!, file });
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "uploading", file, loaded: 0, total: file.size, startedAt: Date.now(), speed: 0 });
    try {
      const { project } = await uploadVideo(
        file,
        (loaded, total) => {
          const now = Date.now();
          setPhase((p) => (p.kind === "uploading" ? { ...p, loaded, total, speed: loaded / Math.max(0.2, (now - p.startedAt) / 1000) } : p));
          if (loaded >= total) setPhase({ kind: "processing", file });
        },
        ctrl.signal,
      );
      onUploaded?.(project.id);
      router.push(`/editor/${project.id}`);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setPhase({ kind: "idle" });
        return;
      }
      const e = err instanceof ApiError ? err : null;
      setPhase({ kind: "error", message: e?.message ?? "The upload failed.", hint: e?.hint, file });
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void start(file);
  };

  const busy = phase.kind === "uploading" || phase.kind === "processing";
  const pct = phase.kind === "uploading" ? (phase.loaded / Math.max(1, phase.total)) * 100 : phase.kind === "processing" ? 100 : 0;
  const speed = phase.kind === "uploading" ? phase.speed : 0;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={busy ? (e) => e.preventDefault() : onDrop}
      className={cn(
        "relative flex min-h-60 flex-col items-center justify-center rounded-lg border border-dashed p-6 text-center transition-colors",
        dragging ? "border-accent bg-accent/[0.05]" : "border-border-strong bg-panel/60",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        aria-label="Choose a video file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void start(f);
          e.target.value = "";
        }}
      />

      {phase.kind === "idle" && (
        <>
          <div className="mb-3 flex size-11 items-center justify-center rounded-lg border border-border-strong bg-panel-2">
            <Upload className="size-5 text-muted" />
          </div>
          <p className="text-[15px] font-medium">Drop a video here</p>
          <p className="mt-1 text-[13px] text-muted">MP4, MOV, WebM or MKV · up to {maxUploadMb} MB</p>
          <Button className="mt-4" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
        </>
      )}

      {busy && (
        <div className="w-full max-w-sm" aria-live="polite">
          <div className="mb-3 flex items-center gap-3 text-left">
            <FileVideoCamera className="size-8 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-medium">{phase.file.name}</p>
              <p className="text-[12px] text-muted">
                {phase.kind === "uploading"
                  ? `${formatBytes(phase.loaded)} of ${formatBytes(phase.total)} · ${formatBytes(speed)}/s`
                  : "Checking the video and reading its metadata…"}
              </p>
            </div>
            {phase.kind === "uploading" && (
              <Button variant="ghost" size="icon-xs" aria-label="Cancel upload" onClick={() => abortRef.current?.abort()}>
                <X />
              </Button>
            )}
          </div>
          <Progress value={pct} indicatorClassName={phase.kind === "processing" ? "animate-pulse" : undefined} />
          <p className="mt-2 flex items-center justify-center gap-2 text-[12px] text-muted">
            {phase.kind === "processing" && <Spinner className="size-3" />}
            {phase.kind === "uploading" ? `Uploading… ${Math.round(pct)}%` : "Validating video"}
          </p>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="flex max-w-sm flex-col items-center" role="alert">
          <CircleAlert className="mb-2 size-7 text-danger" />
          <p className="text-[14px] font-medium">{phase.message}</p>
          {phase.hint && <p className="mt-1 text-[13px] text-muted">{phase.hint}</p>}
          <div className="mt-4 flex gap-2">
            {phase.file && (
              <Button variant="secondary" onClick={() => void start(phase.file!)}>
                Try again
              </Button>
            )}
            <Button onClick={() => inputRef.current?.click()}>Choose another file</Button>
          </div>
        </div>
      )}
    </div>
  );
}
