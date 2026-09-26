import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AppError } from "@/lib/errors";
import { coverageRanges, isEmptyMask } from "@/lib/mask/rle";
import {
  ID_PATTERNS,
  ProjectSchema,
  TrackSchema,
  type Project,
  type ProjectListItem,
  type Track,
  type TrackSummary,
} from "@/lib/schemas/project";
import { projectDir, projectPath, projectsDir, trackPath } from "../storage/paths";
import { ensureDir, KeyedMutex, readJson, writeJsonAtomic } from "../storage/fs";
import type { ProjectRepository } from "./ProjectRepository";

export function summarizeTrack(track: Track): TrackSummary {
  const { frames, ...rest } = track;
  let masked = 0;
  for (const k in frames) if (!isEmptyMask(frames[k])) masked++;
  return { ...rest, maskedFrames: masked, coverage: coverageRanges(frames) };
}

export class FileSystemProjectRepository implements ProjectRepository {
  private mutex = new KeyedMutex();

  private projectFile(id: string) {
    return projectPath(id, "project.json");
  }

  async create(project: Project): Promise<Project> {
    const valid = ProjectSchema.parse(project);
    await ensureDir(projectDir(valid.id));
    await Promise.all(
      ["media", "tracks", "exports", "cache"].map((d) => ensureDir(path.join(/*turbopackIgnore: true*/ projectDir(valid.id), d))),
    );
    await writeJsonAtomic(this.projectFile(valid.id), valid);
    return valid;
  }

  async get(projectId: string): Promise<Project | null> {
    if (!ID_PATTERNS.project.test(projectId)) return null;
    const raw = await readJson<unknown>(this.projectFile(projectId));
    if (!raw) return null;
    const parsed = ProjectSchema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[projects] ${projectId}/project.json failed validation`, parsed.error.issues.slice(0, 3));
      return null;
    }
    return parsed.data;
  }

  async update(projectId: string, mutator: (project: Project) => Project | void): Promise<Project> {
    return this.mutex.run(projectId, async () => {
      const current = await this.get(projectId);
      if (!current) throw new AppError("NOT_FOUND", { message: "This project no longer exists." });
      const draft = structuredClone(current);
      const next = mutator(draft) ?? draft;
      next.updatedAt = new Date().toISOString();
      const valid = ProjectSchema.parse(next);
      await writeJsonAtomic(this.projectFile(projectId), valid);
      return valid;
    });
  }

  async list(): Promise<ProjectListItem[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(projectsDir());
    } catch {
      return [];
    }
    const items = await Promise.all(
      entries
        .filter((e) => ID_PATTERNS.project.test(e))
        .map(async (id): Promise<ProjectListItem | null> => {
          const p = await this.get(id);
          if (!p) return null;
          let trackCount = 0;
          try {
            trackCount = (await fs.readdir(projectPath(id, "tracks"))).filter((f) => f.endsWith(".json")).length;
          } catch {
            /* no tracks dir */
          }
          return {
            id: p.id,
            name: p.name,
            isDemo: p.isDemo,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            duration: p.video.duration,
            width: p.video.width,
            height: p.video.height,
            trackCount,
            hasPoster: p.media.poster,
          };
        }),
    );
    return items
      .filter((x): x is ProjectListItem => x !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(projectId: string): Promise<void> {
    await this.mutex.run(projectId, async () => {
      await fs.rm(projectDir(projectId), { recursive: true, force: true });
    });
  }

  async listTracks(projectId: string): Promise<TrackSummary[]> {
    let files: string[] = [];
    try {
      files = await fs.readdir(projectPath(projectId, "tracks"));
    } catch {
      return [];
    }
    const tracks = await Promise.all(
      files
        .filter((f) => f.endsWith(".json") && ID_PATTERNS.track.test(f.slice(0, -5)))
        .map((f) => this.getTrack(projectId, f.slice(0, -5))),
    );
    return tracks
      .filter((t): t is Track => t !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(summarizeTrack);
  }

  async getTrack(projectId: string, trackId: string): Promise<Track | null> {
    if (!ID_PATTERNS.track.test(trackId)) return null;
    const raw = await readJson<unknown>(trackPath(projectId, trackId));
    if (!raw) return null;
    const parsed = TrackSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async saveTrack(projectId: string, track: Track): Promise<Track> {
    const valid = TrackSchema.parse(track);
    await this.mutex.run(`${projectId}:${valid.id}`, () => writeJsonAtomic(trackPath(projectId, valid.id), valid));
    return valid;
  }

  async deleteTrack(projectId: string, trackId: string): Promise<void> {
    await this.mutex.run(`${projectId}:${trackId}`, async () => {
      await fs.rm(trackPath(projectId, trackId), { force: true });
    });
  }
}
