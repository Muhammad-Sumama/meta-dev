import "server-only";
import { getConfig } from "@/lib/server/config";
import { S3ObjectStore } from "./s3/S3ObjectStore";

/**
 * Durable storage for project media and exports.
 *
 * With MEDIA_STORE=local (default) DATA_DIR *is* the store and nothing here
 * is used. With MEDIA_STORE=s3 every produced file is published to a bucket
 * and each machine's DATA_DIR is only a cache (see projectMedia.ts), so web
 * servers and workers don't need a shared disk.
 */
export interface ObjectInfo {
  size: number;
  etag: string;
  lastModified: Date;
}

export interface ObjectStore {
  putFile(key: string, file: string, contentType?: string): Promise<void>;
  /** Downloads to `file` (atomically). False if the object doesn't exist. */
  getToFile(key: string, file: string): Promise<boolean>;
  head(key: string): Promise<ObjectInfo | null>;
  read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null>;
  deletePrefix(prefix: string): Promise<void>;
  health(): Promise<{ ok: boolean; message: string }>;
}

const g = globalThis as unknown as { __opensamObjects?: ObjectStore | null };

/** The configured object store, or null with MEDIA_STORE=local. */
export function getObjectStore(): ObjectStore | null {
  const c = getConfig();
  if (c.MEDIA_STORE !== "s3") return null;
  if (!(g.__opensamObjects instanceof S3ObjectStore)) {
    g.__opensamObjects = new S3ObjectStore({
      bucket: c.S3_BUCKET!,
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      accessKeyId: c.S3_ACCESS_KEY_ID,
      secretAccessKey: c.S3_SECRET_ACCESS_KEY,
      prefix: c.S3_PREFIX,
    });
  }
  return g.__opensamObjects;
}

/** For tests: forget the cached client (config changed). */
export function resetObjectStoreForTesting() {
  g.__opensamObjects = undefined;
}
