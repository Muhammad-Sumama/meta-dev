import "server-only";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { AppError } from "@/lib/errors";
import type { ObjectInfo, ObjectStore } from "../objectStore";

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}

const isNotFound = (err: unknown) =>
  err instanceof S3ServiceException && (err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404);

/** Connection problems and server errors become STORAGE_UNAVAILABLE; details go to the log. */
function storageError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err;
  return new AppError("STORAGE_UNAVAILABLE", { message: "We couldn't reach file storage.", cause: new Error(`${what}: ${(err as Error).message}`) });
}

/** Media on S3 or an S3-compatible service (MinIO, Cloudflare R2, …). Large files upload in parts. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3Options) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix ? `${opts.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
    this.client = new S3Client({
      region: opts.region,
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle,
      credentials: opts.accessKeyId && opts.secretAccessKey ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
      maxAttempts: 3,
    });
  }

  private key(key: string) {
    return this.prefix + key;
  }

  async putFile(key: string, file: string, contentType?: string) {
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: this.key(key), Body: createReadStream(file), ContentType: contentType },
        partSize: 16 * 1024 * 1024,
        queueSize: 4,
      }).done();
    } catch (err) {
      throw storageError(err, `put ${key}`);
    }
  }

  async getToFile(key: string, file: string): Promise<boolean> {
    let body: Readable;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      body = res.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw storageError(err, `get ${key}`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString("hex")}.part`;
    try {
      await pipeline(body, createWriteStream(tmp));
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw storageError(err, `download ${key}`);
    }
    return true;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return { size: res.ContentLength ?? 0, etag: res.ETag ?? `"${key}"`, lastModified: res.LastModified ?? new Date(0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw storageError(err, `head ${key}`);
    }
  }

  async read(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key), Range: range ? `bytes=${range.start}-${range.end}` : undefined }),
      );
      return Readable.toWeb(res.Body as Readable) as ReadableStream<Uint8Array>;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw storageError(err, `read ${key}`);
    }
  }

  async deletePrefix(prefix: string) {
    try {
      let token: string | undefined;
      do {
        const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.key(prefix), ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
        if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (err) {
      throw storageError(err, `delete ${prefix}`);
    }
  }

  async health() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, message: `S3 bucket ${this.bucket}` };
    } catch (err) {
      return { ok: false, message: `S3 bucket ${this.bucket} is unreachable: ${(err as Error).name}` };
    }
  }

  destroy() {
    this.client.destroy();
  }
}
