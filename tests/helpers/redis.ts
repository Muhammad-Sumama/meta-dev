import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

/** Integration tests that need Redis are skipped when redis-server isn't installed. */
export const redisAvailable = spawnSync("redis-server", ["--version"]).status === 0;

export async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as net.AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

/** A throwaway, non-persistent redis-server on a free port. */
export async function startRedis(): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const proc = spawn("redis-server", ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`redis-server didn't start:\n${out}`)), 10_000);
    proc.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("Ready to accept connections")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`redis-server exited with ${code}:\n${out}`));
    });
  });
  return {
    url: `redis://127.0.0.1:${port}`,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      await once(proc, "exit");
    },
  };
}
