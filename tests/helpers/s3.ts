import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { freePort } from "./redis";

/**
 * A throwaway S3-compatible server for tests: moto (`pip install "moto[server]"`,
 * e.g. into inference/.venv). Tests using it are skipped when it isn't installed.
 */
const MOTO = [process.env.MOTO_SERVER, path.join(process.cwd(), "inference", ".venv", "bin", "moto_server")].find((p) => p && existsSync(p))
  ?? (spawnSync("moto_server", ["--help"]).status === 0 ? "moto_server" : null);

export const s3Available = MOTO !== null;

export const S3_TEST_CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };

export async function startS3(bucket = "opensam-test") {
  const port = await freePort();
  const proc = spawn(MOTO!, ["-H", "127.0.0.1", "-p", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout!.on("data", (c: Buffer) => (log += c.toString()));
  proc.stderr!.on("data", (c: Buffer) => (log += c.toString()));
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`moto_server exited:\n${log}`);
    try {
      if ((await fetch(`${endpoint}/moto-api/`)).status < 500) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`moto_server didn't start:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const client = new S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: S3_TEST_CREDENTIALS });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return {
    endpoint,
    bucket,
    client,
    /** Env/config for the app. */
    config: {
      MEDIA_STORE: "s3" as const,
      S3_BUCKET: bucket,
      S3_REGION: "us-east-1",
      S3_ENDPOINT: endpoint,
      S3_FORCE_PATH_STYLE: true,
      S3_ACCESS_KEY_ID: S3_TEST_CREDENTIALS.accessKeyId,
      S3_SECRET_ACCESS_KEY: S3_TEST_CREDENTIALS.secretAccessKey,
    },
    async stop() {
      client.destroy();
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        await new Promise((r) => proc.once("exit", r));
      }
    },
  };
}
