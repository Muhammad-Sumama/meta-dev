# OpenSAM Studio — inference server

A small FastAPI service that runs Meta's **SAM 3** (default) or **SAM 2** on a
GPU machine. The Next.js app talks to it through
`services/sam2/SAM2Provider.ts` when `SEGMENTATION_PROVIDER=sam3` (or `sam2`).

```
                                        MODEL_FAMILY=sam3 (default)
Next.js app ──HTTP──▶ inference server ──▶ SAM 3 tracker   (clicks/boxes/masks → tracked masks)
                                        └─▶ SAM 3 detector  (text "red car" → every matching object)
                                        MODEL_FAMILY=sam2
                                        ──▶ SAM 2 video predictor + optional Grounding DINO
```

SAM 3 and SAM 2 are Meta's models, used here under their licenses; OpenSAM
Studio is an independent project and is not affiliated with or endorsed by
Meta. **SAM 3 weights are gated:** sign in at
[huggingface.co/facebook/sam3](https://huggingface.co/facebook/sam3), accept the
license, create an access token, and pass it as `HF_TOKEN`.

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
docker run --gpus all -p 8008:8008 -e INFERENCE_API_KEY=change-me -e HF_TOKEN=hf_... \
  -v hf-cache:/root/.cache/huggingface opensam-inference          # SAM 3
# add -e MODEL_FAMILY=sam2 for SAM 2
```

Then in the web app's `.env.local`:

```bash
SEGMENTATION_PROVIDER=sam3      # or sam2 — must match the server's MODEL_FAMILY
SAM2_SERVICE_URL=http://gpu-host:8008
SAM2_API_KEY=change-me          # must match INFERENCE_API_KEY
# SAM2_SHARED_STORAGE=true      # only if both machines see the same DATA_DIR paths
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_FAMILY` | `sam2` (`sam3` in the Docker image) | Which model to serve |
| `HF_TOKEN` | – | Hugging Face token with access to the gated SAM 3 weights |
| `SAM3_MODEL_ID` | `facebook/sam3` | Checkpoint for both the SAM 3 tracker and detector |
| `SAM3_TEXT` | `1` | Load the SAM 3 detector for text commands (`0` saves ~half the GPU memory; text commands then need a click) |
| `SAM3_DETECTION_THRESHOLD` | `0.4` | Minimum detector score for text matches |
| `SAM3_DTYPE` | `bfloat16` on CUDA | Model precision (`float32` on CPU/MPS) |
| `SAM3_FRAME_MAX_SIDE` | `1008` | Frames are decoded at most this large (SAM 3 works at 1008) |
| `SAM3_MAX_SESSIONS` / `SAM3_OFFLOAD_VIDEO` | `2` / `1` | As the SAM 2 equivalents below |
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

**SAM 3** (848M parameters, bfloat16): the tracker and the text detector
together need roughly 8–10 GB of GPU memory plus working memory per video, so
use a 16–24 GB GPU (L4, A10G, RTX 4090) or larger (A100/H100 for long clips or
several users). With `SAM3_TEXT=0` only the tracker is loaded. Decoded frames
of each open video are kept in CPU RAM (about 6 MB per frame at 1008 px in
bfloat16, so ~2 GB for a 10-second 30 fps clip); size the machine's RAM for
`SAM3_MAX_SESSIONS` videos at once.

**SAM 2.1 Hiera-L runs comfortably on a 16–24 GB GPU (A10G, L4, RTX 4090) for
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

`meta` = `{session_id, mask_width, mask_height, fps?, frame_count?}`. When
`fps` is given, frames are extracted on the web app's grid (frame *i* is the
picture shown at (*i* + ½) / fps), so frame indices agree with the app even for
variable-frame-rate phone video.
Keyframes may carry a `mask` (RLE at the session's mask size) — used when the
user refined a frame with the brush and re-tracks from it (`add_new_mask`).

## Deploying on a rented cloud GPU

Any provider that runs a Docker image on an NVIDIA GPU works (RunPod, Lambda,
Vast.ai, a cloud VM with the NVIDIA Container Toolkit…):

1. Build and push the image: `docker build -t <registry>/opensam-inference inference/ && docker push <registry>/opensam-inference`.
2. Start it on a 24 GB GPU with port 8008 exposed and the environment
   `HF_TOKEN=hf_…`, `INFERENCE_API_KEY=<long random secret>` (and a persistent
   volume at `/root/.cache/huggingface` so the weights download once).
3. Wait for `GET https://<host>:8008/health` to report `"status": "ok"`.
4. Point the web app at it: `SEGMENTATION_PROVIDER=sam3`,
   `SAM2_SERVICE_URL=https://<host>:8008`, `SAM2_API_KEY=<same secret>`.

Put the server behind HTTPS (most providers give you a TLS proxy URL) because
uploads and the API key travel over it. Stop the machine when you're not
using it — you pay per hour while it runs.

## Benchmark: SAM 3 alone vs. SAM 3 + OpenSAM post-processing

`bench/sam3_bench.py` measures whether the app's post-processing (colour
guided-filter edge refinement, temporal smoothing) makes SAM 3's masks more
accurate, on DAVIS 2017 (the standard video-segmentation benchmark) or any
folder with the same layout:

```bash
wget https://data.vision.ee.ethz.ch/csergi/share/davis/DAVIS-2017-trainval-480p.zip && unzip DAVIS-2017-trainval-480p.zip
HF_TOKEN=hf_... python -m bench.sam3_bench --data DAVIS --split val --out sam3_bench.json
```

Each object is tracked from its first-frame ground-truth mask, and every
variant is scored from the same SAM 3 logits with the DAVIS metrics J (IoU),
F (boundary accuracy) and J&F, printed relative to plain SAM 3. A variant can
only be said to improve on SAM 3 for data where its J&F is higher; add your
own labelled clips (hair, fur, motion blur — where edges matter most) next to
DAVIS to measure the cases you care about.

## Tests

The contract tests use a fake backend, so they run without PyTorch or a GPU:

```bash
pip install -r requirements-dev.txt
pytest
```

With `torch`, `torchvision` and `transformers>=5.18` installed,
`tests/test_sam3_backend.py` also runs `Sam3Backend` — including the HTTP API
and the benchmark — against tiny randomly initialised SAM 3 models built in
`tests/tiny_sam3.py`, exercising the real transformers code paths without
downloading weights or needing a GPU.

To check the whole chain from the web app, run the fake server and point the
app at it:

```bash
uvicorn tests.fake_server:app --port 8008
SEGMENTATION_PROVIDER=sam3 SAM2_SERVICE_URL=http://localhost:8008 npm run dev
```
