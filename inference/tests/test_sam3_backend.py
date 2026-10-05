"""Sam3Backend against tiny random SAM 3 models (real transformers code paths).

Skipped unless torch, torchvision and a transformers release with SAM 3 are
installed. Masks are noise; these tests check that every call the backend
makes into transformers is well-formed and that the HTTP API works with it.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("torch")
pytest.importorskip("torchvision")
transformers = pytest.importorskip("transformers")
if not hasattr(transformers, "Sam3TrackerVideoModel"):
    pytest.skip("transformers without SAM 3", allow_module_level=True)

from app.backend import Keyframe, Sam3Backend  # noqa: E402

from . import tiny_sam3  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def _ffmpeg() -> str:
    found = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg")
    if found:
        return found
    bundled = REPO / "node_modules" / "ffmpeg-static" / "ffmpeg"
    if bundled.exists():
        os.environ["FFMPEG_PATH"] = str(bundled)
        return str(bundled)
    pytest.skip("ffmpeg not available")


@pytest.fixture(scope="module")
def video(tmp_path_factory) -> str:
    out = tmp_path_factory.mktemp("vid") / "clip.mp4"
    subprocess.run(
        [_ffmpeg(), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x96:rate=10:duration=0.8",
         "-pix_fmt", "yuv420p", str(out)],
        check=True,
    )
    return str(out)


@pytest.fixture(scope="module")
def backend(tmp_path_factory) -> Sam3Backend:
    os.environ["SAM3_WORKDIR"] = str(tmp_path_factory.mktemp("work"))
    be = Sam3Backend(loader=tiny_sam3.loader)
    assert be.status() == "ok"
    return be


def test_session_and_segment_with_points_and_box(backend, video):
    info = backend.create_session("s1", video, 80, 48, 10.0)
    assert info.frame_count == 8 and (info.width, info.height) == (160, 96)
    mask, score = backend.segment("s1", Keyframe(2, [(0.5, 0.5), (0.2, 0.2)], [1, 0], (0.1, 0.1, 0.9, 0.9)))
    assert mask.shape == (48, 80) and mask.dtype == bool
    assert 0.0 <= score <= 1.0
    mask, _ = backend.segment("s1", Keyframe(0, box=(0.2, 0.2, 0.6, 0.8)))
    assert mask.shape == (48, 80)


def test_propagate_from_mask_and_points(backend, video):
    backend.create_session("s2", video, 80, 48, 10.0)
    m = np.zeros((48, 80), bool)
    m[10:30, 20:50] = True
    kfs = [Keyframe(3, mask=m), Keyframe(6, [(0.4, 0.5)], [1])]
    frames = [i for i, mask in backend.propagate("s2", kfs, 0, 7, "both")]
    assert sorted(frames) == list(range(8))
    fwd = [i for i, _ in backend.propagate("s2", [Keyframe(3, mask=m)], 0, 7, "forward")]
    assert sorted(fwd) == list(range(3, 8))


def test_ground_returns_normalized_boxes(backend, video):
    backend.create_session("s3", video, 80, 48, 10.0)
    backend._det_threshold = 0.0  # random weights: keep every query
    dets = backend.ground("s3", [0, 4, 7, 99], "red car")
    assert dets, "expected detections with threshold 0"
    assert {d["frame_index"] for d in dets} <= {0, 4, 7}
    for d in dets:
        x0, y0, x1, y1 = d["box"]
        assert 0 <= x0 <= 1 and 0 <= y1 <= 1 and d["label"] == "red car"


def test_http_api_with_sam3_backend(backend, video):
    from fastapi.testclient import TestClient

    from app.main import create_app

    client = TestClient(create_app(backend))
    assert client.get("/health").json()["grounding"] is True
    with open(video, "rb") as fh:
        r = client.post(
            "/v1/sessions",
            files={"video": ("clip.mp4", fh, "video/mp4")},
            data={"meta": '{"session_id": "http1", "mask_width": 40, "mask_height": 24, "fps": 10}'},
        )
    assert r.status_code == 200, r.text
    r = client.post("/v1/sessions/http1/segment", json={"frame_index": 1, "points": [[0.5, 0.5]], "labels": [1]})
    assert r.status_code == 200 and r.json()["mask"]["size"] == [24, 40]
    r = client.post(
        "/v1/sessions/http1/propagate",
        json={"keyframes": [{"frame_index": 1, "points": [[0.5, 0.5]], "labels": [1]}], "start_frame": 0, "end_frame": 7},
    )
    lines = [ln for ln in r.text.splitlines() if ln]
    assert lines[-1] == '{"type":"done"}'
    assert sum('"mask"' in ln for ln in lines) == 8


def test_benchmark_end_to_end_on_tiny_dataset(backend, tmp_path):
    """The DAVIS benchmark runs start to finish (scores are meaningless here)."""
    from PIL import Image

    from bench.sam3_bench import parse_args, run

    _ffmpeg()
    seq = "toy"
    (tmp_path / "ImageSets" / "2017").mkdir(parents=True)
    (tmp_path / "ImageSets" / "2017" / "val.txt").write_text(seq + "\n")
    jd = tmp_path / "JPEGImages" / "480p" / seq
    ad = tmp_path / "Annotations" / "480p" / seq
    jd.mkdir(parents=True)
    ad.mkdir(parents=True)
    for i in range(5):
        img = np.zeros((96, 160, 3), np.uint8)
        img[...] = (30, 90, 160)
        img[30:70, 20 + 8 * i : 70 + 8 * i] = (220, 50, 40)
        Image.fromarray(img).save(jd / f"{i:05d}.jpg", quality=95)
        ann = np.zeros((96, 160), np.uint8)
        ann[30:70, 20 + 8 * i : 70 + 8 * i] = 1
        im = Image.fromarray(ann, mode="P")
        im.putpalette([0, 0, 0, 128, 0, 0] + [0] * 762)
        im.save(ad / f"{i:05d}.png")
    args = parse_args(["--data", str(tmp_path), "--workdir", str(tmp_path / "work")])
    result = run(args, backend)
    assert set(result["summary"]) == {"sam3", "+refine", "+temporal", "+refine+temporal"}
    assert all(s["objects"] == 1 and 0 <= s["J&F"] <= 1 for s in result["summary"].values())
