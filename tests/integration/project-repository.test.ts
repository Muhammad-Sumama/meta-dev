/**
 * One contract, both project stores: JSON files and PostgreSQL (the latter
 * against a throwaway cluster; skipped if PostgreSQL isn't installed).
 * "Two processes" are simulated with two repository instances.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeMask } from "@/lib/mask/rle";
import { DEFAULT_COMPOSITE, type Project, type Track } from "@/lib/schemas/project";
import { setConfigForTesting } from "@/lib/server/config";
import { newId } from "@/lib/utils/ids";
import { FileSystemProjectRepository } from "@/services/projects/FileSystemProjectRepository";
import { importProjects } from "@/services/projects/importProjects";
import { PostgresProjectRepository } from "@/services/projects/postgres/PostgresProjectRepository";
import type { ProjectRepository } from "@/services/projects/ProjectRepository";
import { projectDir } from "@/services/storage/paths";
import { postgresAvailable, startPostgres } from "../helpers/postgres";

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newId("prj"),
    name: "Street scene",
    isDemo: false,
    createdAt: now,
    updatedAt: now,
    video: { originalName: "a.mp4", fileName: "source.mp4", sizeBytes: 1000, mimeType: "video/mp4", container: "mp4", codec: "h264", width: 960, height: 540, rotation: 0, fps: 30, frameCount: 300, duration: 10, hasAudio: false, browserPlayable: true },
    media: { proxy: { status: "not_needed" }, vp9Proxy: { status: "none" }, poster: true, filmstrip: { status: "ready", count: 20, tileWidth: 96, tileHeight: 54 } },
    analysis: { width: 16, height: 8 },
    composite: DEFAULT_COMPOSITE,
    commands: [],
    jobIds: [],
    ...overrides,
  };
}

function track(frames: number[], extra: Partial<Track> = {}): Track {
  const full = encodeMask(new Uint8Array(128).fill(1));
  const empty = encodeMask(new Uint8Array(128));
  return {
    id: newId("trk"),
    name: "Red car",
    color: "#c6f432",
    visible: true,
    source: "ai",
    provider: "mock",
    width: 16,
    height: 8,
    prompts: [{ frameIndex: frames[0] ?? 0, points: [] }],
    frames: { ...Object.fromEntries(frames.map((f) => [String(f), full])), "299": empty },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

type Backend = { name: string; available: boolean; setup(): Promise<{ make(): ProjectRepository; teardown(): Promise<void> }> };

const BACKENDS: Backend[] = [
  {
    name: "file",
    available: true,
    async setup() {
      return { make: () => new FileSystemProjectRepository(), teardown: async () => {} };
    },
  },
  {
    name: "postgres",
    available: postgresAvailable,
    async setup() {
      const pg = await startPostgres();
      const made: PostgresProjectRepository[] = [];
      return {
        make: () => {
          const r = new PostgresProjectRepository(pg.url, { poolSize: 4 });
          made.push(r);
          return r;
        },
        teardown: async () => {
          await Promise.all(made.map((r) => r.close()));
          await pg.stop();
        },
      };
    },
  },
];

let dataDir: string;
beforeAll(() => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "opensam-repo-"));
  setConfigForTesting({ DATA_DIR: dataDir });
});
afterAll(() => {
  setConfigForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
});

describe.each(BACKENDS)("ProjectRepository contract: $name", (backend) => {
  let env: Awaited<ReturnType<Backend["setup"]>>;
  let repo: ProjectRepository;

  beforeAll(async () => {
    if (!backend.available) return;
    env = await backend.setup();
    repo = env.make();
  }, 60_000);
  afterAll(async () => {
    await env?.teardown();
  });

  it.skipIf(!backend.available)("creates, reads and lists projects (newest first) with their media folders", async () => {
    const a = await repo.create(project({ name: "First" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.create(project({ name: "Second", isDemo: true }));
    expect(await repo.get(a.id)).toEqual(a);
    expect(existsSync(path.join(projectDir(a.id), "media"))).toBe(true);
    const list = await repo.list();
    const ids = list.map((p) => p.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(list.find((p) => p.id === b.id)).toEqual({
      id: b.id,
      name: "Second",
      isDemo: true,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      duration: 10,
      width: 960,
      height: 540,
      trackCount: 0,
      hasPoster: true,
    });
    expect(await repo.get("prj_doesnotexist")).toBeNull();
    expect(await repo.get("../../etc/passwd")).toBeNull();
  });

  it.skipIf(!backend.available)("updates atomically: validated, timestamped, and missing projects are NOT_FOUND", async () => {
    const p = await repo.create(project());
    const updated = await repo.update(p.id, (d) => {
      d.name = "Renamed";
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.updatedAt >= p.updatedAt).toBe(true);
    expect((await repo.get(p.id))?.name).toBe("Renamed");
    await expect(repo.update(p.id, (d) => ({ ...d, name: "" }))).rejects.toThrow();
    expect((await repo.get(p.id))?.name).toBe("Renamed"); // invalid update not persisted
    await expect(repo.update("prj_doesnotexist", () => {})).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.skipIf(!backend.available)("never loses concurrent updates from several processes", async () => {
    const p = await repo.create(project());
    const other = env.make(); // a second process
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 ? other : repo).update(p.id, (d) => {
          d.jobIds = [...d.jobIds, `job_${String(i).padStart(12, "0")}`];
        }),
      ),
    );
    expect((await repo.get(p.id))?.jobIds).toHaveLength(24);
  });

  it.skipIf(!backend.available)("stores tracks, summarizes them without masks, and deletes them", async () => {
    const p = await repo.create(project());
    const t1 = await repo.saveTrack(p.id, track([0, 1, 2, 5]));
    const t2 = await repo.saveTrack(p.id, track([10], { name: "Dog", createdAt: new Date(Date.now() + 1000).toISOString() }));
    expect(await repo.getTrack(p.id, t1.id)).toEqual(t1);

    const summaries = await repo.listTracks(p.id);
    expect(summaries.map((s) => s.id)).toEqual([t1.id, t2.id]);
    expect(summaries[0]).toMatchObject({ name: "Red car", maskedFrames: 4, coverage: [[0, 2], [5, 5]] });
    expect(summaries[0]).not.toHaveProperty("frames");
    expect((await repo.list()).find((x) => x.id === p.id)?.trackCount).toBe(2);

    // Overwrite (same id) replaces masks and summary.
    await repo.saveTrack(p.id, { ...t1, frames: { "7": t1.frames["0"] } });
    expect((await repo.listTracks(p.id))[0]).toMatchObject({ maskedFrames: 1, coverage: [[7, 7]] });

    await repo.deleteTrack(p.id, t2.id);
    expect(await repo.getTrack(p.id, t2.id)).toBeNull();
    await expect(repo.saveTrack("prj_doesnotexist", track([0]))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await repo.getTrack(p.id, "../x")).toBeNull();
  });

  it.skipIf(!backend.available)("deletes a project with its tracks and files", async () => {
    const p = await repo.create(project());
    const t = await repo.saveTrack(p.id, track([0]));
    await repo.delete(p.id);
    expect(await repo.get(p.id)).toBeNull();
    expect(await repo.getTrack(p.id, t.id)).toBeNull();
    expect(await repo.listTracks(p.id)).toEqual([]);
    expect(existsSync(projectDir(p.id))).toBe(false);
  });

  it.skipIf(!backend.available)("reports health", async () => {
    expect(await repo.health()).toMatchObject({ ok: true });
    expect(repo.backend).toBe(backend.name);
  });
});

describe.skipIf(!postgresAvailable)("PostgresProjectRepository specifics", () => {
  it("migrates once even when several processes start together", async () => {
    const pg = await startPostgres();
    const repos = Array.from({ length: 4 }, () => new PostgresProjectRepository(pg.url, { poolSize: 2 }));
    try {
      await Promise.all(repos.map((r) => r.list()));
      const p = await repos[0].create(project());
      expect(await repos[3].get(p.id)).toEqual(p);
    } finally {
      await Promise.all(repos.map((r) => r.close()));
      await pg.stop();
    }
  }, 60_000);

  it("imports projects and tracks from the file store (re-runnable)", async () => {
    const pg = await startPostgres();
    const target = new PostgresProjectRepository(pg.url, { poolSize: 2 });
    try {
      const files = new FileSystemProjectRepository();
      const p = await files.create(project({ name: "From files" }));
      const t = await files.saveTrack(p.id, track([3, 4]));
      const first = await importProjects(files, target);
      expect(first.imported).toContain(p.id);
      expect(first.failed).toEqual([]);
      expect(await target.get(p.id)).toEqual(p);
      expect(await target.getTrack(p.id, t.id)).toEqual(t);
      const again = await importProjects(files, target);
      expect(again.imported).toEqual([]);
      expect(again.skipped).toContain(p.id);
    } finally {
      await target.close();
      await pg.stop();
    }
  }, 60_000);

  it("maps an unreachable database to STORAGE_UNAVAILABLE", async () => {
    const repo = new PostgresProjectRepository("postgres://opensam@127.0.0.1:1/postgres", { poolSize: 1 });
    try {
      await expect(repo.list()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(await repo.health()).toMatchObject({ ok: false });
    } finally {
      await repo.close();
    }
  });
});
