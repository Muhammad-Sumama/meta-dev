"use client";

import { toast } from "sonner";
import { applyStrokeToCounts, type Pt } from "@/lib/mask/edit";
import { isEmptyMask } from "@/lib/mask/rle";
import type { BoxPrompt, PointPrompt, Track } from "@/lib/schemas/project";
import { TRACK_COLORS } from "@/lib/schemas/project";
import { newId } from "@/lib/utils/ids";
import { useEditor } from "@/stores/editor";
import { api, ApiError, errorText } from "./api";
import { autosave } from "./autosave";
import { addTrack, removeTrack, setComposite, setFrameMask, updateTrack } from "./doc";

/**
 * Editor use-cases invoked by tools, panels and shortcuts. Each mutation goes
 * through `commit()` so it is undoable and autosaved.
 */

function nextColor(tracks: Record<string, Track>) {
  const used = new Set(Object.values(tracks).map((t) => t.color));
  return TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[Object.keys(tracks).length % TRACK_COLORS.length];
}

function showError(err: unknown) {
  if ((err as Error)?.name === "AbortError") return;
  const { title, hint } = errorText(err);
  toast.error(title, { description: hint });
}

export function createEmptyTrack(name?: string): Track {
  const s = useEditor.getState();
  const p = s.project!;
  const now = new Date().toISOString();
  return {
    id: newId("trk"),
    name: name ?? `Object ${s.doc.order.length + 1}`,
    color: nextColor(s.doc.tracks),
    visible: true,
    source: "manual",
    provider: "manual",
    width: p.analysis.width,
    height: p.analysis.height,
    prompts: [],
    frames: {},
    createdAt: now,
    updatedAt: now,
  };
}

let segmentAbort: AbortController | null = null;

/** Click / box prompt → mask on the current frame (and optional propagation). */
export async function segmentPrompt(input: { frame: number; point?: PointPrompt; box?: BoxPrompt; newObject?: boolean }) {
  const s = useEditor.getState();
  const project = s.project;
  if (!project) return;
  const selected = !input.newObject && s.selectedTrackId ? s.doc.tracks[s.selectedTrackId] : null;
  if (input.point?.label === 0 && !selected) {
    toast.message("Select an object first", { description: "Subtract mode removes parts of the selected object." });
    return;
  }
  const existing = selected?.prompts.find((p) => p.frameIndex === input.frame);
  const points = [...(existing?.points ?? []), ...(input.point ? [input.point] : [])];
  const box = input.box ?? existing?.box;

  segmentAbort?.abort();
  const ctrl = new AbortController();
  segmentAbort = ctrl;
  s.set("segmenting", true);
  try {
    const res = await api.segment(project.id, { frameIndex: input.frame, points, box }, ctrl.signal);
    const prompt = { frameIndex: input.frame, points, ...(box ? { box } : {}) };
    if (selected) {
      useEditor.getState().commit(input.point?.label === 0 ? "Remove from selection" : "Refine selection", (doc) => {
        const t = doc.tracks[selected.id];
        if (!t) return doc;
        const d = setFrameMask(doc, t.id, input.frame, res.counts);
        return updateTrack(d, t.id, { prompts: [...t.prompts.filter((p) => p.frameIndex !== input.frame), prompt] });
      });
      if (useEditor.getState().editScope === "sequence" && Object.keys(selected.frames).length > 1) {
        await startTracking(selected.id, { mode: "from-here" });
      }
    } else {
      const track = { ...createEmptyTrack(), frames: { [input.frame]: res.counts }, prompts: [prompt] };
      useEditor.getState().commit("Select object", (doc) => addTrack(doc, track), { select: track.id });
    }
  } catch (err) {
    showError(err);
  } finally {
    if (segmentAbort === ctrl) {
      segmentAbort = null;
      useEditor.getState().set("segmenting", false);
    }
  }
}

/**
 * Starts a tracking job for a track.
 *  - "full": propagate from the anchor frame through the whole clip (both directions)
 *  - "from-here": re-track forward from the current frame, keeping earlier frames
 */
export async function startTracking(trackId: string, opts: { mode: "full" | "from-here" }) {
  const s = useEditor.getState();
  const project = s.project;
  const track = s.doc.tracks[trackId];
  if (!project || !track) return;
  const frame = s.currentFrame;
  const keyFrames = Object.keys(track.frames).map(Number);
  let anchor = frame;
  if (!track.frames[frame]) {
    const promptFrames = track.prompts.map((p) => p.frameIndex).filter((f) => track.frames[f]);
    anchor = promptFrames.at(-1) ?? keyFrames.sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame))[0] ?? -1;
  }
  if (anchor < 0 || !track.frames[anchor]) {
    toast.message("Nothing to track yet", { description: "Click the object on this frame first." });
    return;
  }
  const last = project.video.frameCount - 1;
  try {
    await autosave.flush();
    const { job } = await api.track(project.id, {
      trackId,
      name: track.name,
      keyframes: [{ frameIndex: anchor, points: [], mask: track.frames[anchor] }],
      range: opts.mode === "from-here" ? { start: anchor, end: last } : { start: 0, end: last },
      direction: opts.mode === "from-here" ? "forward" : "both",
      preserveOutside: opts.mode === "from-here",
    });
    useEditor.getState().upsertJob(job);
  } catch (err) {
    showError(err);
  }
}

/** Track tool: click → select → immediately track through the video. */
export async function selectAndTrack(frame: number, point: PointPrompt) {
  const s = useEditor.getState();
  if (!s.project) return;
  s.set("segmenting", true);
  try {
    const res = await api.segment(s.project.id, { frameIndex: frame, points: [point] });
    const track = { ...createEmptyTrack(), frames: { [frame]: res.counts }, prompts: [{ frameIndex: frame, points: [point] }] };
    useEditor.getState().commit("Select object", (doc) => addTrack(doc, track), { select: track.id });
    await startTracking(track.id, { mode: "full" });
  } catch (err) {
    showError(err);
  } finally {
    useEditor.getState().set("segmenting", false);
  }
}

/** Brush / eraser stroke (points in mask pixels) on the current frame or the whole sequence. */
export function applyStroke(pts: Pt[], mode: "add" | "erase") {
  const s = useEditor.getState();
  const project = s.project;
  if (!project || !pts.length) return;
  const w = project.analysis.width;
  const h = project.analysis.height;
  const radius = s.brushSize;
  const value = mode === "add" ? 1 : 0;
  let trackId = s.selectedTrackId && s.doc.tracks[s.selectedTrackId] ? s.selectedTrackId : null;
  if (!trackId && mode === "erase") {
    toast.message("Select an object to erase from");
    return;
  }
  const frame = s.currentFrame;
  const scope = s.editScope;
  const label = mode === "add" ? (scope === "sequence" ? "Brush (all frames)" : "Brush stroke") : scope === "sequence" ? "Erase (all frames)" : "Erase";

  s.commit(
    label,
    (doc) => {
      let d = doc;
      if (!trackId) {
        const t = createEmptyTrack();
        d = addTrack(d, t);
        trackId = t.id;
      }
      const t = d.tracks[trackId!];
      const frames = { ...t.frames };
      const targets = scope === "sequence" ? new Set([...Object.keys(frames).map(Number), frame]) : new Set([frame]);
      for (const f of targets) {
        const next = applyStrokeToCounts(frames[f], w, h, pts, radius, value);
        if (next) frames[f] = next;
        else delete frames[f];
      }
      return updateTrack(d, t.id, { frames });
    },
  );
  if (!useEditor.getState().selectedTrackId && trackId) useEditor.getState().selectTrack(trackId);
}

export function clearFrame(trackId: string, frame: number) {
  useEditor.getState().commit("Clear frame", (doc) => setFrameMask(doc, trackId, frame, null));
}

export function deleteTrack(trackId: string) {
  const s = useEditor.getState();
  const name = s.doc.tracks[trackId]?.name ?? "object";
  s.commit(`Delete ${name}`, (doc) => removeTrack(doc, trackId), {
    select: s.selectedTrackId === trackId ? null : s.selectedTrackId,
  });
}

export function renameTrack(trackId: string, name: string) {
  const clean = name.trim().slice(0, 80);
  if (!clean) return;
  useEditor.getState().commit("Rename object", (doc) => updateTrack(doc, trackId, { name: clean }));
}

export function toggleTrackVisibility(trackId: string) {
  const t = useEditor.getState().doc.tracks[trackId];
  if (!t) return;
  useEditor.getState().commit(t.visible ? "Hide object" : "Show object", (doc) => updateTrack(doc, trackId, { visible: !t.visible }));
}

export function updateComposite(label: string, patch: Parameters<typeof setComposite>[1]) {
  useEditor.getState().commit(label, (doc) => setComposite(doc, patch));
}

/** Natural-language command from the AI panel. */
export async function submitCommand(text: string, onPlan?: (preset: "mask" | "video" | "png_sequence") => void) {
  const s = useEditor.getState();
  const project = s.project;
  if (!project) return false;
  const selected = s.selectedTrackId && s.doc.tracks[s.selectedTrackId] && !isEmptyTrack(s.doc.tracks[s.selectedTrackId]) ? s.selectedTrackId : undefined;
  if (selected) await autosave.flush();
  try {
    const res = await api.command(project.id, { text, frameIndex: s.currentFrame, selectedTrackId: selected });
    const st = useEditor.getState();
    st.addCommand(res.record);
    if (res.job) st.upsertJob(res.job);
    for (const w of res.parsed.warnings) toast.warning(w);
    if (!res.job) {
      const effect = res.plan.steps.find((p) => p.kind === "apply_effect");
      if (effect?.kind === "apply_effect" && res.plan.existingTrackId) {
        st.commit(`AI: ${text.slice(0, 40)}`, (doc) =>
          setComposite(doc, {
            effect: effect.effect.type,
            subjectTrackIds: [res.plan.existingTrackId!],
            ...(effect.effect.color ? { backgroundColor: effect.effect.color } : {}),
            ...(effect.effect.strength !== undefined ? { blurStrength: effect.effect.strength } : {}),
          }),
        );
        st.set("previewEffect", true);
        autosave.markCompositeSaved(useEditor.getState().doc.composite);
      }
      const exp = res.plan.steps.find((p) => p.kind === "open_export");
      if (exp?.kind === "open_export") onPlan?.(exp.preset);
    }
    return true;
  } catch (err) {
    const e = err instanceof ApiError ? err : null;
    useEditor.getState().addCommand({
      id: newId("cmd"),
      text,
      createdAt: new Date().toISOString(),
      command: null,
      status: "failed",
      warnings: [],
      error: { code: e?.code ?? "INTERNAL", message: e?.message ?? "Something went wrong.", hint: e?.hint, retryable: e?.retryable ?? true },
    });
    return false;
  }
}

function isEmptyTrack(t: Track) {
  return Object.values(t.frames).every((c) => isEmptyMask(c));
}

export async function cancelJob(jobId: string) {
  try {
    const { job } = await api.cancelJob(jobId);
    useEditor.getState().upsertJob(job);
  } catch (err) {
    showError(err);
  }
}
