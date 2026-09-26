"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { autosave } from "@/lib/client/autosave";
import { addTrack, setComposite } from "@/lib/client/doc";
import { isTerminal, type Job } from "@/lib/schemas/job";
import { useEditor } from "@/stores/editor";

interface SegmentResult {
  trackId: string;
  maskedFrames: number;
  keyframe: number;
  effect?: { type: string; color?: string; strength?: number };
  providerKind: "mock" | "production";
}

async function onJobFinished(job: Job, prev: Job | undefined) {
  const s = useEditor.getState();
  const project = s.project;
  if (!project || job.projectId !== project.id) return;

  if (job.type === "ingest") {
    try {
      const bundle = await api.getProject(project.id);
      useEditor.getState().setProject(bundle.project);
    } catch {
      /* next poll */
    }
    if (job.status === "failed") toast.error(job.error?.message ?? "We couldn't prepare this video.", { description: job.error?.hint });
    return;
  }

  if (job.type === "segment") {
    const cmd = s.commands.find((c) => c.jobId === job.id);
    if (job.status === "completed" && job.result) {
      const result = job.result as SegmentResult;
      try {
        const { track } = await api.getTrack(project.id, result.trackId);
        autosave.markSaved(track);
        const label = cmd ? `AI: ${cmd.text.slice(0, 48)}` : `Track ${track.name}`;
        useEditor.getState().commit(
          label,
          (doc) => {
            let d = addTrack(doc, track);
            if (result.effect && result.effect.type !== "none") {
              d = setComposite(d, {
                effect: result.effect.type as never,
                subjectTrackIds: [track.id],
                ...(result.effect.color ? { backgroundColor: result.effect.color } : {}),
                ...(result.effect.strength !== undefined ? { blurStrength: result.effect.strength } : {}),
              });
            }
            return d;
          },
          { select: track.id },
        );
        const after = useEditor.getState();
        if (result.effect && result.effect.type !== "none") {
          autosave.markCompositeSaved(after.doc.composite);
          after.set("previewEffect", true);
        }
        if (cmd) after.updateCommand(cmd.id, { status: "completed", trackId: track.id });
        toast.success(`${track.name}: masked ${result.maskedFrames} frame${result.maskedFrames === 1 ? "" : "s"}`, {
          description: result.providerKind === "mock" ? "Mock inference (classical CV) — connect SAM 2 for production quality." : undefined,
        });
      } catch {
        toast.error("Tracking finished, but we couldn't load the result. Reload the page.");
      }
    } else if (job.status === "failed") {
      if (cmd) useEditor.getState().updateCommand(cmd.id, { status: "failed", error: job.error });
      toast.error(job.error?.message ?? "Tracking failed.", { description: job.error?.hint });
    } else if (job.status === "cancelled") {
      if (cmd) useEditor.getState().updateCommand(cmd.id, { status: "cancelled" });
      if (prev && prev.status !== "cancelled") toast.message("Tracking cancelled");
    }
  }
}

/** Polls active jobs for the open project and applies their results. */
export function useJobPolling(projectId: string | undefined) {
  useEffect(() => {
    if (!projectId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { jobs } = useEditor.getState();
      const active = Object.values(jobs).filter((j) => !isTerminal(j.status) && j.projectId === projectId);
      await Promise.all(
        active.map(async (j) => {
          try {
            const { job } = await api.getJob(j.id);
            useEditor.getState().upsertJob(job);
            if (isTerminal(job.status)) await onJobFinished(job, j);
          } catch {
            /* transient; retry next tick */
          }
        }),
      );
      if (!stopped) timer = setTimeout(tick, active.length ? 450 : 1200);
    };
    timer = setTimeout(tick, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [projectId]);
}
