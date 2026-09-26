"use client";

import { useMemo, useState } from "react";
import { CircleCheck, Download, FileBraces, Film, Images, Layers, TriangleAlert, X } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import { autosave } from "@/lib/client/autosave";
import { cancelJob } from "@/lib/client/actions";
import type { ExportFormat, ExportKind, ExportSettings } from "@/lib/schemas/project";
import { cn } from "@/lib/utils/cn";
import { formatBytes, formatTimecode } from "@/lib/utils/format";
import { useEditor } from "@/stores/editor";
import { useSystem } from "@/stores/system";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label, Progress, Spinner } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EFFECT_OPTIONS } from "@/components/editor/OutputPanel";

const FORMAT_OPTIONS: Record<ExportKind, Array<{ value: ExportFormat; label: string; alpha: boolean }>> = {
  video: [
    { value: "mp4_h264", label: "MP4 · H.264", alpha: false },
    { value: "webm_vp9", label: "WebM · VP9", alpha: false },
    { value: "webm_vp9_alpha", label: "WebM · VP9 with transparency", alpha: true },
    { value: "mov_prores4444", label: "MOV · ProRes 4444 with transparency", alpha: true },
  ],
  mask: [
    { value: "mask_mp4", label: "Matte video · MP4 (white = subject)", alpha: false },
    { value: "mask_png_zip", label: "Mask PNG sequence · ZIP", alpha: false },
  ],
  png_sequence: [{ value: "png_zip", label: "RGBA PNG sequence · ZIP", alpha: true }],
  project: [{ value: "project_json", label: "OpenSAM project · JSON", alpha: false }],
};

const KIND_INFO: Record<ExportKind, { label: string; icon: typeof Film; blurb: string }> = {
  video: { label: "Video", icon: Film, blurb: "Render the video with the current effect applied." },
  mask: { label: "Mask", icon: Layers, blurb: "A black-and-white matte for compositing in other editors." },
  png_sequence: { label: "PNG Sequence", icon: Images, blurb: "Numbered RGBA frames. Transparency is preserved." },
  project: { label: "Project", icon: FileBraces, blurb: "Project metadata, masks (RLE) and AI command history as JSON." },
};

interface ExportResultInfo {
  exportId: string;
  downloadName: string;
  sizeBytes: number;
  frames: number;
  width: number;
  height: number;
  warnings: string[];
}

export function ExportDialog({
  open,
  onOpenChange,
  preset,
  openId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  preset?: ExportKind;
  /** Increments each time the dialog is opened (applies `preset`). */
  openId: number;
}) {
  const project = useEditor((s) => s.project)!;
  const composite = useEditor((s) => s.doc.composite);
  const trackCount = useEditor((s) => s.doc.order.length);
  const jobs = useEditor((s) => s.jobs);
  const health = useSystem((s) => s.health);

  const [kind, setKind] = useState<ExportKind>(preset ?? "video");
  const [chosenFormat, setFormat] = useState<ExportFormat | null>(null);
  const [resolution, setResolution] = useState<ExportSettings["resolution"]>("source");
  const [fps, setFps] = useState<ExportSettings["fps"]>("source");
  const [quality, setQuality] = useState<ExportSettings["quality"]>("high");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [rangeMode, setRangeMode] = useState<"all" | "custom">("all");
  const [range, setRange] = useState({ start: 0, end: project.video.frameCount - 1 });
  const [jobId, setJobId] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);

  // Apply the preset when the dialog is (re)opened — adjusted during render, not in an effect.
  const [seenOpenId, setSeenOpenId] = useState(openId);
  if (openId !== seenOpenId) {
    setSeenOpenId(openId);
    if (preset) {
      setKind(preset);
      setFormat(null);
    }
  }

  // The chosen format if it fits the current tab, else the best default for it.
  const opts = FORMAT_OPTIONS[kind];
  const preferAlpha = kind === "video" && composite.effect === "remove_background";
  const format: ExportFormat =
    chosenFormat && opts.some((o) => o.value === chosenFormat)
      ? chosenFormat
      : (opts.find((o) => (preferAlpha ? o.alpha : true) && health?.formats[o.value] !== false) ?? opts[0]).value;

  const job = jobId ? jobs[jobId] : undefined;
  const running = job && (job.status === "queued" || job.status === "processing");
  const result = job?.status === "completed" ? (job.result as ExportResultInfo) : null;
  const formatInfo = FORMAT_OPTIONS[kind].find((o) => o.value === format);
  const effectLabel = EFFECT_OPTIONS.find((e) => e.value === composite.effect)?.label ?? composite.effect;

  const warnings = useMemo(() => {
    const w: string[] = [];
    if (kind === "video" && composite.effect === "remove_background" && formatInfo && !formatInfo.alpha) {
      w.push("MP4/WebM without alpha can't store transparency — the removed background will be black. Choose a “with transparency” format or a PNG sequence.");
    }
    if ((kind === "mask" || kind === "png_sequence" || (kind === "video" && composite.effect !== "none")) && trackCount === 0) {
      w.push("There's no mask yet. Select or track an object first.");
    }
    if (health && formatInfo && health.formats[formatInfo.value] === false) {
      w.push("This format isn't available in the server's FFmpeg build.");
    }
    return w;
  }, [kind, composite.effect, formatInfo, trackCount, health]);

  const blocked = warnings.some((w) => w.startsWith("There's no mask") || w.includes("isn't available"));

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      await autosave.flush();
      const settings: ExportSettings = {
        kind,
        format,
        resolution,
        fps,
        quality,
        includeAudio,
        ...(rangeMode === "custom" ? { range: { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) } } : {}),
      };
      const res = await api.startExport(project.id, { settings, composite });
      useEditor.getState().upsertJob(res.job);
      setJobId(res.job.id);
      setExportId(res.exportId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const reset = () => {
    setJobId(null);
    setExportId(null);
    setError(null);
  };

  const cur = useEditor((s) => s.currentFrame);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            {project.video.width}×{project.video.height} · {project.video.frameCount} frames · effect: <span className="text-foreground/85">{effectLabel}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto px-5 py-4">
          <Tabs value={kind} onValueChange={(v) => { setKind(v as ExportKind); reset(); }}>
            <TabsList className="w-full">
              {(Object.keys(KIND_INFO) as ExportKind[]).map((k) => {
                const Icon = KIND_INFO[k].icon;
                return (
                  <TabsTrigger key={k} value={k} disabled={Boolean(running)}>
                    <Icon /> <span className="hidden sm:inline">{KIND_INFO[k].label}</span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>
          <p className="-mt-1 text-[12.5px] text-muted">{KIND_INFO[kind].blurb}</p>

          <fieldset disabled={Boolean(running)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="export-format">Format</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                <SelectTrigger id="export-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMAT_OPTIONS[kind].map((o) => (
                    <SelectItem key={o.value} value={o.value} disabled={health?.formats[o.value] === false}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {kind !== "project" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-res">Resolution</Label>
                  <Select value={resolution} onValueChange={(v) => setResolution(v as ExportSettings["resolution"])}>
                    <SelectTrigger id="export-res">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="source">Source ({project.video.height}p)</SelectItem>
                      {(["2160", "1440", "1080", "720", "480", "360"] as const)
                        .filter((r) => Number(r) < project.video.height)
                        .map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}p
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-fps">Frame rate</Label>
                  <Select value={fps} onValueChange={(v) => setFps(v as ExportSettings["fps"])}>
                    <SelectTrigger id="export-fps">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="source">Source ({Math.round(project.video.fps * 100) / 100} fps)</SelectItem>
                      {(["24", "25", "30", "50", "60"] as const).map((f) => (
                        <SelectItem key={f} value={f}>
                          {f} fps
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {!format.includes("png") && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="export-quality">Quality</Label>
                    <Select value={quality} onValueChange={(v) => setQuality(v as ExportSettings["quality"])}>
                      <SelectTrigger id="export-quality">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="low">Low (smaller file)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {kind === "video" && project.video.hasAudio && (
                  <label className="flex items-center justify-between gap-2 self-end rounded-md border border-border px-2.5 py-1.5 text-[13px]">
                    Include audio
                    <Switch checked={includeAudio} onCheckedChange={setIncludeAudio} aria-label="Include audio" />
                  </label>
                )}
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label>Range</Label>
                  <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    <Tabs value={rangeMode} onValueChange={(v) => setRangeMode(v as "all" | "custom")}>
                      <TabsList className="h-8">
                        <TabsTrigger value="all">Whole video</TabsTrigger>
                        <TabsTrigger value="custom">Custom</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    {rangeMode === "custom" && (
                      <span className="flex items-center gap-1.5 text-muted">
                        <Button size="xs" variant="outline" onClick={() => setRange((r) => ({ ...r, start: cur }))}>
                          In: {formatTimecode(range.start, project.video.fps)}
                        </Button>
                        →
                        <Button size="xs" variant="outline" onClick={() => setRange((r) => ({ ...r, end: cur }))}>
                          Out: {formatTimecode(range.end, project.video.fps)}
                        </Button>
                        <span className="text-[11px] text-faint">(click to set from playhead)</span>
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </fieldset>

          {warnings.map((w) => (
            <p key={w} className="flex gap-2 rounded-md border border-warning/25 bg-warning/[0.06] px-3 py-2 text-[12.5px] leading-snug text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
            </p>
          ))}

          {error && (
            <p className="rounded-md border border-danger/30 bg-danger/[0.06] px-3 py-2 text-[12.5px] text-danger">
              {error.title}
              {error.hint && <span className="block text-muted">{error.hint}</span>}
            </p>
          )}

          {job && (
            <div className="rounded-md border border-border bg-panel-2 p-3" aria-live="polite">
              {running && (
                <>
                  <p className="mb-2 flex items-center gap-2 text-[13px] font-medium">
                    <Spinner className="size-3.5 text-accent" /> {job.status === "queued" ? "Queued…" : job.progress.stage === "rendering" ? "Rendering…" : "Preparing export…"}
                  </p>
                  <Progress value={job.progress.fraction * 100} />
                  <p className="mt-1.5 font-mono text-[11.5px] text-muted tabular">{job.progress.message}</p>
                </>
              )}
              {result && (
                <div className="flex flex-col gap-2">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-success">
                    <CircleCheck className="size-4" /> Export ready
                  </p>
                  <p className="text-[12.5px] text-muted">
                    {result.downloadName} · {formatBytes(result.sizeBytes)}
                    {result.frames > 0 && ` · ${result.frames} frames · ${result.width}×${result.height}`}
                  </p>
                  {result.warnings.map((w) => (
                    <p key={w} className="text-[12px] text-warning">
                      {w}
                    </p>
                  ))}
                </div>
              )}
              {job.status === "failed" && (
                <p className="text-[12.5px] text-danger">
                  {job.error?.message ?? "The export failed."}
                  {job.error?.hint && <span className="block text-muted">{job.error.hint}</span>}
                </p>
              )}
              {job.status === "cancelled" && <p className="text-[12.5px] text-muted">Export cancelled.</p>}
            </div>
          )}
        </div>

        <DialogFooter>
          {running ? (
            <Button variant="secondary" onClick={() => void cancelJob(job!.id)}>
              <X /> Cancel export
            </Button>
          ) : result && exportId ? (
            <>
              <Button variant="ghost" onClick={reset}>
                New export
              </Button>
              <Button asChild>
                <a href={api.exportUrl(project.id, exportId)} download={result.downloadName}>
                  <Download /> Download
                </a>
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={start} disabled={starting || blocked} className={cn(starting && "opacity-80")}>
                {starting ? <Spinner className="size-3.5" /> : <Download />}
                {kind === "project" ? "Export project" : `Export ${KIND_INFO[kind].label.toLowerCase()}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
