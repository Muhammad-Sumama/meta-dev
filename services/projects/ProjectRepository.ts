import type { Project, ProjectListItem, Track, TrackSummary } from "@/lib/schemas/project";

/**
 * Persistence boundary for projects and tracks (metadata and masks; media
 * files live in DATA_DIR either way).
 *
 *   - FileSystemProjectRepository: JSON files in DATA_DIR (default).
 *   - PostgresProjectRepository: PROJECT_STORE=postgres.
 *
 * Both are safe with several processes (web replicas, workers) writing.
 */
export interface ProjectRepository {
  readonly backend: "file" | "postgres";
  /** Cheap reachability check for /api/health. */
  health(): Promise<{ ok: boolean; message: string }>;

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
