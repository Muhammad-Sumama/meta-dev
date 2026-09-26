"""Segmentation backends behind the HTTP API.

`Sam2Backend` wraps Meta's SAM 2 video predictor (install from
https://github.com/facebookresearch/sam2). `Backend` is the interface the API
depends on, so tests can run without PyTorch or a GPU.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional, Protocol

import numpy as np


@dataclass
class Keyframe:
    frame_index: int
    points: list[tuple[float, float]] = field(default_factory=list)  # normalized 0..1
    labels: list[int] = field(default_factory=list)
    box: Optional[tuple[float, float, float, float]] = None  # normalized x0,y0,x1,y1
    mask: Optional[np.ndarray] = None  # bool, any size (resized to frames)


@dataclass
class SessionInfo:
    session_id: str
    frame_count: int
    width: int  # frame width used by the model
    height: int
    mask_width: int  # size of masks returned to the client
    mask_height: int


class Backend(Protocol):
    name: str
    device: str

    def status(self) -> str: ...
    def has_grounding(self) -> bool: ...
    def get_session(self, session_id: str) -> Optional[SessionInfo]: ...
    def create_session(self, session_id: str, video_path: str, mask_width: int, mask_height: int) -> SessionInfo: ...
    def delete_session(self, session_id: str) -> None: ...
    def segment(self, session_id: str, kf: Keyframe) -> tuple[np.ndarray, float]: ...
    def propagate(
        self, session_id: str, keyframes: list[Keyframe], start: int, end: int, direction: str
    ) -> Iterator[tuple[int, np.ndarray]]: ...
    def ground(self, session_id: str, frame_indices: list[int], text: str) -> list[dict]: ...


def _resize_bool(mask: np.ndarray, width: int, height: int) -> np.ndarray:
    if mask.shape == (height, width):
        return mask.astype(bool)
    from PIL import Image

    img = Image.fromarray(mask.astype(np.uint8) * 255)
    return np.asarray(img.resize((width, height), Image.BILINEAR)) >= 128


def _resize_logits(logits: np.ndarray, width: int, height: int) -> np.ndarray:
    """Resize float logits with bilinear filtering, then threshold at 0."""
    if logits.shape == (height, width):
        return logits > 0
    from PIL import Image

    img = Image.fromarray(logits.astype(np.float32), mode="F")
    return np.asarray(img.resize((width, height), Image.BILINEAR)) > 0


def extract_frames(video_path: str, out_dir: Path, max_side: int) -> tuple[int, int, int]:
    """Decode frames to JPEGs named 00000.jpg… (the layout SAM 2's init_state expects)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    scale = f"scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))'"
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video_path, "-vf", scale,
         "-q:v", "2", "-start_number", "0", str(out_dir / "%05d.jpg")],
        check=True,
    )
    frames = sorted(out_dir.glob("*.jpg"))
    if not frames:
        raise RuntimeError("no frames decoded")
    from PIL import Image

    with Image.open(frames[0]) as im:
        w, h = im.size
    return len(frames), w, h


class Sam2Backend:
    """SAM 2 video predictor with per-video sessions (LRU, bounded)."""

    def __init__(self) -> None:
        self.name = os.environ.get("SAM2_MODEL_ID", "facebook/sam2.1-hiera-large")
        self.device = "cpu"
        self._status = "loading"
        self._predictor = None
        self._grounding = None
        self._lock = threading.Lock()  # one GPU job at a time
        self._sessions: "OrderedDict[str, dict]" = OrderedDict()
        self._max_sessions = int(os.environ.get("SAM2_MAX_SESSIONS", "2"))
        self._frame_max_side = int(os.environ.get("SAM2_FRAME_MAX_SIDE", "1024"))
        self._workdir = Path(os.environ.get("SAM2_WORKDIR", tempfile.gettempdir())) / "opensam-sam2"
        threading.Thread(target=self._load, daemon=True).start()

    # -- lifecycle ---------------------------------------------------------
    def _load(self) -> None:
        try:
            import torch

            self.device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
            config = os.environ.get("SAM2_CONFIG")
            checkpoint = os.environ.get("SAM2_CHECKPOINT")
            if config and checkpoint:
                from sam2.build_sam import build_sam2_video_predictor

                self._predictor = build_sam2_video_predictor(config, checkpoint, device=self.device)
                self.name = Path(checkpoint).stem
            else:
                from sam2.sam2_video_predictor import SAM2VideoPredictor

                self._predictor = SAM2VideoPredictor.from_pretrained(self.name, device=self.device)
            grounding_id = os.environ.get("GROUNDING_MODEL")
            if grounding_id:
                from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

                self._grounding = (
                    AutoProcessor.from_pretrained(grounding_id),
                    AutoModelForZeroShotObjectDetection.from_pretrained(grounding_id).to(self.device),
                )
            self._status = "ok"
        except Exception as exc:  # pragma: no cover - depends on the GPU environment
            print(f"[sam2] failed to load: {exc!r}")
            self._status = "error"

    def status(self) -> str:
        return self._status

    def has_grounding(self) -> bool:
        return self._grounding is not None

    # -- sessions ----------------------------------------------------------
    def get_session(self, session_id: str) -> Optional[SessionInfo]:
        s = self._sessions.get(session_id)
        if not s:
            return None
        self._sessions.move_to_end(session_id)
        return s["info"]

    def create_session(self, session_id: str, video_path: str, mask_width: int, mask_height: int) -> SessionInfo:
        if self._status != "ok":
            raise RuntimeError("model not ready")
        frames_dir = self._workdir / session_id
        shutil.rmtree(frames_dir, ignore_errors=True)
        count, w, h = extract_frames(video_path, frames_dir, self._frame_max_side)
        with self._lock:
            state = self._predictor.init_state(
                video_path=str(frames_dir),
                offload_video_to_cpu=os.environ.get("SAM2_OFFLOAD_VIDEO", "1") == "1",
            )
        info = SessionInfo(session_id, count, w, h, mask_width, mask_height)
        self._sessions[session_id] = {"info": info, "state": state, "dir": frames_dir}
        while len(self._sessions) > self._max_sessions:
            _, old = self._sessions.popitem(last=False)
            shutil.rmtree(old["dir"], ignore_errors=True)
        return info

    def delete_session(self, session_id: str) -> None:
        s = self._sessions.pop(session_id, None)
        if s:
            shutil.rmtree(s["dir"], ignore_errors=True)

    # -- inference -----------------------------------------------------------
    def _add_prompt(self, s: dict, kf: Keyframe):
        info: SessionInfo = s["info"]
        state = s["state"]
        if kf.points or kf.box is not None:
            points = np.array([[x * info.width, y * info.height] for x, y in kf.points], dtype=np.float32) if kf.points else None
            labels = np.array(kf.labels, dtype=np.int32) if kf.points else None
            box = (
                np.array([kf.box[0] * info.width, kf.box[1] * info.height, kf.box[2] * info.width, kf.box[3] * info.height], dtype=np.float32)
                if kf.box is not None
                else None
            )
            return self._predictor.add_new_points_or_box(
                inference_state=state, frame_idx=kf.frame_index, obj_id=1, points=points, labels=labels, box=box
            )
        if kf.mask is not None:
            return self._predictor.add_new_mask(
                inference_state=state, frame_idx=kf.frame_index, obj_id=1, mask=_resize_bool(kf.mask, info.width, info.height)
            )
        raise ValueError("keyframe needs points, a box or a mask")

    def segment(self, session_id: str, kf: Keyframe) -> tuple[np.ndarray, float]:
        s = self._sessions[session_id]
        info: SessionInfo = s["info"]
        with self._lock:
            self._predictor.reset_state(s["state"])
            _, _, logits = self._add_prompt(s, kf)
        lg = logits[0, 0].float().cpu().numpy()
        mask = _resize_logits(lg, info.mask_width, info.mask_height)
        score = float(1.0 / (1.0 + np.exp(-np.clip(lg[lg > 0].mean() if (lg > 0).any() else lg.max(), -20, 20))))
        return mask, score

    def propagate(self, session_id: str, keyframes: list[Keyframe], start: int, end: int, direction: str) -> Iterator[tuple[int, np.ndarray]]:
        s = self._sessions[session_id]
        info: SessionInfo = s["info"]
        state = s["state"]
        first = min(k.frame_index for k in keyframes)
        with self._lock:
            self._predictor.reset_state(state)
            for kf in keyframes:
                self._add_prompt(s, kf)
            passes = []
            if direction in ("both", "forward"):
                passes.append((False, end - first))
            if direction in ("both", "backward") and first > start:
                passes.append((True, first - start))
            for reverse, count in passes:
                for frame_idx, _obj_ids, logits in self._predictor.propagate_in_video(
                    state, start_frame_idx=first, max_frame_num_to_track=count, reverse=reverse
                ):
                    if start <= frame_idx <= end:
                        yield frame_idx, _resize_logits(logits[0, 0].float().cpu().numpy(), info.mask_width, info.mask_height)

    def ground(self, session_id: str, frame_indices: list[int], text: str) -> list[dict]:
        if not self._grounding:
            raise NotImplementedError("grounding model not configured")
        import torch
        from PIL import Image

        processor, model = self._grounding
        s = self._sessions[session_id]
        prompt = text.strip().lower().rstrip(".") + "."
        out: list[dict] = []
        for idx in frame_indices:
            path = s["dir"] / f"{idx:05d}.jpg"
            if not path.exists():
                continue
            with Image.open(path) as im:
                image = im.convert("RGB")
            inputs = processor(images=image, text=prompt, return_tensors="pt").to(self.device)
            with torch.no_grad():
                outputs = model(**inputs)
            try:
                results = processor.post_process_grounded_object_detection(
                    outputs, inputs.input_ids, threshold=0.3, text_threshold=0.25, target_sizes=[image.size[::-1]]
                )[0]
            except TypeError:  # older transformers
                results = processor.post_process_grounded_object_detection(
                    outputs, inputs.input_ids, box_threshold=0.3, text_threshold=0.25, target_sizes=[image.size[::-1]]
                )[0]
            w, h = image.size
            for box, score in zip(results["boxes"].tolist(), results["scores"].tolist()):
                out.append({
                    "frame_index": idx,
                    "box": [box[0] / w, box[1] / h, box[2] / w, box[3] / h],
                    "score": float(score),
                    "label": text,
                })
        return out
