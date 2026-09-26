"""OpenSAM Studio inference server (SAM 2 + optional text grounding).

HTTP contract consumed by services/sam2/SAM2Provider.ts:

  GET    /health                          → {status, model, device, grounding}
  GET    /v1/sessions/{id}                → 200 session | 404
  POST   /v1/sessions                     → create (multipart: meta + video) or JSON {…, video_path}
  POST   /v1/sessions/{id}/ground         → {detections: [{frame_index, box[x0,y0,x1,y1], score, label}]}
  POST   /v1/sessions/{id}/segment        → {frame_index, score, mask: {counts, size: [h, w]}}
  POST   /v1/sessions/{id}/propagate      → NDJSON: progress | mask | error | done
  DELETE /v1/sessions/{id}

Coordinates are normalized (0..1). Masks use row-major RLE (see rle.py) at
the mask size the client requested when creating the session.

Run:  uvicorn app.main:app --host 0.0.0.0 --port 8008
"""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Iterator, Optional

import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError, field_validator

from . import rle
from .backend import Backend, Keyframe, Sam2Backend

SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "2048")) * 1024 * 1024
ALLOW_PATHS_UNDER = os.environ.get("SHARED_STORAGE_ROOT")  # restrict video_path to this directory


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class SessionMeta(BaseModel):
    session_id: str
    mask_width: int = Field(gt=0, le=4096)
    mask_height: int = Field(gt=0, le=4096)
    fps: Optional[float] = Field(default=None, gt=0, le=1000)
    frame_count: Optional[int] = None
    video_path: Optional[str] = None

    @field_validator("session_id")
    @classmethod
    def check_id(cls, v: str) -> str:
        if not SESSION_ID.match(v):
            raise ValueError("invalid session id")
        return v


class MaskIn(BaseModel):
    counts: list[int]
    size: tuple[int, int]


class PromptIn(BaseModel):
    frame_index: int = Field(ge=0)
    points: list[tuple[float, float]] = Field(default_factory=list, max_length=64)
    labels: list[int] = Field(default_factory=list, max_length=64)
    box: Optional[tuple[float, float, float, float]] = None
    mask: Optional[MaskIn] = None

    def to_keyframe(self) -> Keyframe:
        if len(self.points) != len(self.labels):
            raise HTTPException(status_code=422, detail="points and labels differ in length")
        for x, y in self.points:
            if not (0 <= x <= 1 and 0 <= y <= 1):
                raise HTTPException(status_code=422, detail="points must be normalized")
        mask = None
        if self.mask is not None:
            try:
                mask = rle.decode(self.mask.counts, self.mask.size[0], self.mask.size[1])
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
        if not self.points and self.box is None and mask is None:
            raise HTTPException(status_code=422, detail="prompt needs points, a box or a mask")
        return Keyframe(self.frame_index, [tuple(p) for p in self.points], list(self.labels), self.box, mask)


class PropagateIn(BaseModel):
    keyframes: list[PromptIn] = Field(min_length=1, max_length=50)
    start_frame: int = Field(ge=0)
    end_frame: int = Field(ge=0)
    direction: str = "both"


class GroundIn(BaseModel):
    frame_indices: list[int] = Field(min_length=1, max_length=32)
    text: str = Field(min_length=1, max_length=200)


def create_app(backend: Optional[Backend] = None) -> FastAPI:
    app = FastAPI(title="OpenSAM Studio inference server", version="1.0.0")
    app.state.backend = backend or Sam2Backend()
    api_key = os.environ.get("INFERENCE_API_KEY")

    def auth(authorization: Optional[str] = Header(default=None)) -> None:
        if not api_key:
            return
        expected = f"Bearer {api_key}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="invalid credentials")

    def get_backend() -> Backend:
        be: Backend = app.state.backend
        status = be.status()
        if status == "loading":
            raise HTTPException(status_code=503, detail="model loading")
        if status != "ok":
            raise HTTPException(status_code=503, detail="model unavailable")
        return be

    def session_or_404(be: Backend, session_id: str):
        if not SESSION_ID.match(session_id):
            raise HTTPException(status_code=404, detail="unknown session")
        info = be.get_session(session_id)
        if not info:
            raise HTTPException(status_code=404, detail="unknown session")
        return info

    # ------------------------------------------------------------------
    @app.get("/health")
    def health():
        be: Backend = app.state.backend
        return {"status": be.status(), "model": be.name, "device": be.device, "grounding": be.has_grounding()}

    @app.get("/v1/sessions/{session_id}", dependencies=[Depends(auth)])
    def get_session(session_id: str, be: Backend = Depends(get_backend)):
        info = session_or_404(be, session_id)
        return info.__dict__

    @app.post("/v1/sessions", dependencies=[Depends(auth)])
    async def create_session(request: Request, be: Backend = Depends(get_backend)):
        content_type = request.headers.get("content-type", "")
        if content_type.startswith("application/json"):
            try:
                meta = SessionMeta.model_validate(await request.json())
            except ValidationError as exc:
                raise HTTPException(status_code=422, detail="invalid session metadata") from exc
            if not meta.video_path:
                raise HTTPException(status_code=422, detail="video_path required for JSON requests")
            path = Path(meta.video_path).resolve()
            if ALLOW_PATHS_UNDER and not str(path).startswith(str(Path(ALLOW_PATHS_UNDER).resolve()) + os.sep):
                raise HTTPException(status_code=403, detail="video_path outside shared storage")
            if not path.is_file():
                raise HTTPException(status_code=404, detail="video not found")
            info = be.create_session(meta.session_id, str(path), meta.mask_width, meta.mask_height, meta.fps)
            return info.__dict__

        form = await request.form()
        meta_raw = form.get("meta")
        video = form.get("video")
        if not isinstance(meta_raw, str) or video is None or isinstance(video, str):
            raise HTTPException(status_code=422, detail="multipart requires 'meta' and 'video'")
        try:
            meta = SessionMeta.model_validate(json.loads(meta_raw))
        except (ValidationError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid session metadata") from exc
        tmpdir = Path(tempfile.mkdtemp(prefix="opensam-upload-"))
        try:
            dest = tmpdir / "video"
            size = 0
            with dest.open("wb") as fh:
                while chunk := await video.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="video too large")
                    fh.write(chunk)
            info = be.create_session(meta.session_id, str(dest), meta.mask_width, meta.mask_height, meta.fps)
            return info.__dict__
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    @app.delete("/v1/sessions/{session_id}", dependencies=[Depends(auth)])
    def delete_session(session_id: str, be: Backend = Depends(get_backend)):
        if SESSION_ID.match(session_id):
            be.delete_session(session_id)
        return {"ok": True}

    # ------------------------------------------------------------------
    def mask_out(mask: np.ndarray) -> dict:
        return {"counts": rle.encode(mask), "size": [int(mask.shape[0]), int(mask.shape[1])]}

    @app.post("/v1/sessions/{session_id}/segment", dependencies=[Depends(auth)])
    def segment(session_id: str, body: PromptIn, be: Backend = Depends(get_backend)):
        info = session_or_404(be, session_id)
        if body.frame_index >= info.frame_count:
            raise HTTPException(status_code=422, detail="frame out of range")
        mask, score = be.segment(session_id, body.to_keyframe())
        return {"frame_index": body.frame_index, "score": score, "mask": mask_out(mask)}

    @app.post("/v1/sessions/{session_id}/propagate", dependencies=[Depends(auth)])
    def propagate(session_id: str, body: PropagateIn, be: Backend = Depends(get_backend)):
        info = session_or_404(be, session_id)
        if body.direction not in ("both", "forward", "backward"):
            raise HTTPException(status_code=422, detail="invalid direction")
        end = min(body.end_frame, info.frame_count - 1)
        start = min(body.start_frame, end)
        keyframes = [k.to_keyframe() for k in body.keyframes]
        total = end - start + 1

        def stream() -> Iterator[bytes]:
            done = 0
            try:
                for frame_idx, mask in be.propagate(session_id, keyframes, start, end, body.direction):
                    done += 1
                    yield (json.dumps({"type": "mask", "frame_index": int(frame_idx), "counts": rle.encode(mask)}) + "\n").encode()
                    if done % 5 == 0 or done == total:
                        yield (json.dumps({"type": "progress", "done": done, "total": total}) + "\n").encode()
                yield (json.dumps({"type": "progress", "done": total, "total": total}) + "\n").encode()
                yield b'{"type":"done"}\n'
            except Exception as exc:  # report, don't hang the client
                print(f"[propagate] {exc!r}")
                yield (json.dumps({"type": "error", "message": "propagation failed"}) + "\n").encode()

        return StreamingResponse(stream(), media_type="application/x-ndjson")

    @app.post("/v1/sessions/{session_id}/ground", dependencies=[Depends(auth)])
    def ground(session_id: str, body: GroundIn, be: Backend = Depends(get_backend)):
        info = session_or_404(be, session_id)
        if not be.has_grounding():
            return JSONResponse(status_code=501, content={"detail": "grounding not configured"})
        frames = [f for f in body.frame_indices if 0 <= f < info.frame_count]
        return {"detections": be.ground(session_id, frames, body.text)}

    return app


app = create_app() if os.environ.get("OPENSAM_INFERENCE_NO_AUTOLOAD") != "1" else None  # type: ignore[assignment]
