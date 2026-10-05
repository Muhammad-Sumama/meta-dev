"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { ArrowUp, Check, CircleAlert, CircleX, Cpu, RotateCcw, Sparkles, X } from "lucide-react";
import { cancelJob, submitCommand } from "@/lib/client/actions";
import type { CommandRecord } from "@/lib/schemas/project";
import type { Job } from "@/lib/schemas/job";
import { cn } from "@/lib/utils/cn";
import { useEditor } from "@/stores/editor";
import { useSystem } from "@/stores/system";
import { Button } from "@/components/ui/button";
import { Badge, Progress, Spinner } from "@/components/ui/misc";
import { Hint } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";

const DEMO_SUGGESTIONS = [
  "Track the red car",
  "Remove the man in the red shirt",
  "Isolate the dog and make the background transparent",
  "Blur the background behind the man in the blue shirt",
  "Highlight the person on the left",
];

const GENERIC_SUGGESTIONS = [
  "Select the person in the center",
  "Track the car",
  "Isolate the person and make the background transparent",
  "Blur the background behind the dog",
  "Remove the man in the red shirt",
];

const STAGES: Array<{ id: string; label: string }> = [
  { id: "understand", label: "Understand request" },
  { id: "locating", label: "Find the object" },
  { id: "segmenting", label: "Create mask" },
  { id: "tracking", label: "Track through video" },
];

function stageIndex(job: Job | undefined): number {
  if (!job) return 1;
  if (job.status === "completed") return STAGES.length;
  switch (job.progress.stage) {
    case "queued":
    case "starting":
    case "initializing":
    case "locating":
      return 1;
    case "segmenting":
      return 2;
    case "tracking":
    case "saving":
      return 3;
    default:
      return 1;
  }
}

export interface AIPanelHandle {
  focus(): void;
}

export const AIPanel = forwardRef<AIPanelHandle, { onOpenExport(preset: "mask" | "video" | "png_sequence"): void }>(function AIPanel(
  { onOpenExport },
  ref,
) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const project = useEditor((s) => s.project)!;
  const commands = useEditor((s) => s.commands);
  const jobs = useEditor((s) => s.jobs);
  const health = useSystem((s) => s.health);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const running = [...commands].reverse().find((c) => c.status === "running" && c.jobId && jobs[c.jobId]);
  const runningJob = running?.jobId ? jobs[running.jobId] : undefined;
  const busy = submitting || Boolean(runningJob && (runningJob.status === "queued" || runningJob.status === "processing"));

  const submit = async (value = text) => {
    const v = value.trim();
    if (!v || submitting) return;
    setSubmitting(true);
    const ok = await submitCommand(v, onOpenExport);
    setSubmitting(false);
    if (ok) setText("");
  };

  const suggestions = project.isDemo ? DEMO_SUGGESTIONS : GENERIC_SUGGESTIONS;
  const lang = health?.ai.language;
  const seg = health?.ai.segmentation;
  const history = [...commands].reverse().slice(0, 30);

  return (
    <section aria-labelledby="ai-panel-title" className="flex flex-col gap-3 p-3">
      <div className="flex items-center justify-between">
        <h2 id="ai-panel-title" className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Sparkles className="size-3.5 text-accent" /> Ask AI
        </h2>
        {lang && seg && (
          <Hint
            label={
              <span className="block max-w-64">
                Language: {lang.name}
                {lang.model ? ` (${lang.model})` : ""}
                <br />
                Segmentation: {seg.name}
              </span>
            }
          >
            <Badge variant={lang.kind === "mock" || seg.kind === "mock" ? "warning" : "success"} className="cursor-default">
              <Cpu className="size-3" />
              {seg.kind === "mock" ? "Mock inference" : seg.name}
              {lang.kind === "production" ? " · Llama" : ""}
            </Badge>
          </Hint>
        )}
      </div>

      <form
        className="group rounded-lg border border-border-strong bg-panel-2 transition-colors focus-within:border-accent/50"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="ai-command" className="block px-3 pt-2.5 text-[12px] font-medium text-muted">
          What do you want to isolate?
        </label>
        <textarea
          id="ai-command"
          ref={inputRef}
          rows={2}
          value={text}
          maxLength={500}
          placeholder="Track the person in the blue shirt"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") inputRef.current?.blur();
          }}
          className="block w-full resize-none bg-transparent px-3 py-1.5 text-[14px] leading-snug text-foreground placeholder:text-faint focus:outline-none"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="flex items-center gap-1 pl-1 text-[11px] text-faint">
            <Kbd>/</Kbd> to focus · <Kbd>↵</Kbd> to run
          </span>
          <Button type="submit" size="icon-xs" aria-label="Run command" disabled={!text.trim() || submitting}>
            {submitting ? <Spinner className="size-3.5" /> : <ArrowUp />}
          </Button>
        </div>
      </form>

      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">Suggestions</p>
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => void submit(s)}
              className="rounded-md border border-border bg-panel-2 px-2 py-1 text-left text-[12px] text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {running && runningJob && <RunningCard record={running} job={runningJob} />}

      {history.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-faint">History</p>
          <ul className="flex flex-col gap-1.5">
            {history.map((c) => (
              <HistoryItem key={c.id} record={c} onRetry={() => void submit(c.text)} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
});

function RunningCard({ record, job }: { record: CommandRecord; job: Job }) {
  const idx = stageIndex(job);
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/[0.04] p-3 animate-fade-in" aria-live="polite">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium leading-snug">“{record.text}”</p>
        <Hint label="Cancel">
          <Button variant="ghost" size="icon-xs" aria-label="Cancel" onClick={() => void cancelJob(job.id)}>
            <X />
          </Button>
        </Hint>
      </div>
      <ol className="mb-2.5 flex flex-col gap-1">
        {STAGES.map((st, i) => (
          <li key={st.id} className={cn("flex items-center gap-2 text-[12px]", i < idx ? "text-muted" : i === idx ? "text-foreground" : "text-faint")}>
            {i < idx ? <Check className="size-3.5 text-accent" /> : i === idx ? <Spinner className="size-3.5 text-accent" /> : <span className="mx-[5px] size-1 rounded-full bg-faint" />}
            {st.label}
            {i === idx && job.progress.stage === "tracking" && job.progress.total > 0 && (
              <span className="ml-auto font-mono text-[11px] text-muted tabular">
                {job.progress.current}/{job.progress.total}
              </span>
            )}
          </li>
        ))}
      </ol>
      <Progress value={job.progress.fraction * 100} />
      <p className="mt-1.5 truncate text-[11.5px] text-muted">{job.status === "queued" ? "Waiting for a free worker…" : job.progress.message}</p>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { llama: "Llama", rules: "Built-in parser", fallback: "Fallback parser" };

function HistoryItem({ record, onRetry }: { record: CommandRecord; onRetry(): void }) {
  const icon =
    record.status === "completed" ? (
      <Check className="size-3.5 text-success" />
    ) : record.status === "failed" ? (
      <CircleX className="size-3.5 text-danger" />
    ) : record.status === "cancelled" ? (
      <CircleAlert className="size-3.5 text-faint" />
    ) : (
      <Spinner className="size-3.5 text-accent" />
    );
  return (
    <li className="rounded-md border border-border bg-panel-2/60 px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="mt-0.5">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug text-foreground/90">{record.text}</p>
          {record.planSummary && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{record.planSummary}</p>}
          {record.error && (
            <p className="mt-1 text-[11.5px] leading-snug text-danger">
              {record.error.message}
              {record.error.hint && <span className="block text-muted">{record.error.hint}</span>}
            </p>
          )}
          {record.warnings.map((w) => (
            <p key={w} className="mt-1 text-[11.5px] text-warning">
              {w}
            </p>
          ))}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {record.source && <Badge variant={record.source === "llama" ? "success" : "default"}>{SOURCE_LABEL[record.source]}</Badge>}
            {record.command && (
              <details className="group/details w-full">
                <summary className="cursor-pointer list-none text-[11px] text-faint hover:text-muted [&::-webkit-details-marker]:hidden">
                  <span className="group-open/details:hidden">Show structured command</span>
                  <span className="hidden group-open/details:inline">Hide structured command</span>
                </summary>
                <pre className="mt-1.5 max-h-56 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-[10.5px] leading-relaxed text-muted">
                  {JSON.stringify(record.command, null, 2)}
                </pre>
              </details>
            )}
            {record.status === "failed" && record.error?.retryable !== false && (
              <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-foreground">
                <RotateCcw className="size-3" /> Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
