"""Segmentation backends behind the HTTP API.

`Sam3Backend` runs Meta's SAM 3 through Hugging Face transformers;
`Sam2Backend` wraps Meta's SAM 2 video predictor (install from
https://github.com/facebookresearch/sam2). MODEL_FAMILY picks one (see
make_backend). `Backend` is the interface the API depends on, so tests can run
without PyTorch or a GPU.
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
    def create_session(
        self, session_id: str, video_path: str, mask_width: int, mask_height: int, fps: Optional[float] = None
    ) -> SessionInfo: ...
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


def frame_filters(max_side: int, fps: Optional[float] = None) -> str:
    """FFmpeg filters for SAM 2 input frames.

    With ``fps`` (the rate the web app uses), frame ``i`` is the picture shown at
    ``(i + 0.5) / fps`` — the same grid as services/video/frames.ts — so frame
    indices agree with the app even for variable-frame-rate (phone) video.
    """
    scale = f"scale='if(gt(iw,ih),min({max_side},iw),-2)':'if(gt(iw,ih),-2,min({max_side},ih))'"
    return f"fps={fps!r}:start_time=0,{scale}" if fps and fps > 0 else scale


def extract_frames(video_path: str, out_dir: Path, max_side: int, fps: Optional[float] = None) -> tuple[int, int, int]:
    """Decode frames to JPEGs named 00000.jpg… (the layout SAM 2's init_state expects)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", video_path, "-an", "-sn",
         "-vf", frame_filters(max_side, fps), "-q:v", "2", "-start_number", "0", str(out_dir / "%05d.jpg")],
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

    def create_session(
        self, session_id: str, video_path: str, mask_width: int, mask_height: int, fps: Optional[float] = None
    ) -> SessionInfo:
        if self._status != "ok":
            raise RuntimeError("model not ready")
        frames_dir = self._workdir / session_id
        shutil.rmtree(frames_dir, ignore_errors=True)
        count, w, h = extract_frames(video_path, frames_dir, self._frame_max_side, fps)
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


def _load_frames(frames_dir: Path) -> list:
    from PIL import Image

    out = []
    for path in sorted(frames_dir.glob("*.jpg")):
        with Image.open(path) as im:
            out.append(np.asarray(im.convert("RGB")))
    return out


class Sam3Backend:
    """Meta's SAM 3 through Hugging Face transformers.

    Two models share the session's frames:
      * the SAM 3 tracker (``Sam3TrackerVideoModel``) handles clicks, boxes and
        masks on a frame and propagates them through the video (SAM 2-style
        memory, with SAM 3's stronger image encoder);
      * the SAM 3 detector (``Sam3Model``) does open-vocabulary concept
        detection from text ("red car", "man in a blue shirt"), which replaces
        the separate Grounding DINO model used with SAM 2.

    Weights: https://huggingface.co/facebook/sam3 (accept Meta's SAM license
    there and set HF_TOKEN). Models are injectable for tests.
    """

    def __init__(self, loader=None) -> None:
        self.name = os.environ.get("SAM3_MODEL_ID", "facebook/sam3")
        self.device = "cpu"
        self._status = "loading"
        self._tracker = self._tracker_proc = None
        self._detector = self._detector_proc = None
        self._dtype = None
        self._lock = threading.Lock()  # one GPU job at a time
        self._sessions: "OrderedDict[str, dict]" = OrderedDict()
        self._max_sessions = int(os.environ.get("SAM3_MAX_SESSIONS", os.environ.get("SAM2_MAX_SESSIONS", "2")))
        self._frame_max_side = int(os.environ.get("SAM3_FRAME_MAX_SIDE", "1008"))
        self._det_threshold = float(os.environ.get("SAM3_DETECTION_THRESHOLD", "0.4"))
        self._workdir = Path(os.environ.get("SAM3_WORKDIR", tempfile.gettempdir())) / "opensam-sam3"
        if loader is not None:  # tests: synchronous, injected models
            self._install(*loader())
        else:
            threading.Thread(target=self._load, daemon=True).start()

    # -- lifecycle ---------------------------------------------------------
    def _install(self, tracker, tracker_proc, detector, detector_proc, device: str, dtype) -> None:
        self._tracker, self._tracker_proc = tracker, tracker_proc
        self._detector, self._detector_proc = detector, detector_proc
        self.device, self._dtype = device, dtype
        self._status = "ok"

    def _load(self) -> None:
        try:
            import torch
            from transformers import Sam3Model, Sam3Processor, Sam3TrackerVideoModel, Sam3TrackerVideoProcessor

            device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
            want = os.environ.get("SAM3_DTYPE", "bfloat16" if device == "cuda" else "float32")
            dtype = getattr(torch, want)
            tracker = Sam3TrackerVideoModel.from_pretrained(self.name, dtype=dtype).to(device).eval()
            tracker_proc = Sam3TrackerVideoProcessor.from_pretrained(self.name)
            detector = detector_proc = None
            if os.environ.get("SAM3_TEXT", "1") == "1":
                detector = Sam3Model.from_pretrained(self.name, dtype=dtype).to(device).eval()
                detector_proc = Sam3Processor.from_pretrained(self.name)
            self._install(tracker, tracker_proc, detector, detector_proc, device, dtype)
        except Exception as exc:  # pragma: no cover - depends on the GPU environment
            print(f"[sam3] failed to load: {exc!r}")
            self._status = "error"

    def status(self) -> str:
        return self._status

    def has_grounding(self) -> bool:
        return self._detector is not None

    # -- sessions ----------------------------------------------------------
    def get_session(self, session_id: str) -> Optional[SessionInfo]:
        s = self._sessions.get(session_id)
        if not s:
            return None
        self._sessions.move_to_end(session_id)
        return s["info"]

    def create_session(
        self, session_id: str, video_path: str, mask_width: int, mask_height: int, fps: Optional[float] = None
    ) -> SessionInfo:
        if self._status != "ok":
            raise RuntimeError("model not ready")
        frames_dir = self._workdir / session_id
        shutil.rmtree(frames_dir, ignore_errors=True)
        count, w, h = extract_frames(video_path, frames_dir, self._frame_max_side, fps)
        frames = _load_frames(frames_dir)
        with self._lock:
            state = self._tracker_proc.init_video_session(
                video=frames,
                inference_device=self.device,
                video_storage_device="cpu" if os.environ.get("SAM3_OFFLOAD_VIDEO", "1") == "1" else self.device,
                processing_device="cpu",
                dtype=self._dtype,
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
    def _add_prompt(self, s: dict, kf: Keyframe) -> None:
        info: SessionInfo = s["info"]
        state = s["state"]
        if kf.points or kf.box is not None:
            kwargs: dict = {}
            if kf.points:
                kwargs["input_points"] = [[[[x * info.width, y * info.height] for x, y in kf.points]]]
                kwargs["input_labels"] = [[list(kf.labels)]]
            if kf.box is not None:
                x0, y0, x1, y1 = kf.box
                kwargs["input_boxes"] = [[[x0 * info.width, y0 * info.height, x1 * info.width, y1 * info.height]]]
            self._tracker_proc.add_inputs_to_inference_session(
                inference_session=state, frame_idx=kf.frame_index, obj_ids=1, **kwargs
            )
        elif kf.mask is not None:
            self._tracker_proc.add_inputs_to_inference_session(
                inference_session=state,
                frame_idx=kf.frame_index,
                obj_ids=1,
                input_masks=_resize_bool(kf.mask, info.width, info.height),
            )
        else:
            raise ValueError("keyframe needs points, a box or a mask")

    def _logits(self, s: dict, pred_masks) -> np.ndarray:
        """Model-resolution mask logits → float logits at the client's mask size."""
        info: SessionInfo = s["info"]
        out = self._tracker_proc.post_process_masks(
            [pred_masks], original_sizes=[[info.mask_height, info.mask_width]], binarize=False
        )[0]
        return out[0, 0].float().cpu().numpy()

    def segment(self, session_id: str, kf: Keyframe) -> tuple[np.ndarray, float]:
        import torch

        s = self._sessions[session_id]
        with self._lock, torch.inference_mode():
            s["state"].reset_tracking_data()
            self._add_prompt(s, kf)
            outputs = self._tracker(inference_session=s["state"], frame_idx=kf.frame_index)
            lg = self._logits(s, outputs.pred_masks)
            obj = getattr(outputs, "object_score_logits", None)
        if obj is not None:
            score = float(torch.sigmoid(obj.float().flatten()[0]).item())
        else:
            score = float(1.0 / (1.0 + np.exp(-np.clip(lg[lg > 0].mean() if (lg > 0).any() else lg.max(), -20, 20))))
        return lg > 0, score

    def propagate(self, session_id: str, keyframes: list[Keyframe], start: int, end: int, direction: str) -> Iterator[tuple[int, np.ndarray]]:
        import torch

        s = self._sessions[session_id]
        state = s["state"]
        first = min(k.frame_index for k in keyframes)
        with self._lock, torch.inference_mode():
            state.reset_tracking_data()
            for kf in sorted(keyframes, key=lambda k: k.frame_index):
                self._add_prompt(s, kf)
                self._tracker(inference_session=state, frame_idx=kf.frame_index)
            passes = []
            if direction in ("both", "forward"):
                passes.append((False, end - first))
            if direction in ("both", "backward") and first > start:
                passes.append((True, first - start))
            seen: set[int] = set()
            for reverse, count in passes:
                for out in self._tracker.propagate_in_video_iterator(
                    inference_session=state, start_frame_idx=first, max_frame_num_to_track=count, reverse=reverse
                ):
                    idx = int(out.frame_idx)
                    if start <= idx <= end and idx not in seen:
                        seen.add(idx)
                        yield idx, self._logits(s, out.pred_masks) > 0

    def ground(self, session_id: str, frame_indices: list[int], text: str) -> list[dict]:
        if self._detector is None:
            raise NotImplementedError("SAM 3 text detection disabled (SAM3_TEXT=0)")
        import torch
        from PIL import Image

        s = self._sessions[session_id]
        phrase = text.strip().rstrip(".")
        out: list[dict] = []
        batch = int(os.environ.get("SAM3_GROUND_BATCH", "4"))
        indices = [i for i in frame_indices if (s["dir"] / f"{i:05d}.jpg").exists()]
        for b in range(0, len(indices), batch):
            chunk = indices[b : b + batch]
            images = []
            for idx in chunk:
                with Image.open(s["dir"] / f"{idx:05d}.jpg") as im:
                    images.append(im.convert("RGB"))
            with self._lock, torch.inference_mode():
                inputs = self._detector_proc(images=images, text=[phrase] * len(images), return_tensors="pt").to(self.device)
                if self._dtype is not None and "pixel_values" in inputs:
                    inputs["pixel_values"] = inputs["pixel_values"].to(self._dtype)
                outputs = self._detector(**inputs)
                results = self._detector_proc.post_process_instance_segmentation(
                    outputs,
                    threshold=self._det_threshold,
                    mask_threshold=0.5,
                    target_sizes=[(im.height, im.width) for im in images],
                )
            for idx, image, res in zip(chunk, images, results):
                w, h = image.size
                for box, score in zip(res["boxes"].float().tolist(), res["scores"].float().tolist()):
                    out.append({
                        "frame_index": idx,
                        "box": [max(0.0, box[0] / w), max(0.0, box[1] / h), min(1.0, box[2] / w), min(1.0, box[3] / h)],
                        "score": float(score),
                        "label": phrase,
                    })
        return out


def make_backend() -> Backend:
    """MODEL_FAMILY=sam3 selects SAM 3; anything else keeps SAM 2."""
    family = os.environ.get("MODEL_FAMILY", "sam2").strip().lower()
    return Sam3Backend() if family == "sam3" else Sam2Backend()
