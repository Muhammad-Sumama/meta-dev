import { spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort } from "./redis";

/**
 * Throwaway PostgreSQL clusters for integration tests (initdb + pg_ctl from a
 * local PostgreSQL install). Tests using it are skipped when none is found.
 * As root, the cluster runs as the `postgres` system user (initdb refuses root).
 */

function findBinDir(): string | null {
  const fromPgConfig = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  const candidates = [
    process.env.PG_BIN_DIR,
    fromPgConfig.status === 0 ? fromPgConfig.stdout.trim() : undefined,
    ...(existsSync("/usr/lib/postgresql")
      ? readdirSync("/usr/lib/postgresql")
          .sort((a, b) => Number(b) - Number(a))
          .map((v) => `/usr/lib/postgresql/${v}/bin`)
      : []),
  ];
  return candidates.find((d) => d && existsSync(path.join(d, "initdb")) && existsSync(path.join(d, "pg_ctl"))) ?? null;
}

const BIN = findBinDir();
const isRoot = process.getuid?.() === 0;
const pgUser = isRoot ? spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }) : null;
const canRun = BIN !== null && (!isRoot || (pgUser?.status === 0 && spawnSync("runuser", ["--help"]).status === 0));

export const postgresAvailable = canRun;

function run(cmd: string, args: string[]) {
  const full = isRoot ? ["runuser", ["-u", "postgres", "--", cmd, ...args]] : [cmd, args];
  const out = spawnSync(full[0] as string, full[1] as string[], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${cmd} failed: ${out.stderr || out.stdout}`);
}

export async function startPostgres(): Promise<{ url: string; stop(): Promise<void> }> {
  if (!BIN) throw new Error("PostgreSQL binaries not found");
  const dir = mkdtempSync(path.join(os.tmpdir(), "opensam-pg-"));
  if (isRoot) {
    const uid = Number(pgUser!.stdout.trim());
    const gid = Number(spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim());
    chownSync(dir, uid, gid);
  }
  const data = path.join(dir, "data");
  const port = await freePort();
  run(path.join(BIN, "initdb"), ["-D", data, "-A", "trust", "-U", "opensam", "--no-sync"]);
  run(path.join(BIN, "pg_ctl"), ["-D", data, "-l", path.join(dir, "log"), "-w", "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, "start"]);
  return {
    url: `postgres://opensam@127.0.0.1:${port}/postgres`,
    async stop() {
      try {
        run(path.join(BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
