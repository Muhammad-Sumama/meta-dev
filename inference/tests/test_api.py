"""Contract tests for the inference server using a fake backend (no GPU/torch)."""

from __future__ import annotations

import json
import os
from typing import Iterator, Optional

import numpy as np
import pytest

os.environ["OPENSAM_INFERENCE_NO_AUTOLOAD"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from app import rle  # noqa: E402
from app.backend import Keyframe, SessionInfo  # noqa: E402
from app.main import create_app  # noqa: E402


class FakeBackend:
    """Returns box-shaped masks around prompts; tracks a square moving right."""

    name = "fake-sam2"
    device = "cpu"

    def __init__(self) -> None:
        self.sessions: dict[str, SessionInfo] = {}
        self.grounding = True

    def status(self) -> str:
        return "ok"

    def has_grounding(self) -> bool:
        return self.grounding

    def get_session(self, session_id: str) -> Optional[SessionInfo]:
        return self.sessions.get(session_id)

    def create_session(self, session_id, video_path, mask_width, mask_height):
        assert os.path.getsize(video_path) > 0
        info = SessionInfo(session_id, 10, 64, 32, mask_width, mask_height)
        self.sessions[session_id] = info
        return info

    def delete_session(self, session_id):
        self.sessions.pop(session_id, None)

    def _box_mask(self, info: SessionInfo, cx: float, cy: float) -> np.ndarray:
        m = np.zeros((info.mask_height, info.mask_width), dtype=bool)
        x, y = int(cx * info.mask_width), int(cy * info.mask_height)
        m[max(0, y - 1) : y + 2, max(0, x - 1) : x + 2] = True
        return m

    def segment(self, session_id, kf: Keyframe):
        info = self.sessions[session_id]
        if kf.points:
            cx, cy = kf.points[0]
        elif kf.box:
            cx, cy = (kf.box[0] + kf.box[2]) / 2, (kf.box[1] + kf.box[3]) / 2
        else:
            ys, xs = np.nonzero(kf.mask)
            cx, cy = xs.mean() / kf.mask.shape[1], ys.mean() / kf.mask.shape[0]
        return self._box_mask(info, cx, cy), 0.9

    def propagate(self, session_id, keyframes, start, end, direction) -> Iterator[tuple[int, np.ndarray]]:
        info = self.sessions[session_id]
        for f in range(start, end + 1):
            yield f, self._box_mask(info, min(0.95, 0.1 + 0.05 * f), 0.5)

    def ground(self, session_id, frame_indices, text):
        return [{"frame_index": f, "box": [0.1, 0.2, 0.3, 0.4], "score": 0.8, "label": text} for f in frame_indices]


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("INFERENCE_API_KEY", raising=False)
    backend = FakeBackend()
    return TestClient(create_app(backend)), backend, tmp_path


def create(client: TestClient, tmp_path, sid="prj_x-v1"):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"\x00\x00\x00\x20ftypisom" + b"\x00" * 64)
    meta = {"session_id": sid, "mask_width": 16, "mask_height": 8, "fps": 30, "frame_count": 10}
    with video.open("rb") as fh:
        return client.post("/v1/sessions", data={"meta": json.dumps(meta)}, files={"video": ("source", fh, "application/octet-stream")})


def test_rle_roundtrip():
    rng = np.random.default_rng(0)
    for p in (0.0, 0.3, 1.0):
        m = rng.random((7, 9)) < p
        counts = rle.encode(m)
        assert sum(counts) == 63
        assert np.array_equal(rle.decode(counts, 7, 9), m)
    assert rle.encode(np.array([[True, False]])) == [0, 1, 1]


def test_health(client):
    c, _, _ = client
    assert c.get("/health").json() == {"status": "ok", "model": "fake-sam2", "device": "cpu", "grounding": True}


def test_session_lifecycle(client):
    c, be, tmp = client
    assert c.get("/v1/sessions/prj_x-v1").status_code == 404
    res = create(c, tmp)
    assert res.status_code == 200
    assert res.json()["mask_width"] == 16
    assert c.get("/v1/sessions/prj_x-v1").status_code == 200
    assert c.delete("/v1/sessions/prj_x-v1").json() == {"ok": True}
    assert "prj_x-v1" not in be.sessions


def test_rejects_bad_session_ids(client):
    c, _, tmp = client
    assert create(c, tmp, sid="../etc").status_code == 422
    assert c.get("/v1/sessions/..%2Fetc").status_code == 404


def test_segment_returns_rle_at_requested_size(client):
    c, _, tmp = client
    create(c, tmp)
    res = c.post("/v1/sessions/prj_x-v1/segment", json={"frame_index": 2, "points": [[0.5, 0.5]], "labels": [1]})
    assert res.status_code == 200
    body = res.json()
    assert body["mask"]["size"] == [8, 16]
    mask = rle.decode(body["mask"]["counts"], 8, 16)
    assert mask[4, 8]
    assert body["score"] == pytest.approx(0.9)


def test_segment_validation(client):
    c, _, tmp = client
    create(c, tmp)
    assert c.post("/v1/sessions/prj_x-v1/segment", json={"frame_index": 2}).status_code == 422
    assert c.post("/v1/sessions/prj_x-v1/segment", json={"frame_index": 2, "points": [[2.0, 0.5]], "labels": [1]}).status_code == 422
    assert c.post("/v1/sessions/prj_x-v1/segment", json={"frame_index": 99, "points": [[0.5, 0.5]], "labels": [1]}).status_code == 422
    bad_mask = {"frame_index": 1, "mask": {"counts": [3, 3], "size": [8, 16]}}
    assert c.post("/v1/sessions/prj_x-v1/segment", json=bad_mask).status_code == 422


def test_propagate_streams_ndjson(client):
    c, _, tmp = client
    create(c, tmp)
    mask = np.zeros((8, 16), dtype=bool)
    mask[3:5, 2:4] = True
    body = {"keyframes": [{"frame_index": 0, "mask": {"counts": rle.encode(mask), "size": [8, 16]}}], "start_frame": 0, "end_frame": 99, "direction": "both"}
    with c.stream("POST", "/v1/sessions/prj_x-v1/propagate", json=body) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in res.iter_lines() if line]
    masks = [e for e in events if e["type"] == "mask"]
    assert [e["frame_index"] for e in masks] == list(range(10))
    assert events[-1] == {"type": "done"}
    assert any(e["type"] == "progress" and e["done"] == 10 for e in events)


def test_ground(client):
    c, be, tmp = client
    create(c, tmp)
    res = c.post("/v1/sessions/prj_x-v1/ground", json={"frame_indices": [0, 5, 50], "text": "red car"})
    assert [d["frame_index"] for d in res.json()["detections"]] == [0, 5]
    be.grounding = False
    assert c.post("/v1/sessions/prj_x-v1/ground", json={"frame_indices": [0], "text": "car"}).status_code == 501


def test_api_key(tmp_path, monkeypatch):
    monkeypatch.setenv("INFERENCE_API_KEY", "s3cret")
    c = TestClient(create_app(FakeBackend()))
    assert c.get("/v1/sessions/abc").status_code == 401
    assert c.get("/v1/sessions/abc", headers={"authorization": "Bearer wrong"}).status_code == 401
    assert c.get("/v1/sessions/abc", headers={"authorization": "Bearer s3cret"}).status_code == 404
    assert c.get("/health").status_code == 200
