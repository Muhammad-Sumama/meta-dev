import { AppError } from "@/lib/errors";
import { route } from "@/lib/server/api";
import { serveFile } from "@/lib/server/files";
import { requireProject } from "@/services/projects";
import { mediaPath } from "@/services/storage/paths";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ projectId: string; asset: string }> };

/**
 * Streams project media with Range support.
 *   preview   → proxy if one exists, else the source (what the <video> element plays);
 *               `?codec=vp9` serves the WebM preview for browsers without H.264
 *   source    → original upload
 *   poster    → first-frame JPEG
 *   filmstrip → timeline thumbnail sprite
 */
async function handle(request: Request, { params }: Ctx) {
  const { projectId, asset } = await params;
  const project = await requireProject(projectId);
  switch (asset) {
    case "preview":
      if (new URL(request.url).searchParams.get("codec") === "vp9") {
        if (project.media.vp9Proxy.status !== "ready" || !project.media.vp9Proxy.fileName) {
          throw new AppError("CONFLICT", { message: "The browser preview is still being prepared." });
        }
        return serveFile(request, mediaPath(projectId, project.media.vp9Proxy.fileName), { contentType: "video/webm" });
      }
      if (project.media.proxy.status === "ready" && project.media.proxy.fileName) {
        return serveFile(request, mediaPath(projectId, project.media.proxy.fileName), { contentType: "video/mp4" });
      }
      if (!project.video.browserPlayable) {
        throw new AppError("CONFLICT", { message: "The preview is still being prepared." });
      }
      return serveFile(request, mediaPath(projectId, project.video.fileName), { contentType: project.video.mimeType });
    case "source":
      return serveFile(request, mediaPath(projectId, project.video.fileName), {
        contentType: project.video.mimeType,
        downloadName: project.video.originalName,
      });
    case "poster":
      return serveFile(request, mediaPath(projectId, "poster.jpg"), { contentType: "image/jpeg", cacheSeconds: 3600 });
    case "filmstrip":
      return serveFile(request, mediaPath(projectId, "filmstrip.jpg"), { contentType: "image/jpeg", cacheSeconds: 3600 });
    default:
      throw new AppError("NOT_FOUND");
  }
}

export const GET = route(handle);
export const HEAD = route(handle);
