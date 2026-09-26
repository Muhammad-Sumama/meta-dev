import type { Project, ProjectListItem, Track, TrackSummary } from "@/lib/schemas/project";

/**
 * Persistence boundary for projects and tracks.
 *
 * The MVP ships a filesystem implementation. A production deployment would
 * implement this interface on PostgreSQL (project + track metadata, JSONB for
 * masks or object storage for large mask payloads) without touching callers.
 */
export interface ProjectRepository {
  create(project: Project): Promise<Project>;
  get(projectId: string): Promise<Project | null>;
  /** Atomic read-modify-write; the mutator may return a new object or mutate in place. */
  update(projectId: string, mutator: (project: Project) => Project | void): Promise<Project>;
  list(): Promise<ProjectListItem[]>;
  delete(projectId: string): Promise<void>;

  listTracks(projectId: string): Promise<TrackSummary[]>;
  getTrack(projectId: string, trackId: string): Promise<Track | null>;
  saveTrack(projectId: string, track: Track): Promise<Track>;
  deleteTrack(projectId: string, trackId: string): Promise<void>;
}
