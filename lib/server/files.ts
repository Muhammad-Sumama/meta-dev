import "server-only";
import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { AppError } from "@/lib/errors";

/**
 * Streams a file with HTTP Range support so the browser's <video> element can
 * seek without downloading the whole file.
 */
export async function serveFile(
  request: Request,
  filePath: string,
  opts: { contentType: string; downloadName?: string; cacheSeconds?: number },
): Promise<Response> {
  let size: number;
  let mtime: Date;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
    mtime = st.mtime;
  } catch {
    throw new AppError("NOT_FOUND", { message: "That file isn't available (it may still be processing)." });
  }

  const etag = `"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": opts.contentType,
    "accept-ranges": "bytes",
    etag,
    "last-modified": mtime.toUTCString(),
    "cache-control": opts.cacheSeconds ? `private, max-age=${opts.cacheSeconds}` : "private, no-cache",
    "x-content-type-options": "nosniff",
  };
  if (opts.downloadName) {
    const ascii = opts.downloadName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    headers["content-disposition"] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`;
  }

  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === "" && m[2] === "")) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    let start: number;
    let end: number;
    if (m[1] === "") {
      const suffix = Number(m[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }

  if (request.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(size) } });
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(stream, { status: 200, headers: { ...headers, "content-length": String(size) } });
}
