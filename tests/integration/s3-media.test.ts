/**
 * MEDIA_STORE=s3 against an S3-compatible server (moto): the object store,
 * the project-file layer (publish / ensureLocal / serving with Range from the
 * bucket) and cache trimming. The multi-machine pipeline (separate disks for
 * web and worker) is in worker-process.test.ts.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setConfigForTesting } from "@/lib/server/config";
import { newId } from "@/lib/utils/ids";
import { getObjectStore, resetObjectStoreForTesting } from "@/services/storage/objectStore";
import { ensureLocal, localProjectFile, publish, readProjectJson, removePublishedFiles, serveProjectFile, trimCache, writeProjectJson } from "@/services/storage/projectMedia";
import { S3ObjectStore } from "@/services/storage/s3/S3ObjectStore";
import { s3Available, startS3 } from "../helpers/s3";

describe.skipIf(!s3Available)("MEDIA_STORE=s3", () => {
  let s3: Awaited<ReturnType<typeof startS3>>;
  let dataDir: string;
  const projectId = newId("prj");
  const payload = randomBytes(40 * 1024 * 1024 + 123); // > 2 upload parts

  beforeAll(async () => {
    s3 = await startS3();
    dataDir = mkdtempSync(path.join(os.tmpdir(), "opensam-s3-"));
    setConfigForTesting({ DATA_DIR: dataDir, ...s3.config });
    resetObjectStoreForTesting();
  }, 60_000);

  afterAll(async () => {
    setConfigForTesting(null);
    resetObjectStoreForTesting();
    await s3?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const writeLocal = (rel: string, data: Buffer | string) => {
    const file = localProjectFile(projectId, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };

  it("publishes large files in parts and reads them back, whole or by range", async () => {
    const file = writeLocal("media/source.mp4", payload);
    await publish(projectId, "media/source.mp4", "video/mp4");
    const store = getObjectStore()!;
    expect(await store.head(`projects/${projectId}/media/source.mp4`)).toMatchObject({ size: payload.length });

    rmSync(file); // as if on another machine
    const [a, b] = await Promise.all([ensureLocal(projectId, "media/source.mp4"), ensureLocal(projectId, "media/source.mp4")]);
    expect(a).toBe(file);
    expect(b).toBe(file);
    expect(readFileSync(file).equals(payload)).toBe(true);
    await expect(ensureLocal(projectId, "media/nope.mp4")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(ensureLocal(projectId, "media/../../x")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  }, 60_000);

  it("serves from the bucket with Range support when this machine has no copy", async () => {
    rmSync(localProjectFile(projectId, "media/source.mp4"), { force: true });
    const get = (headers: Record<string, string> = {}, method = "GET") =>
      serveProjectFile(new Request("http://localhost/x", { headers, method }), projectId, "media/source.mp4", { contentType: "video/mp4" });

    const partial = await get({ range: "bytes=1000-1999" });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 1000-1999/${payload.length}`);
    expect(Buffer.from(await partial.arrayBuffer()).equals(payload.subarray(1000, 2000))).toBe(true);

    const suffix = await get({ range: "bytes=-10" });
    expect(Buffer.from(await suffix.arrayBuffer()).equals(payload.subarray(payload.length - 10))).toBe(true);

    expect((await get({ range: `bytes=${payload.length + 5}-` })).status).toBe(416);
    const head = await get({}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(payload.length));
    const etag = head.headers.get("etag")!;
    expect((await get({ "if-none-match": etag })).status).toBe(304);
    expect(existsSync(localProjectFile(projectId, "media/source.mp4"))).toBe(false); // streamed, not cached

    await expect(serveProjectFile(new Request("http://localhost/x"), projectId, "media/missing.jpg", { contentType: "image/jpeg" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores JSON documents so another machine can read them", async () => {
    await writeProjectJson(projectId, "exports/exp_aaaaaaaaaaaa.result.json", { fileName: "exp_aaaaaaaaaaaa.webm" });
    rmSync(localProjectFile(projectId, "exports/exp_aaaaaaaaaaaa.result.json"));
    expect(await readProjectJson(projectId, "exports/exp_aaaaaaaaaaaa.result.json")).toEqual({ fileName: "exp_aaaaaaaaaaaa.webm" });
    expect(await readProjectJson(projectId, "exports/exp_bbbbbbbbbbbb.result.json")).toBeNull();
  });

  it("keeps the local cache under its size limit, evicting least recently used files first", async () => {
    setConfigForTesting({ MEDIA_CACHE_MAX_MB: 256 });
    const old = Date.now() / 1000 - 7200;
    const big = Buffer.alloc(100 * 1024 * 1024);
    const files = ["media/a.mp4", "media/b.mp4", "media/c.mp4"].map((rel) => writeLocal(rel, big));
    utimesSync(files[0], old - 100, old - 100); // least recently used
    utimesSync(files[1], old, old);
    // files[2] was just used
    await trimCache();
    expect(existsSync(files[0])).toBe(false);
    expect(existsSync(files[1])).toBe(true);
    expect(existsSync(files[2])).toBe(true);
    expect(statSync(files[1]).size).toBe(big.length);
    for (const f of files) rmSync(f, { force: true });
  });

  it("deletes every file of a project from the bucket", async () => {
    await removePublishedFiles(projectId);
    const listed = await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: `projects/${projectId}/` }));
    expect(listed.KeyCount ?? 0).toBe(0);
  });

  it("reports an unreachable store as STORAGE_UNAVAILABLE", async () => {
    const dead = new S3ObjectStore({ bucket: "b", region: "us-east-1", endpoint: "http://127.0.0.1:1", forcePathStyle: true, accessKeyId: "x", secretAccessKey: "y" });
    const file = writeLocal("media/tiny.bin", "x");
    await expect(dead.putFile("k", file)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await expect(dead.head("k")).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await dead.health()).toMatchObject({ ok: false });
    dead.destroy();
  }, 60_000);
});
