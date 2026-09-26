import type { RLECounts } from "@/lib/mask/rle";
import type { Composite, Track } from "@/lib/schemas/project";

/**
 * The editable document (everything undo/redo covers). Operations are pure
 * and structurally shared: an edit to one frame copies that track's frame map
 * but reuses every other array, so history snapshots stay cheap.
 */
export interface Doc {
  tracks: Record<string, Track>;
  order: string[];
  composite: Composite;
}

export function addTrack(doc: Doc, track: Track): Doc {
  const exists = Boolean(doc.tracks[track.id]);
  return {
    ...doc,
    tracks: { ...doc.tracks, [track.id]: track },
    order: exists ? doc.order : [...doc.order, track.id],
  };
}

export function removeTrack(doc: Doc, id: string): Doc {
  if (!doc.tracks[id]) return doc;
  const tracks = { ...doc.tracks };
  delete tracks[id];
  return {
    ...doc,
    tracks,
    order: doc.order.filter((t) => t !== id),
    composite: { ...doc.composite, subjectTrackIds: doc.composite.subjectTrackIds.filter((t) => t !== id) },
  };
}

export function updateTrack(doc: Doc, id: string, patch: Partial<Track>): Doc {
  const t = doc.tracks[id];
  if (!t) return doc;
  return { ...doc, tracks: { ...doc.tracks, [id]: { ...t, ...patch, updatedAt: new Date().toISOString() } } };
}

export function setFrameMask(doc: Doc, id: string, frame: number, counts: RLECounts | null): Doc {
  const t = doc.tracks[id];
  if (!t) return doc;
  const frames = { ...t.frames };
  if (counts) frames[frame] = counts;
  else delete frames[frame];
  return updateTrack(doc, id, { frames });
}

export function setComposite(doc: Doc, composite: Partial<Composite>): Doc {
  return { ...doc, composite: { ...doc.composite, ...composite } };
}
