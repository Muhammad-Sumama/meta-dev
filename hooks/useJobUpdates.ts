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

const STALE_MS = 8_000;
const POLL_ACTIVE_MS = 450;
const POLL_IDLE_MS = 1_200;

/**
 * Keeps the open project's jobs current and applies their results.
 *
 * Live updates come over server-sent events (/api/projects/:id/events); if
 * EventSource isn't available or can't connect, it falls back to polling.
 * Either way, jobs that go quiet for a while are re-fetched, so a missed
 * event can't leave a job spinning forever.
 *
 * Each job's result is applied exactly once: when it finishes while we're
 * watching, or — after a reconnect — when a job we knew as running shows up
 * finished. Jobs that finished before we ever saw them run are only recorded
 * (replaying them could, say, resurrect a track the user deleted).
 */
export function useJobUpdates(projectId: string | undefined) {
  useEffect(() => {
    if (!projectId) return;
    let stopped = false;
    const handled = new Set(
      Object.values(useEditor.getState().jobs)
        .filter((j) => isTerminal(j.status))
        .map((j) => j.id),
    );
    const lastSeen = new Map<string, number>();

    const apply = (job: Job, source: "live" | "snapshot" | "poll") => {
      if (stopped || job.projectId !== projectId) return;
      lastSeen.set(job.id, Date.now());
      const prev = useEditor.getState().jobs[job.id];
      useEditor.getState().upsertJob(job);
      if (!isTerminal(job.status) || handled.has(job.id)) return;
      handled.add(job.id);
      const wasRunning = prev !== undefined && !isTerminal(prev.status);
      if (source === "live" || wasRunning) void onJobFinished(job, prev);
    };

    const activeJobs = () => Object.values(useEditor.getState().jobs).filter((j) => !isTerminal(j.status) && j.projectId === projectId);
    const refetch = async (ids: string[]) => {
      await Promise.all(
        ids.map(async (id) => {
          try {
            const { job } = await api.getJob(id);
            apply(job, "poll");
          } catch {
            /* transient; next round */
          }
        }),
      );
    };

    // --- polling (fallback) and stale-job safety net ---------------------------
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const poll = async () => {
      const active = activeJobs();
      await refetch(active.map((j) => j.id));
      if (!stopped && polling) pollTimer = setTimeout(poll, active.length ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    const startPolling = () => {
      if (polling || stopped) return;
      polling = true;
      pollTimer = setTimeout(poll, 300);
    };
    const staleTimer = setInterval(() => {
      if (polling) return;
      const now = Date.now();
      const stale = activeJobs().filter((j) => now - (lastSeen.get(j.id) ?? 0) > STALE_MS);
      if (stale.length) void refetch(stale.map((j) => j.id));
    }, STALE_MS / 2);

    // --- server-sent events ----------------------------------------------------------
    let source: EventSource | null = null;
    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      let opened = false;
      let failures = 0;
      source = new EventSource(api.eventsUrl(projectId));
      source.addEventListener("open", () => {
        opened = true;
        failures = 0;
      });
      source.addEventListener("snapshot", (e) => {
        const { jobs } = JSON.parse((e as MessageEvent<string>).data) as { jobs: Job[] };
        for (const job of jobs) apply(job, "snapshot");
      });
      source.addEventListener("job", (e) => apply(JSON.parse((e as MessageEvent<string>).data) as Job, "live"));
      source.addEventListener("error", () => {
        // EventSource reconnects by itself; give up on it if it never connects (e.g. a proxy blocks streaming).
        if (!opened && ++failures >= 3) {
          source?.close();
          startPolling();
        }
      });
    }

    return () => {
      stopped = true;
      source?.close();
      clearTimeout(pollTimer);
      clearInterval(staleTimer);
    };
  }, [projectId]);
}
