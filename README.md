# OpenSAM Studio

**Rotoscoping, powered by AI.** Upload a video, tell the AI what you want to
isolate, and OpenSAM Studio segments and tracks it for you — then exports a
matte, a transparent cutout, or a finished video.

> OpenSAM Studio is an independent creative tool built around open AI
> technologies, including SAM 2 and Llama. It is **not** affiliated with,
> endorsed by, or sponsored by Meta Platforms, Inc.

```
Video  →  natural language  →  object segmentation  →  tracking  →  mask  →  export
```

It runs end-to-end on a laptop with no GPU and no API keys (mock AI mode), and
switches to real SAM 2 / Llama inference by changing two environment variables.

---

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [Deploying with Docker Compose](#deploying-with-docker-compose)
- [Running with mock AI](#running-with-mock-ai) — **where the mock ends and real AI begins**
- [Connecting Llama](#connecting-llama)
- [Connecting SAM 2](#connecting-sam-2)
- [FFmpeg setup](#ffmpeg-setup)
- [GPU requirements](#gpu-requirements)
- [Production architecture](#production-architecture)
- [Testing](#testing)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Roadmap](#roadmap)

---

## Quick start

```bash
npm install
npm run dev
# open http://localhost:3000 and click “Try Demo”
```

`npm install` also downloads static FFmpeg/ffprobe binaries for your platform,
so there is nothing else to install. In the demo, try the suggestions:
**“Track the red car”**, **“Remove the man in the red shirt”**,
**“Blur the background behind the man in the blue shirt”**.

## Features

| Area | What you get |
| --- | --- |
| **Upload** | Drag-and-drop MP4 / MOV / WebM / MKV with real upload progress, streamed to disk (never buffered in memory), validated by magic bytes + ffprobe. Shows file name, duration, resolution, FPS and size. Browser-incompatible codecs (ProRes, HEVC-in-MOV…) get an automatic H.264 preview proxy; browsers without H.264 get a VP9 proxy. |
| **AI commands** | “Track the person in the blue shirt”, “Isolate the dog and make the background transparent”, “Blur the background behind the woman on the left for the first 5 seconds”… Parsed into a schema-validated command (`isolate`, `select`, `track`, `mask`, `remove_background`, `blur`, `highlight`, `replace_background`, `remove_object`, `export_mask`), compiled into a plan, and run as a background job with live stage/progress. The structured JSON is shown in the history. |
| **Selection** | Five methods: natural language, **click** (Alt-click / Subtract mode for negative points, Shift-click for a new object), **box**, **brush** and **eraser**. The segmentation backend receives frame + positive/negative points + box + mask + text. |
| **Tracking** | One-click “Track through video” (bidirectional), “Re-track from this frame” after corrections, per-object lanes on the timeline with live processing bars. |
| **Mask editing** | Brush / eraser with adjustable size, edits scoped explicitly to **this frame** or the **whole sequence**, add/subtract selection, feather, grow/shrink, overlay opacity, outline toggle. |
| **Effects (live preview = export)** | Mask only, remove background (transparent), blur background (halo-free), blur object, highlight, replace background (color / green screen), remove object (clean-plate fill). |
| **Timeline** | Ruler with adaptive timecodes, filmstrip thumbnails, playhead scrubbing, zoom, keyframe markers, selectable mask segments, AI processing state. |
| **Export** | Video (MP4 H.264, WebM VP9, **WebM VP9 with alpha**, **ProRes 4444 with alpha**), mask (matte MP4 / PNG zip), RGBA PNG sequence (zip), project JSON. Resolution, FPS, quality, audio, range. “Processing frame 134 / 420” progress, cancel, download. Honest warnings (e.g. MP4 can't hold transparency). |
| **Editor** | Professional dark UI, undo/redo for every edit (including AI results), keyboard shortcuts with tooltip hints, autosave, responsive down to phone width, accessible controls. |
| **Demo mode** | Bundled procedurally generated clip (a red car, two people, a dog) with ground-truth masks used by tests. |

### Keyboard shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| Space | Play / pause | V | Select |
| ← / → | Previous / next frame (Shift = 10) | T | Track |
| Home / End | First / last frame | M | Box |
| ⌘/Ctrl+Z | Undo | B | Brush |
| ⌘/Ctrl+Shift+Z | Redo | E | Eraser |
| [ / ] | Brush size | H | Hand (pan) |
| O | Show/hide masks | P | Effect preview |
| / | Ask AI | ⌘/Ctrl+E | Export |
| F | Fit to canvas | ? | Shortcut sheet |

## Architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│ Landing · Editor (React 19, zustand store with undo/redo)        │
│  VideoStage ── <video> (HTTP range streaming)                     │
│             ├─ MaskOverlay (RLE → canvas)                         │
│             ├─ EffectPreview (Canvas 2D, mirrors export)          │
│             └─ InteractionLayer (click / box / brush / eraser)    │
│  Timeline · AI panel · Objects · Output · Export/Settings dialogs │
└───────────────┬──────────────────────────────────────────────────┘
                │ JSON · streamed uploads · range requests · SSE
┌───────────────▼──────────── Next.js route handlers (app/api) ────┐
│ validation (zod) · rate limits · friendly errors                  │
│ ProjectService (use-cases)                                        │
│   ├─ ProjectRepository ── FileSystemProjectRepository (data/)     │
│   ├─ JobQueuePort ── queued → processing → completed|failed|…    │
│   │    ├─ JobQueue (in-process, default)                          │
│   │    ├─ RedisJobQueue (BullMQ) ──► `npm run worker` processes   │
│   │    └─ workers/: ingest · segmentation (“AI worker”) · export  │
│   ├─ LlamaService ── LanguageProvider                             │
│   │        ├─ LlamaProvider   (OpenAI-compatible HTTP)            │
│   │        └─ MockLanguageProvider (rule parser)                  │
│   ├─ SAM2Service ── SegmentationProvider                          │
│   │        ├─ SAM2Provider    (HTTP → inference/ FastAPI + GPU)   │
│   │        └─ MockSegmentationProvider (classical CV, CPU)        │
│   └─ ExportService ── compositor (lib/compositing) ── FFmpeg      │
└──────────────────────────────────────────────────────────────────┘
```

**Why this split.** SAM 2 is a PyTorch model that needs a GPU, so it lives in
a separate Python service (`inference/`) behind an HTTP contract. Everything
else — upload, jobs, compositing, export — is TypeScript in one Next.js app,
which keeps local setup to `npm install`. Long work (tracking, exports,
transcodes) runs as jobs so the UI never blocks; progress streams to the
browser as server-sent events (`/api/projects/:id/events`), with polling as a
fallback.
Jobs run inside the web server by default, or in separate worker processes on
other machines with `JOB_BACKEND=redis`.

### Project layout

```
app/                     Next.js App Router
  page.tsx               landing page
  editor/                project picker + editor route
  api/                   REST API (projects, media, segment, track, commands, exports, jobs, events (SSE), health)
components/
  editor/ video/ timeline/ ai/ export/ landing/ ui/ (shadcn-style primitives on Radix)
services/
  ai/                    AIProvider contracts, registry (mock ↔ production switch), mock/ (classical CV + rule parser)
  llama/                 LlamaService, LlamaProvider, prompt, rule parser, output normalization, plan compiler
  sam2/                  SAM2Service, SAM2Provider (HTTP client), detection targeting
  video/                 safe FFmpeg wrapper, ffprobe, frame streaming, ingest (poster/filmstrip/proxies), uploads
  export/                ExportService, format specs
  jobs/                  JobQueuePort: in-process JobQueue (+ file store), redis/RedisJobQueue (BullMQ), runtime
  projects/ storage/     repository (files | postgres/), import between stores; path safety, object store (s3/), project files
workers/                 job handlers: ingest, segmentation, export; main.ts = worker process
lib/
  schemas/               zod schemas: command, project, job, API requests
  compositing/           pure alpha/effect/clean-plate code shared by preview and export
  mask/                  RLE codec, brush/eraser stroke ops
  client/                browser API client, autosave, actions, video controller
stores/                  zustand editor state (document + history)
inference/               Python SAM 2 server (FastAPI) + contract tests
scripts/                 demo generator (+ ground truth), hero render, mock evaluation
tests/                   unit · components (jsdom) · integration (real FFmpeg) · e2e (Playwright)
public/demo/             bundled demo clip (MP4 + WebM) and landing-page output
```

### Data model

```
data/
├── projects/<prj_…>/
│   ├── project.json        metadata, video info, composite (effect), AI commands, export settings, job ids
│   ├── media/              source.<ext>, proxy.mp4, proxy-vp9.webm, poster.jpg, filmstrip.jpg
│   ├── tracks/<trk_…>.json one object: name, color, prompts, per-frame RLE masks
│   └── exports/<exp_…>.*   rendered files
└── jobs/<job_…>.json       job state and progress
```

Masks are stored as row-major run-length encodings at the project's analysis
resolution (≤ `ANALYSIS_MAX_SIZE`, aspect preserved) and upscaled with
bilinear filtering + feathering at export.

## Requirements

- **Node.js 20.9+** (tested on 22) and npm
- A modern browser (Chrome, Edge, Firefox, Safari 16.4+)
- FFmpeg/ffprobe — bundled automatically via npm (see [FFmpeg setup](#ffmpeg-setup))
- Optional, for production AI: a machine with an NVIDIA GPU for SAM 2, and any
  Llama endpoint (e.g. Ollama)

## Installation

```bash
git clone <this repo>
cd <repo>
npm install
cp .env.example .env.local   # optional — defaults work as-is
```

## Environment variables

All configuration is server-side (`lib/server/config.ts`, validated with zod).
Nothing is exposed to the browser except non-secret status via `/api/health`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Uploads, masks, exports, jobs |
| `MAX_UPLOAD_MB` | `500` | Upload size limit (enforced while streaming) |
| `MAX_VIDEO_DURATION_SECONDS` | `600` | Longest accepted clip |
| `MAX_VIDEO_DIMENSION` | `4096` | Largest accepted width/height |
| `ANALYSIS_MAX_SIZE` | `512` | Mask resolution (max side). 1024 is a good value with SAM 2 |
| `JOB_CONCURRENCY` | `2` | Parallel background jobs (per process, per job type with Redis) |
| `MIN_FREE_DISK_MB` | `1024` | Refuse work when disk is nearly full |
| `JOB_BACKEND` | `memory` | `memory` (jobs run inside the web server) or `redis` (BullMQ + `npm run worker` processes) |
| `REDIS_URL` | `redis://localhost:6379` | Redis for `JOB_BACKEND=redis` (`rediss://` for TLS) |
| `JOB_QUEUE_PREFIX` | `opensam` | Namespace for keys/queues, so deployments can share a Redis |
| `WORKER_JOB_TYPES` | `ingest,segment,export` | Job types a worker process takes (e.g. `segment` on GPU hosts) |
| `RUN_WORKERS_IN_WEB` | `false` | Redis backend: also run a worker inside the web process |
| `JOB_RETENTION_HOURS` | `168` | How long finished jobs stay queryable in Redis |
| `WORKER_SHUTDOWN_GRACE_MS` | `25000` | Worker: time running jobs get to finish on SIGTERM |
| `PROJECT_STORE` | `file` | Project/track metadata: `file` (JSON in `DATA_DIR`) or `postgres` |
| `DATABASE_URL` | – | `postgres://…`, required with `PROJECT_STORE=postgres` |
| `DATABASE_POOL_SIZE` | `10` | PostgreSQL connections per process |
| `MEDIA_STORE` | `local` | Media and exports: `local` (`DATA_DIR`) or `s3` (bucket; `DATA_DIR` becomes a cache) |
| `S3_BUCKET` | – | Bucket name, required with `MEDIA_STORE=s3` |
| `S3_REGION` | `us-east-1` | Bucket region |
| `S3_ENDPOINT` | – | For S3-compatible services (MinIO, R2, …); omit for AWS |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO and most self-hosted services |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | – | Optional; otherwise the AWS default credential chain (env, instance role, …) |
| `S3_PREFIX` | – | Key prefix inside the bucket, e.g. `opensam/prod` |
| `MEDIA_CACHE_MAX_MB` | `20480` | Per-machine cache of downloaded media (S3 mode) |
| `LLM_PROVIDER` | `mock` | `mock` or `llama` |
| `LLAMA_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible endpoint |
| `LLAMA_MODEL` | `llama3.1:8b` | Model name at that endpoint |
| `LLAMA_API_KEY` | – | Bearer token if required |
| `LLAMA_TIMEOUT_MS` | `20000` | Per-request timeout |
| `LLAMA_FALLBACK_TO_RULES` | `true` | Fall back to the rule parser (flagged in the UI) if Llama fails |
| `SEGMENTATION_PROVIDER` | `mock` | `mock` or `sam2` |
| `SAM2_SERVICE_URL` | `http://localhost:8008` | Inference server, or a comma-separated pool |
| `SAM2_API_KEY` | – | Must match the server's `INFERENCE_API_KEY` |
| `SAM2_TIMEOUT_MS` | `300000` | Per-request timeout |
| `SAM2_SHARED_STORAGE` | `false` | Send file paths instead of uploading (shared disk) |
| `FFMPEG_PATH`, `FFPROBE_PATH` | – | Override binary locations |

## Running locally

```bash
npm run dev            # development, http://localhost:3000
npm run build && npm start   # production build
```

By default the job queue runs inside the Next.js server process, so use a
long-running server (`next dev` / `next start`, Docker, a VM) — not serverless
functions. To run jobs in separate processes, see
[Running workers with Redis](#running-workers-with-redis).

Useful scripts:

| Script | What it does |
| --- | --- |
| `npm run lint` / `npm run typecheck` | ESLint, TypeScript |
| `npm test` | All Vitest suites (unit, components, integration) |
| `npm run test:e2e` | Production build + Playwright browser tests |
| `npm run check` | lint + typecheck + tests + build |
| `npm run worker` | Job worker process (`JOB_BACKEND=redis`) |
| `npm run db:migrate` | Create/upgrade the PostgreSQL schema (also automatic on first use) |
| `npm run db:import-files` | Copy file-store projects into PostgreSQL (re-runnable) |
| `npm run demo:generate` | Re-render the demo clip and its ground-truth masks |
| `npm run eval:mock` | Measure mock segmentation/tracking IoU on the demo clip |
| `npm run demo:hero` | Re-render the landing-page “after” clip through the API |

### Running workers with Redis

With `JOB_BACKEND=redis` the web server only enqueues jobs; worker processes
— on the same machine or others — run ingest, tracking and export. Progress,
results and cancellation travel through Redis, so the UI behaves exactly as in
the single-process setup.

```bash
redis-server                                   # or any Redis 6.2+
export JOB_BACKEND=redis REDIS_URL=redis://localhost:6379
npm run worker                                 # one or more, anywhere that can reach Redis and DATA_DIR
npm run build && npm start                     # web server(s)
```

- **Scaling:** start more workers; each takes `JOB_CONCURRENCY` jobs per type.
  Split by hardware with `WORKER_JOB_TYPES=segment` (GPU hosts) and
  `WORKER_JOB_TYPES=ingest,export` (CPU hosts).
- **Storage:** web and workers must either share `DATA_DIR` (a shared volume;
  project updates take a lock file, so concurrent writers are safe) or use
  `PROJECT_STORE=postgres` + `MEDIA_STORE=s3`, which needs no shared disk.
- **Shutdown:** SIGTERM stops taking jobs, gives running ones
  `WORKER_SHUTDOWN_GRACE_MS` to finish, and records the rest as *interrupted*
  (the user sees "run it again").
- **Crashes:** if a worker dies without shutting down, another worker re-runs
  its job once BullMQ's lock expires (60 s); jobs nobody will finish are
  failed as interrupted by a janitor.
- **No worker running:** jobs wait ("Waiting for a worker…"), and Settings →
  Video processing shows which job types have no worker.

### Storing projects in PostgreSQL

```bash
export PROJECT_STORE=postgres DATABASE_URL=postgres://user:pass@db:5432/opensam
npm run db:migrate          # optional: the app migrates on first use too
npm run db:import-files     # optional: bring over projects created with the file store
```

Projects live in `opensam_projects` (the full project as JSONB) and tracks in
`opensam_tracks` (masks in their own column, with precomputed summaries so
listing never loads mask data). Updates are transactions with row locks, so
any number of web servers and workers can write concurrently. Tables are
prefixed `opensam_`, so a shared database is fine. Media files stay in
`DATA_DIR`.

### Storing media in S3 (no shared disk)

```bash
export MEDIA_STORE=s3 S3_BUCKET=my-opensam-media S3_REGION=eu-west-1
# MinIO / R2 / other S3-compatible services:
# export S3_ENDPOINT=http://minio:9000 S3_FORCE_PATH_STYLE=true S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…
```

Every file a process produces — the upload, poster, filmstrip, previews,
exports — is published to the bucket under `projects/<id>/…`. Processes that
need a file on disk (FFmpeg, the SAM 2 upload) download it into their own
`DATA_DIR`, which becomes a cache capped at `MEDIA_CACHE_MAX_MB` (least
recently used files go first; files used in the last hour are kept). The web
server streams media to the browser from its cache or straight from the
bucket, with Range support, so playback stays same-origin (canvas previews
need that) and no bucket CORS setup is needed.

With Redis jobs + PostgreSQL + S3, web servers and workers share nothing but
those three services, so they can run on separate machines — e.g. workers
with `WORKER_JOB_TYPES=segment` on GPU hosts.

## Running with mock AI

Mock mode is the default and is **clearly labeled** in the UI (“Mock AI” badge,
“Mock inference” on the AI panel, a note on every tracking result). It is a
real, working pipeline — just not a neural network.

### Exactly where the mock ends and real AI begins

The only switch is `services/ai/registry.ts`. Everything outside the two
provider boxes below is shared, production code that runs identically in both
modes: the UI, API, validation, job queue, plan compiler, targeting
(position/size), mask storage, tracking orchestration, compositing, export.

| Stage | Mock (default) | Production |
| --- | --- | --- |
| Command understanding | `services/ai/mock/MockLanguageProvider.ts` → `services/llama/rules.ts`: deterministic grammar/lexicon parser (actions, 90+ object nouns, colors, clothing, positions, time ranges) | `services/llama/LlamaProvider.ts`: Llama via any OpenAI-compatible API, JSON mode, few-shot prompt |
| Output validation | `services/llama/normalize.ts` + zod schema — **same code for both** | same |
| Text grounding (“the red car” → box) | `services/ai/mock/cv/grounding.ts`: moving-blob candidates scored by shape priors (tall = person, wide = vehicle), named-color coverage, clothing-region color, temporal persistence | `/ground` on the inference server: Grounding DINO (`GROUNDING_MODEL`) |
| Single-frame segmentation (click/box) | `services/ai/mock/MockSegmentationProvider.ts`: background-subtraction components, color region growing, GrabCut-style box segmentation | SAM 2 `add_new_points_or_box` / `add_new_mask` |
| Tracking | `services/ai/mock/cv/tracker.ts`: shape-prior tracker (translation search, color-gated bands, discriminative color model, occlusion coasting) | SAM 2 `propagate_in_video` (memory-based) |
| Object removal fill | Clean-plate median (`lib/compositing/cleanPlate.ts`) — used in both modes today | (future) video inpainting model |

**Quality.** On the bundled demo clip the mock pipeline reaches mean IoU
0.96 (red car), 0.91 (man in blue shirt), 0.83 (dog), 0.79 (man in red shirt)
against ground truth (`npm run eval:mock`; enforced by the integration
tests). It works best on **static-camera** footage with distinct subjects. It
cannot re-identify objects after long occlusions, it doesn't understand object
categories beyond shape heuristics, and on moving-camera footage it falls back
to color-based segmentation. For real footage, connect SAM 2.

## Connecting Llama

Any server exposing `POST /v1/chat/completions` works. With
[Ollama](https://ollama.com):

```bash
ollama pull llama3.1:8b
ollama serve                     # http://localhost:11434
```

```bash
# .env.local
LLM_PROVIDER=llama
LLAMA_BASE_URL=http://localhost:11434/v1
LLAMA_MODEL=llama3.1:8b
```

Hosted options (Together, Groq, Fireworks, vLLM…) work the same way — set
`LLAMA_BASE_URL`, `LLAMA_MODEL` and `LLAMA_API_KEY`. Open **Settings →
Test command understanding** to see the parsed JSON and which parser produced it.

How the output is handled (`services/llama/LlamaService.ts`):

1. The model is asked for one JSON object (`response_format: json_object`,
   temperature 0, schema + few-shot examples in `services/llama/prompt.ts`).
2. The answer is **untrusted**: `normalizeCommand()` extracts JSON from prose or
   code fences, maps a bounded set of synonyms, drops unknown fields and
   invalid values, and validates against the zod schema.
3. If validation fails, the model gets **one repair attempt** with the error.
4. If the model is down, slow or still invalid, the built-in parser answers
   and the UI shows a warning (disable with `LLAMA_FALLBACK_TO_RULES=false`).
5. The validated command is compiled into an `EditingPlan` by deterministic
   code (`services/llama/plan.ts`) — the model never executes anything.

## Connecting SAM 2

Run the inference server on a GPU machine — full details in
[`inference/README.md`](inference/README.md):

```bash
cd inference
python -m venv .venv && source .venv/bin/activate
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124   # match your CUDA
pip install -r requirements.txt
GROUNDING_MODEL=IDEA-Research/grounding-dino-tiny INFERENCE_API_KEY=change-me \
  uvicorn app.main:app --host 0.0.0.0 --port 8008
```

Or `docker build -t opensam-inference inference/ && docker run --gpus all -p 8008:8008 opensam-inference`.

```bash
# .env.local on the web app
SEGMENTATION_PROVIDER=sam2
SAM2_SERVICE_URL=http://<gpu-host>:8008
SAM2_API_KEY=change-me
ANALYSIS_MAX_SIZE=1024
```

**Several GPU servers:** list them all —
`SAM2_SERVICE_URL=http://gpu-a:8008,http://gpu-b:8008`. Each video's session
stays on one server (chosen by rendezvous hashing, so every web and worker
process agrees without coordination), different videos spread across the
pool, and if a server is unreachable or still loading, its videos move to the
next one automatically (the video is sent there once). A server that
restarted and lost its sessions gets them back on the next request.

The status appears in **Settings** and in the header badge. The HTTP
contract (sessions, `/segment`, NDJSON `/propagate`, `/ground`) is documented
in `inference/README.md` and covered by tests on both sides
(`tests/unit/sam2-provider.test.ts`, `inference/tests/test_api.py`). You can
exercise the full web-app → Python path without a GPU using the fake backend:
`uvicorn tests.fake_server:app --port 8008` in `inference/`.

## Deploying with Docker Compose

`docker-compose.yml` runs the distributed setup on one machine: web, worker,
Redis, PostgreSQL and MinIO (S3 API), plus the SAM 2 inference server with
the `gpu` profile.

```bash
docker compose up --build                       # mock AI → http://localhost:3000
docker compose up --build --scale worker=3      # more workers
docker compose --profile gpu up --build         # + SAM 2 (NVIDIA Container Toolkit)
```

Put overrides in a `.env` file next to it (`SEGMENTATION_PROVIDER=sam2`,
`INFERENCE_API_KEY`, `LLM_PROVIDER=llama`, `LLAMA_BASE_URL`,
`POSTGRES_PASSWORD`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, `PORT`). Web and
worker containers have separate cache volumes and share only Redis,
PostgreSQL and MinIO, so moving them to separate machines means pointing the
same variables at shared services. The root `Dockerfile` builds one image for
both (`npx next start` or `npm run worker`).

## FFmpeg setup

FFmpeg is used for probing, thumbnails, preview proxies, frame decoding for
analysis, and all exports. Resolution order (`services/video/ffmpeg.ts`):

1. `FFMPEG_PATH` / `FFPROBE_PATH`
2. Bundled binaries from `ffmpeg-static` and `@ffprobe-installer/ffprobe`
   (downloaded by `npm install` for your OS/CPU)
3. `ffmpeg` / `ffprobe` on `$PATH`

If `npm install` couldn't download the binaries (offline install, unusual
platform), install FFmpeg yourself — `brew install ffmpeg`, `sudo apt install
ffmpeg`, `winget install ffmpeg` — or set the paths. **Settings → Video
processing** shows the detected version and which encoders are available;
formats whose encoder is missing are disabled in the export dialog.
Transparent WebM needs `libvpx-vp9`; ProRes needs `prores_ks`.

FFmpeg always runs with an argument array (never a shell), with timeouts and
cancellation.

## GPU requirements

| Setup | Hardware | Notes |
| --- | --- | --- |
| Mock mode | Any laptop CPU | ~5 ms/frame tracking at 512 px |
| SAM 2.1 Hiera-L | 16–24 GB NVIDIA GPU (L4, A10G, RTX 4090) | Best quality |
| SAM 2.1 Hiera-B+ / S / T | 8–12 GB | Faster, lower quality |
| Grounding DINO tiny | +2 GB | Enables text → object without clicks |
| Llama 3.1 8B (Ollama, 4-bit) | 8 GB GPU or Apple Silicon | Or use a hosted endpoint |

## Production architecture

The MVP deliberately keeps everything in one process with interfaces at the
seams where it will be split:

| MVP | Production replacement | Seam |
| --- | --- | --- |
| In-process `JobQueue` + JSON job files (default) | **Available:** `JOB_BACKEND=redis` — BullMQ on Redis, `npm run worker` processes | `services/jobs/types.ts` (`JobQueuePort`; handlers only see `signal` + `progress`) |
| `FileSystemProjectRepository` (default) | **Available:** `PROJECT_STORE=postgres` — projects and tracks in PostgreSQL | `services/projects/ProjectRepository.ts` |
| Local `data/` media (default) | **Available:** `MEDIA_STORE=s3` — S3 or compatible storage, per-machine cache, range streaming. Next: signed URLs/CDN for previews | `services/storage/objectStore.ts`, `services/storage/projectMedia.ts` |
| Mock / single inference server | **Available:** a pool of inference servers with per-video affinity and failover. Next: autoscaling the pool | `services/sam2/SAM2Provider.ts` contract |
| Job status polling | **Available:** server-sent events per project (works across worker processes via Redis pub/sub), polling fallback | `services/jobs/events.ts`, `hooks/useJobUpdates.ts` |
| In-memory rate limits | Redis rate limiting at the edge | `lib/server/api.ts` |

Export compositing is plain TypeScript over raw frames piped through FFmpeg;
at scale it would move to the GPU workers (or FFmpeg filter graphs with
`alphamerge`) alongside inference.

## Testing

```bash
npm test                 # 226 Vitest tests: unit, components (jsdom), integration
npm run test:e2e         # Playwright (set PLAYWRIGHT_CHROMIUM_EXECUTABLE to reuse a local Chromium)
cd inference && pytest   # Python contract tests (no GPU needed)
```

- **Unit** — RLE and brush ops, command parsing (20+ phrasings), model-output
  validation (malformed/hostile JSON), Llama provider (mocked HTTP: repair,
  timeout, fallback), plan compiler, job state transitions/cancellation/
  recovery, classical-CV primitives and tracker, compositing/effects/clean
  plate, upload validation (magic bytes, file names), ffprobe parsing, SAM 2
  HTTP client (NDJSON streaming, error mapping), editor store undo/redo.
- **Components** — upload flow (validation, progress, server errors), AI
  command submission and history, timeline (scrub, keyboard, segments,
  processing bars), tools and objects panel.
- **Integration** — real route handlers + FFmpeg: upload (including disguised,
  truncated and oversized files, path traversal), AI command → segmentation →
  tracking (checked against ground truth), click segmentation → keyframe
  tracking, range streaming, all export formats (verifying real alpha in
  WebM, PNG zip contents, frame counts after FPS conversion), cancellation,
  deletion, and the mock quality regression.
- **Formats** — generated ProRes `.mov` (PCM audio), H.264-with-B-frames
  `.mkv` (AAC) and a rotated, variable-frame-rate HEVC `.mov` (phone-style):
  the H.264 and VP9 preview proxies show exactly the frame masks were computed
  on, portrait video is analysed upright, box → track matches ground truth,
  and exports keep display orientation, every frame and the audio.
- **Live updates** — the SSE route (snapshot, coalesced progress, no job
  inputs on the wire, cleanup on abort/disconnect, cross-process via Redis) and
  the client hook (results applied exactly once, no replay of old jobs after a
  reconnect, fallback to polling, out-of-order updates never regress a job).
- **Project stores** — one contract suite run against both the file store and
  a throwaway PostgreSQL cluster: CRUD, validation, 24 concurrent updates from
  two "processes" with nothing lost, track summaries without mask data,
  cascading deletes; plus concurrent migrations, unreachable database →
  friendly error, and file → PostgreSQL import. The multi-process pipeline
  suite also runs with PostgreSQL as the store.
- **Object storage** (skipped without `moto_server`, from
  `pip install -r inference/requirements-dev.txt`) — against an S3-compatible
  server: multipart upload of a 40 MB file, download-on-demand with
  concurrent requests deduplicated, serving from the bucket with Range /
  416 / HEAD / 304, JSON documents across machines, LRU cache trimming,
  deleting a project's objects, and an unreachable store → friendly error.
  The multi-process pipeline suite also runs with **separate disks** for the
  web and worker processes (Redis + PostgreSQL + S3 only).
- **SAM 2 server pool** — routing (stable across processes, spread across
  servers), failover when a server is down or loading and back after the
  cooldown, re-creating sessions a restarted server forgot, pool health; and
  against two real inference servers (fake backend), killing the one that
  owns a session mid-way.
- **Job queue on Redis** (skipped if `redis-server` isn't installed) — a
  throwaway Redis per run: cross-process progress/results, cancelling queued
  and running jobs, graceful shutdown (including handlers that ignore the
  abort), crash recovery via BullMQ stall detection, the orphan janitor, and
  the full upload → AI command → export pipeline with a real `workers/main.ts`
  process, then SIGTERM and a replacement worker.
- **Python** — the inference server's HTTP contract with a fake backend, plus
  SAM 2 frame extraction on the web app's frame grid.
- **E2E** — landing page → Try Demo → AI command → effect → shortcuts/undo →
  export → download (asserting progress arrives over the event stream with no
  job polling); a real upload of a rotated variable-frame-rate phone
  clip → preview proxy → click-to-track, comparing the decoded video pixels
  with the mask overlay's pixels frame by frame (and after pausing mid-play);
  plus an accessible-name audit of every editor button.

## Security

- Uploads are **untrusted**: extension allowlist, MIME check, magic-byte
  sniffing, size limit enforced while streaming, ffprobe validation, duration
  and resolution limits. Stored under generated names; the original name is
  sanitized and kept only as metadata.
- All ids are validated against strict patterns before touching the
  filesystem; every path is derived in `services/storage/paths.ts` and checked
  to stay inside `DATA_DIR`.
- FFmpeg is spawned with argument arrays (no shell), timeouts and kill-on-cancel.
- Every API body is validated with zod; errors return a catalog message and
  hint — never stack traces or tool output (`lib/errors.ts`).
- Model output is validated and compiled by deterministic code before use.
- API keys live only in server env vars; `server-only` guards server modules.
- Basic per-client rate limits on uploads, AI commands, segmentation, exports.
- Security headers (`nosniff`, frame options, referrer and permissions policy).
- There is **no authentication** in the MVP — run it locally or behind your own
  auth proxy. Multi-user auth is on the roadmap.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| “Video processing isn't available on this server” | FFmpeg wasn't found. Re-run `npm install`, or install FFmpeg and/or set `FFMPEG_PATH`/`FFPROBE_PATH`. Check **Settings → Video processing**. |
| Video preview stays black / “Preparing a browser-friendly preview” | The codec isn't playable in your browser; a proxy is being generated. Chromium builds without H.264 get a VP9 preview automatically. |
| “We couldn't read this video” | The file is damaged or uses an unusual codec — re-export as H.264 MP4. |
| “We couldn't find ‘…’ in this video” | In mock mode, grounding understands people/animals/vehicles, colors, clothing and positions on static shots. Click the object with the Select tool instead, or connect SAM 2 + Grounding DINO. |
| Tracking drifts onto another object | Move to the frame where it went wrong, fix it (click / Alt-click / eraser), then **Re-track from this frame**. |
| Llama commands fall back to the built-in parser | Check `LLAMA_BASE_URL`/`LLAMA_MODEL` and that the server is running (`ollama serve`). **Settings** shows the provider status. |
| “SAM 2 is still loading or unavailable” | The inference server is starting or failed to load the model; check its logs and `/health`. |
| “The server is running low on disk space” | Delete old projects (Projects page) or lower `MIN_FREE_DISK_MB`. |
| Jobs show “interrupted because the server restarted” | Jobs run inside the server process; re-run them. |
| Port 3000 in use | `npm run dev -- -p 3001` |

## Limitations

- Mock inference is classical computer vision, not a neural network (see the
  table above). Production-quality masks need SAM 2.
- Masks are stored at analysis resolution (default 512 px) and upscaled with
  feathering; hair-level detail needs a higher `ANALYSIS_MAX_SIZE` with SAM 2
  (and a matting model — see roadmap).
- Variable-frame-rate video (typical of phones) is placed on a constant grid
  at its average frame rate: frame *i* is the picture on screen at
  (*i* + ½) / fps, which is what the browser shows, so masks stay aligned.
  Where the phone dropped frames a slot repeats the previous picture, and
  bursts faster than the average rate are thinned.
- “Remove object” uses a clean-plate median, which is exact for static
  cameras with moving subjects and approximate otherwise; it is not generative
  inpainting.
- Export compositing is CPU-bound in the web server process (~30–70 ms/frame at
  720p); long 4K exports are slow.
- Single user, no authentication, local filesystem storage.

## Roadmap

1. **Browser-based AI rotoscoping** — this MVP: natural language + clicks →
   SAM 2 masks → tracking → export, with a mock mode for development.
2. **Cloud GPU inference** — autoscaled SAM 2 workers, Redis/BullMQ jobs,
   object storage, Postgres, SSE progress, matting refinement for hair, video
   inpainting (e.g. ProPainter) for object removal, WebCodecs frame-accurate
   preview.
3. **Real-time collaboration** — accounts, shared projects, presence, comments
   on frames, CRDT-based document sync (the document/history model is already
   snapshot-based and serializable).
4. **Advanced compositing** — layers, multiple effects per object, background
   replacement with images/video, color grading of isolated subjects, motion
   blur-aware mattes.
5. **Professional editing features** — multi-clip timelines, keyframed
   parameters, EDL/XML interchange, OpenEXR / ProRes 4444 XQ, color-managed
   pipelines.
6. **Public API** — the existing REST endpoints hardened with API keys,
   webhooks for job completion, SDKs.
7. **Plugins** — Premiere Pro / DaVinci Resolve / After Effects / Nuke
   panels that send shots to OpenSAM and import mattes back.

## License & attribution

OpenSAM Studio's own code is provided as-is for evaluation. SAM 2 and Llama
are released by Meta under their own licenses (Apache 2.0 for SAM 2; the Llama
Community License for Llama models) — review them before production use.
FFmpeg binaries are distributed under the GPL/LGPL by their respective
packagers. The demo clip is procedurally generated by
`scripts/generate-demo.ts` and contains no third-party footage.
