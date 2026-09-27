import "server-only";
import pg from "pg";
import { AppError } from "@/lib/errors";
import { ID_PATTERNS, ProjectSchema, TrackSchema, type Project, type ProjectListItem, type Track, type TrackSummary } from "@/lib/schemas/project";
import { prepareProjectDirs, removeProjectFiles } from "../../storage/projectFiles";
import { summarizeTrack } from "../FileSystemProjectRepository";
import type { ProjectRepository } from "../ProjectRepository";
import { MIGRATIONS } from "./migrations";

/**
 * Projects and tracks in PostgreSQL (PROJECT_STORE=postgres).
 *
 *   opensam_projects  id, name, is_demo, data (jsonb: the whole Project), timestamps
 *   opensam_tracks    (project_id, id), meta (jsonb: Track without frames),
 *                     frames (json: RLE masks), masked_frames, coverage — so
 *                     listing tracks never loads mask data
 *
 * `update()` is a transaction with SELECT … FOR UPDATE, so concurrent writers
 * (web replicas, worker processes) serialize per project. Migrations run on
 * first use under an advisory lock, so several processes can start at once.
 * Media files stay in DATA_DIR.
 */

const MIGRATION_LOCK = 0x05e_4a11; // arbitrary, constant advisory lock key

const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "57P01", "57P02", "57P03", "53300"]);

function toStorageError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const e = err as { code?: string; message?: string };
  if ((e.code && UNAVAILABLE_CODES.has(e.code)) || /timeout|terminated|connect/i.test(e.message ?? "")) {
    throw new AppError("STORAGE_UNAVAILABLE", { message: "We couldn't reach the project database.", cause: err });
  }
  throw err;
}

type Queryable = Pick<pg.PoolClient, "query">;

export class PostgresProjectRepository implements ProjectRepository {
  readonly backend = "postgres" as const;
  private readonly pool: pg.Pool;
  private migrated: Promise<void> | null = null;

  constructor(connectionString: string, { poolSize = 10 }: { poolSize?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: poolSize, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
    // Idle clients can error when the server restarts; the pool replaces them.
    this.pool.on("error", (err) => console.error("[projects] postgres idle client error:", err.message));
  }

  // --- plumbing ------------------------------------------------------------------
  private ready(): Promise<void> {
    this.migrated ??= this.migrate().catch((err) => {
      this.migrated = null;
      throw err;
    });
    return this.migrated;
  }

  private async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
      await client.query(
        "CREATE TABLE IF NOT EXISTS opensam_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const { rows } = await client.query<{ id: number }>("SELECT id FROM opensam_migrations");
      const done = new Set(rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        await client.query("BEGIN");
        try {
          await client.query(m.sql);
          await client.query("INSERT INTO opensam_migrations (id, name) VALUES ($1, $2)", [m.id, m.name]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
      client.release();
    }
  }

  private async run<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    try {
      await this.ready();
      return await fn(this.pool);
    } catch (err) {
      return toStorageError(err);
    }
  }

  private async transaction<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      await this.ready();
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      return toStorageError(err);
    }
  }

  async health() {
    try {
      await this.ready();
      await this.pool.query("SELECT 1");
      return { ok: true, message: "PostgreSQL" };
    } catch (err) {
      return { ok: false, message: `PostgreSQL is unreachable: ${(err as Error).message}` };
    }
  }

  async close() {
    await this.pool.end();
  }

  // --- projects ---------------------------------------------------------------------
  private static parseProject(id: string, data: unknown): Project | null {
    const parsed = ProjectSchema.safeParse(data);
    if (!parsed.success) {
      console.error(`[projects] ${id} failed validation`, parsed.error.issues.slice(0, 3));
      return null;
    }
    return parsed.data;
  }

  async create(project: Project): Promise<Project> {
    const valid = ProjectSchema.parse(project);
    await this.run(async (db) => {
      try {
        await db.query(
          "INSERT INTO opensam_projects (id, name, is_demo, data, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)",
          [valid.id, valid.name, valid.isDemo, JSON.stringify(valid), valid.createdAt, valid.updatedAt],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") throw new AppError("CONFLICT", { message: "A project with this id already exists." });
        throw err;
      }
    });
    await prepareProjectDirs(valid.id);
    return valid;
  }

  async get(projectId: string): Promise<Project | null> {
    if (!ID_PATTERNS.project.test(projectId)) return null;
    return this.run(async (db) => {
      const { rows } = await db.query<{ data: unknown }>("SELECT data FROM opensam_projects WHERE id = $1", [projectId]);
      return rows[0] ? PostgresProjectRepository.parseProject(projectId, rows[0].data) : null;
    });
  }

  async update(projectId: string, mutator: (project: Project) => Project | void): Promise<Project> {
    if (!ID_PATTERNS.project.test(projectId)) throw new AppError("NOT_FOUND", { message: "This project no longer exists." });
    return this.transaction(async (db) => {
      const { rows } = await db.query<{ data: unknown }>("SELECT data FROM opensam_projects WHERE id = $1 FOR UPDATE", [projectId]);
      const current = rows[0] ? PostgresProjectRepository.parseProject(projectId, rows[0].data) : null;
      if (!current) throw new AppError("NOT_FOUND", { message: "This project no longer exists." });
      const draft = structuredClone(current);
      const next = mutator(draft) ?? draft;
      next.updatedAt = new Date().toISOString();
      const valid = ProjectSchema.parse(next);
      await db.query("UPDATE opensam_projects SET name = $2, is_demo = $3, data = $4::jsonb, updated_at = $5 WHERE id = $1", [
        projectId,
        valid.name,
        valid.isDemo,
        JSON.stringify(valid),
        valid.updatedAt,
      ]);
      return valid;
    });
  }

  async list(): Promise<ProjectListItem[]> {
    return this.run(async (db) => {
      const { rows } = await db.query<{
        id: string;
        name: string;
        is_demo: boolean;
        created_at: Date;
        updated_at: Date;
        duration: number | null;
        width: number | null;
        height: number | null;
        has_poster: boolean | null;
        track_count: number;
      }>(`
        SELECT p.id, p.name, p.is_demo, p.created_at, p.updated_at,
               (p.data->'video'->>'duration')::float8 AS duration,
               (p.data->'video'->>'width')::int AS width,
               (p.data->'video'->>'height')::int AS height,
               (p.data->'media'->>'poster')::boolean AS has_poster,
               (SELECT count(*)::int FROM opensam_tracks t WHERE t.project_id = p.id) AS track_count
          FROM opensam_projects p
         ORDER BY p.updated_at DESC
         LIMIT 1000`);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        isDemo: r.is_demo,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        duration: r.duration ?? 0,
        width: r.width ?? 0,
        height: r.height ?? 0,
        trackCount: r.track_count,
        hasPoster: r.has_poster ?? false,
      }));
    });
  }

  async delete(projectId: string): Promise<void> {
    if (!ID_PATTERNS.project.test(projectId)) return;
    await this.run((db) => db.query("DELETE FROM opensam_projects WHERE id = $1", [projectId])); // tracks cascade
    await removeProjectFiles(projectId);
  }

  // --- tracks --------------------------------------------------------------------------
  async listTracks(projectId: string): Promise<TrackSummary[]> {
    if (!ID_PATTERNS.project.test(projectId)) return [];
    return this.run(async (db) => {
      const { rows } = await db.query<{ meta: Omit<Track, "frames">; masked_frames: number; coverage: Array<[number, number]> }>(
        "SELECT meta, masked_frames, coverage FROM opensam_tracks WHERE project_id = $1 ORDER BY created_at, id",
        [projectId],
      );
      return rows.flatMap((r) => {
        const parsed = TrackSchema.safeParse({ ...r.meta, frames: {} });
        if (!parsed.success) return [];
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- summaries carry no mask data
        const { frames, ...meta } = parsed.data;
        return [{ ...meta, maskedFrames: r.masked_frames, coverage: r.coverage }];
      });
    });
  }

  async getTrack(projectId: string, trackId: string): Promise<Track | null> {
    if (!ID_PATTERNS.project.test(projectId) || !ID_PATTERNS.track.test(trackId)) return null;
    return this.run(async (db) => {
      const { rows } = await db.query<{ meta: Omit<Track, "frames">; frames: Track["frames"] }>(
        "SELECT meta, frames FROM opensam_tracks WHERE project_id = $1 AND id = $2",
        [projectId, trackId],
      );
      if (!rows[0]) return null;
      const parsed = TrackSchema.safeParse({ ...rows[0].meta, frames: rows[0].frames });
      return parsed.success ? parsed.data : null;
    });
  }

  async saveTrack(projectId: string, track: Track): Promise<Track> {
    const valid = TrackSchema.parse(track);
    const summary = summarizeTrack(valid);
    const { frames, ...meta } = valid; // frames go in their own column
    await this.run(async (db) => {
      try {
        await db.query(
          `INSERT INTO opensam_tracks (project_id, id, meta, frames, masked_frames, coverage, created_at, updated_at)
           VALUES ($1, $2, $3::jsonb, $4::json, $5, $6::jsonb, $7, now())
           ON CONFLICT (project_id, id) DO UPDATE
             SET meta = EXCLUDED.meta, frames = EXCLUDED.frames, masked_frames = EXCLUDED.masked_frames,
                 coverage = EXCLUDED.coverage, updated_at = now()`,
          [projectId, valid.id, JSON.stringify(meta), JSON.stringify(frames), summary.maskedFrames, JSON.stringify(summary.coverage), valid.createdAt || new Date().toISOString()],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23503") throw new AppError("NOT_FOUND", { message: "This project no longer exists." });
        throw err;
      }
    });
    return valid;
  }

  async deleteTrack(projectId: string, trackId: string): Promise<void> {
    await this.run((db) => db.query("DELETE FROM opensam_tracks WHERE project_id = $1 AND id = $2", [projectId, trackId]));
  }
}
