# OpenSAM Studio — inference server

A small FastAPI service that runs **SAM 2** (and optionally an open-vocabulary
detector for text grounding) on a GPU machine. The Next.js app talks to it
through `services/sam2/SAM2Provider.ts` when `SEGMENTATION_PROVIDER=sam2`.

```
Next.js app ──HTTP──▶ inference server ──▶ SAM 2 video predictor (PyTorch, CUDA)
                                        └─▶ Grounding DINO (optional, text → boxes)
```

## Run

```bash
cd inference
python -m venv .venv && source .venv/bin/activate
# 1. PyTorch for your CUDA version: https://pytorch.org/get-started/locally/
# 2. Everything else (includes SAM 2 from GitHub):
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8008
```

Or with Docker (NVIDIA Container Toolkit required):

```bash
docker build -t opensam-inference inference/
docker run --gpus all -p 8008:8008 -e INFERENCE_API_KEY=change-me opensam-inference
```

Then in the web app's `.env.local`:

```bash
SEGMENTATION_PROVIDER=sam2
SAM2_SERVICE_URL=http://gpu-host:8008
SAM2_API_KEY=change-me          # must match INFERENCE_API_KEY
# SAM2_SHARED_STORAGE=true      # only if both machines see the same DATA_DIR paths
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SAM2_MODEL_ID` | `facebook/sam2.1-hiera-large` | Hugging Face id loaded with `SAM2VideoPredictor.from_pretrained` |
| `SAM2_CONFIG` + `SAM2_CHECKPOINT` | – | Alternative: local config/checkpoint (`build_sam2_video_predictor`) |
| `GROUNDING_MODEL` | – | e.g. `IDEA-Research/grounding-dino-tiny`. Enables `/ground` (text → boxes). Without it, text commands need the user to click the object. |
| `INFERENCE_API_KEY` | – | Shared secret; clients send `Authorization: Bearer <key>` |
| `SAM2_MAX_SESSIONS` | `2` | Videos kept initialized in memory (LRU) |
| `SAM2_FRAME_MAX_SIDE` | `1024` | Frames are decoded at most this large (SAM 2 works at 1024) |
| `SAM2_OFFLOAD_VIDEO` | `1` | Keep decoded frames on CPU to save GPU memory |
| `SHARED_STORAGE_ROOT` | – | If set, `video_path` requests must point inside this directory |
| `MAX_UPLOAD_MB` | `2048` | Upload limit for multipart session creation |
| `FFMPEG_PATH` | `ffmpeg` | Used to extract JPEG frames |

## GPU requirements

SAM 2.1 Hiera-L runs comfortably on a 16–24 GB GPU (A10G, L4, RTX 4090) for
clips of a few minutes at ≤1024px; Hiera-B+/S/T trade quality for memory and
speed. CPU and Apple MPS work for testing but are slow. Tracking one object
through a 10-second 30 fps clip typically takes a few seconds on an A10G.

## HTTP contract

All coordinates are **normalized** to 0..1. Masks are returned at the
`mask_width × mask_height` requested when the session was created, encoded as
**row-major** RLE: `counts` alternate background/foreground runs and always
start with a background run (see `app/rle.py`; this is *not* COCO's
column-major RLE).

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /health` | – | `{status: "loading"\|"ok"\|"error", model, device, grounding}` |
| `GET /v1/sessions/{id}` | – | session info, or 404 |
| `POST /v1/sessions` | multipart `meta` (JSON) + `video` file, **or** JSON `{…meta, video_path}` | session info |
| `POST /v1/sessions/{id}/ground` | `{frame_indices, text}` | `{detections: [{frame_index, box: [x0,y0,x1,y1], score, label}]}` (501 if disabled) |
| `POST /v1/sessions/{id}/segment` | `{frame_index, points: [[x,y]], labels: [1\|0], box?, mask?}` | `{frame_index, score, mask: {counts, size: [h, w]}}` |
| `POST /v1/sessions/{id}/propagate` | `{keyframes: [prompt…], start_frame, end_frame, direction}` | NDJSON stream of `{"type":"mask","frame_index",counts}`, `{"type":"progress",done,total}`, then `{"type":"done"}` or `{"type":"error"}` |
| `DELETE /v1/sessions/{id}` | – | `{ok: true}` |

`meta` = `{session_id, mask_width, mask_height, fps?, frame_count?}`.
Keyframes may carry a `mask` (RLE at the session's mask size) — used when the
user refined a frame with the brush and re-tracks from it (`add_new_mask`).

## Tests

The contract tests use a fake backend, so they run without PyTorch or a GPU:

```bash
pip install -r requirements-dev.txt
pytest
```

To check the whole chain from the web app, run the fake server and point the
app at it:

```bash
uvicorn tests.fake_server:app --port 8008
SEGMENTATION_PROVIDER=sam2 SAM2_SERVICE_URL=http://localhost:8008 npm run dev
```
