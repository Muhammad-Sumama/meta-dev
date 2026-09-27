/**
 * Schema migrations for PostgresProjectRepository, applied in order on first
 * use (each in its own transaction, recorded in opensam_migrations). Never
 * edit an applied migration; add a new one.
 */
export const MIGRATIONS: ReadonlyArray<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: "projects and tracks",
    sql: `
      CREATE TABLE opensam_projects (
        id          text PRIMARY KEY,
        name        text NOT NULL,
        is_demo     boolean NOT NULL DEFAULT false,
        data        jsonb NOT NULL,
        created_at  timestamptz NOT NULL,
        updated_at  timestamptz NOT NULL
      );
      CREATE INDEX opensam_projects_updated_at_idx ON opensam_projects (updated_at DESC);

      CREATE TABLE opensam_tracks (
        project_id    text NOT NULL REFERENCES opensam_projects (id) ON DELETE CASCADE,
        id            text NOT NULL,
        meta          jsonb NOT NULL,
        frames        json NOT NULL,
        masked_frames integer NOT NULL,
        coverage      jsonb NOT NULL,
        created_at    timestamptz NOT NULL,
        updated_at    timestamptz NOT NULL,
        PRIMARY KEY (project_id, id)
      );
    `,
  },
];
