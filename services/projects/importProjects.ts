import "server-only";
import type { ProjectRepository } from "./ProjectRepository";

export interface ImportReport {
  imported: string[];
  skipped: string[];
  tracks: number;
  failed: Array<{ id: string; error: string }>;
}

/**
 * Copies every project and track from one store to another (e.g. JSON files →
 * PostgreSQL when moving to PROJECT_STORE=postgres). Projects already in the
 * target are skipped, so it can be re-run. Media files aren't touched: both
 * stores keep them in DATA_DIR.
 */
export async function importProjects(from: ProjectRepository, to: ProjectRepository, log: (line: string) => void = () => {}): Promise<ImportReport> {
  const report: ImportReport = { imported: [], skipped: [], tracks: 0, failed: [] };
  for (const item of await from.list()) {
    try {
      if (await to.get(item.id)) {
        report.skipped.push(item.id);
        continue;
      }
      const project = await from.get(item.id);
      if (!project) continue;
      await to.create(project);
      for (const summary of await from.listTracks(item.id)) {
        const track = await from.getTrack(item.id, summary.id);
        if (!track) continue;
        await to.saveTrack(item.id, track);
        report.tracks++;
      }
      report.imported.push(item.id);
      log(`imported ${item.id} (${project.name})`);
    } catch (err) {
      report.failed.push({ id: item.id, error: (err as Error).message });
      log(`failed ${item.id}: ${(err as Error).message}`);
    }
  }
  return report;
}
