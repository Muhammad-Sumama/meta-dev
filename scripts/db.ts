/**
 * PostgreSQL maintenance for PROJECT_STORE=postgres (reads DATABASE_URL from
 * the environment / .env files, like the app).
 *
 *   npm run db:migrate        create or upgrade the schema (the app also does this on first use)
 *   npm run db:import-files   copy projects from JSON files in DATA_DIR into PostgreSQL (re-runnable)
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

async function main() {
  const command = process.argv[2];
  const { getConfig } = await import("@/lib/server/config");
  const { PostgresProjectRepository } = await import("@/services/projects/postgres/PostgresProjectRepository");
  const config = getConfig();
  if (!config.DATABASE_URL) throw new Error("Set DATABASE_URL (postgres://…) first.");
  const db = new PostgresProjectRepository(config.DATABASE_URL, { poolSize: 2 });
  try {
    if (command === "migrate") {
      const health = await db.health(); // runs pending migrations
      if (!health.ok) throw new Error(health.message);
      console.log("Schema is up to date.");
    } else if (command === "import-files") {
      const { FileSystemProjectRepository } = await import("@/services/projects/FileSystemProjectRepository");
      const { importProjects } = await import("@/services/projects/importProjects");
      const report = await importProjects(new FileSystemProjectRepository(), db, (line) => console.log(line));
      console.log(`Imported ${report.imported.length} project(s) with ${report.tracks} track(s); ${report.skipped.length} already present; ${report.failed.length} failed.`);
      if (report.failed.length) process.exitCode = 1;
    } else {
      console.error("Usage: npm run db:migrate | npm run db:import-files");
      process.exitCode = 2;
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
