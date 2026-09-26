"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Film, Layers, Trash } from "lucide-react";
import { toast } from "sonner";
import { api, errorText } from "@/lib/client/api";
import type { ProjectListItem } from "@/lib/schemas/project";
import { formatDuration, relativeTime } from "@/lib/utils/format";
import { useSystem } from "@/stores/system";
import { Logo } from "@/components/brand/Logo";
import { DemoButton } from "@/components/landing/DemoButton";
import { Button } from "@/components/ui/button";
import { Badge, Spinner } from "@/components/ui/misc";
import { UploadDropzone } from "@/components/video/UploadDropzone";

export function StartScreen() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const health = useSystem((s) => s.health);

  useEffect(() => {
    void useSystem.getState().refresh();
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err) => setError(errorText(err).title));
  }, []);

  const remove = async (p: ProjectListItem) => {
    if (!window.confirm(`Delete “${p.name}”? Its video, masks and exports will be removed.`)) return;
    try {
      await api.deleteProject(p.id);
      setProjects((list) => list?.filter((x) => x.id !== p.id) ?? null);
      toast.success("Project deleted");
    } catch (err) {
      const { title, hint } = errorText(err);
      toast.error(title, { description: hint });
    }
  };

  return (
    <div className="min-h-dvh">
      <header className="flex h-14 items-center gap-3 border-b border-border px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <Logo className="size-7" />
          <span className="text-[15px] font-semibold tracking-tight">OpenSAM Studio</span>
        </Link>
        {health && (health.ai.segmentation.kind === "mock" || health.ai.language.kind === "mock") && (
          <Badge variant="warning" className="ml-2">
            Mock AI mode
          </Badge>
        )}
        {health && !health.ffmpeg.available && <Badge variant="danger">FFmpeg missing</Badge>}
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section aria-labelledby="new-title" className="flex flex-col gap-4">
          <div>
            <h1 id="new-title" className="text-xl font-semibold tracking-tight">
              New project
            </h1>
            <p className="mt-1 text-[13.5px] text-muted">Upload a clip to start rotoscoping. Nothing leaves this machine — videos are stored in the server&apos;s data folder.</p>
          </div>
          <UploadDropzone maxUploadMb={health?.config.maxUploadMb ?? 500} />
          <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-panel p-4 sm:flex-row sm:items-center">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/10">
              <Film className="size-5 text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">No footage handy?</p>
              <p className="text-[13px] text-muted">Open a 10-second street scene with a car, two people and a dog, and try the AI commands.</p>
            </div>
            <DemoButton variant="secondary">Open demo</DemoButton>
          </div>
        </section>

        <section aria-labelledby="recent-title" className="flex min-w-0 flex-col gap-3">
          <h2 id="recent-title" className="text-[13px] font-semibold uppercase tracking-[0.08em] text-faint">
            Recent projects
          </h2>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          {!projects && !error && (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <Spinner className="size-3.5" /> Loading…
            </p>
          )}
          {projects?.length === 0 && <p className="rounded-lg border border-dashed border-border p-6 text-center text-[13px] text-muted">Your projects will appear here.</p>}
          <ul className="flex flex-col gap-2">
            {projects?.map((p) => (
              <li key={p.id} className="group flex items-center gap-3 rounded-lg border border-border bg-panel p-2 transition-colors hover:border-border-strong">
                <Link href={`/editor/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-panel-3">
                    {p.hasPoster && (
                      // eslint-disable-next-line @next/next/no-img-element -- streamed from the local API
                      <img src={api.mediaUrl(p.id, "poster")} alt="" className="size-full object-cover" loading="lazy" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-[13.5px] font-medium">
                      {p.name} {p.isDemo && <Badge variant="info">Demo</Badge>}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                      {formatDuration(p.duration)} · {p.width}×{p.height}
                      <span className="flex items-center gap-1">
                        <Layers className="size-3" /> {p.trackCount}
                      </span>
                    </p>
                    <p className="text-[11.5px] text-faint">Edited {relativeTime(p.updatedAt)}</p>
                  </div>
                </Link>
                <Button variant="ghost" size="icon-xs" aria-label={`Delete ${p.name}`} className="opacity-60 group-hover:opacity-100" onClick={() => void remove(p)}>
                  <Trash />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
