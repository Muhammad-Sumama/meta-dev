"""SAM 3 alone vs. SAM 3 + OpenSAM Studio post-processing, on DAVIS-style data.

    python -m bench.sam3_bench --data /data/DAVIS --split val --out results.json

Layout (DAVIS 2017 semi-supervised): ``JPEGImages/480p/<seq>/00000.jpg`` and
``Annotations/480p/<seq>/00000.png`` (palette PNG, one index per object), plus
``ImageSets/2017/<split>.txt``. Any folder with the same structure works, so
you can add your own clips (hair, fur, motion blur…) next to DAVIS.

Protocol per sequence and object: the first-frame ground-truth mask is given
to the SAM 3 tracker, which propagates it through the clip. Each variant is
scored with the standard DAVIS metrics:

  J  region similarity (IoU)
  F  boundary F-measure (tolerance 0.8% of the image diagonal)

Variants (all from the same SAM 3 logits, so differences are post-processing
only):

  sam3            threshold SAM 3's mask logits at 0 (what SAM 3 returns)
  +refine         colour guided-filter edge refinement (OpenSAM export path)
  +temporal       boundary-band temporal median over ±1 frame
  +refine+temporal

Report the numbers as they come out; a variant only "beats SAM 3" on a dataset
if its J&F is higher there.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from app.backend import Keyframe, Sam3Backend
from app.refine import guided_refine, temporal_smooth


# ---------------------------------------------------------------------------
# Metrics (DAVIS definitions)
# ---------------------------------------------------------------------------
def j_score(pred: np.ndarray, gt: np.ndarray) -> float:
    inter = np.logical_and(pred, gt).sum()
    union = np.logical_or(pred, gt).sum()
    return 1.0 if union == 0 else float(inter / union)


def _boundary(mask: np.ndarray) -> np.ndarray:
    m = mask.astype(bool)
    pad = np.pad(m, 1)
    inner = pad[1:-1, 1:-1] & pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:]
    return m & ~inner


def _dilate(mask: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return mask
    h, w = mask.shape
    c = np.pad(mask.astype(np.int32), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    y0 = np.clip(np.arange(h) - r, 0, h)
    y1 = np.clip(np.arange(h) + r + 1, 0, h)
    x0 = np.clip(np.arange(w) - r, 0, w)
    x1 = np.clip(np.arange(w) + r + 1, 0, w)
    return (c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]) > 0


def f_score(pred: np.ndarray, gt: np.ndarray, bound_th: float = 0.008) -> float:
    h, w = gt.shape
    r = max(1, int(np.ceil(bound_th * np.hypot(h, w))))
    pb, gb = _boundary(pred), _boundary(gt)
    if not pb.any() and not gb.any():
        return 1.0
    if not pb.any() or not gb.any():
        return 0.0
    precision = (pb & _dilate(gb, r)).sum() / pb.sum()
    recall = (gb & _dilate(pb, r)).sum() / gb.sum()
    return 0.0 if precision + recall == 0 else float(2 * precision * recall / (precision + recall))


# ---------------------------------------------------------------------------
def load_sequence(root: Path, res: str, seq: str):
    from PIL import Image

    frames = sorted((root / "JPEGImages" / res / seq).glob("*.jpg"))
    annos = {p.stem: p for p in (root / "Annotations" / res / seq).glob("*.png")}
    rgb = [np.asarray(Image.open(p).convert("RGB")) for p in frames]
    gts = [np.asarray(Image.open(annos[p.stem])) if p.stem in annos else None for p in frames]
    return frames, rgb, gts


def frames_to_video(frames: list[Path], out: Path, fps: int = 24) -> None:
    """The backend ingests videos; pack the JPEGs losslessly-enough into one."""
    import os
    import subprocess

    ffmpeg = os.environ.get("FFMPEG_PATH", "ffmpeg")
    subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(fps), "-i", str(frames[0].parent / "%05d.jpg"),
         "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv444p", str(out)],
        check=True,
    )


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -30, 30)))


def run(args, be: Sam3Backend | None = None) -> dict:
    root = Path(args.data)
    seqs = (root / "ImageSets" / "2017" / f"{args.split}.txt").read_text().split() if not args.sequences else args.sequences
    be = be or Sam3Backend()
    while be.status() == "loading":
        time.sleep(1)
    if be.status() != "ok":
        sys.exit("SAM 3 failed to load (accept the license at huggingface.co/facebook/sam3 and set HF_TOKEN)")

    variants = ["sam3", "+refine", "+temporal", "+refine+temporal"]
    rows = []
    for seq in seqs[: args.limit or None]:
        frames, rgb, gts = load_sequence(root, args.res, seq)
        h, w = rgb[0].shape[:2]
        video = Path(args.workdir) / f"{seq}.mp4"
        video.parent.mkdir(parents=True, exist_ok=True)
        frames_to_video(frames, video)
        sid = f"bench_{seq}"
        be.create_session(sid, str(video), w, h, None)
        s = be._sessions[sid]
        objects = [int(o) for o in np.unique(gts[0]) if o not in (0, 255)]
        for obj in objects:
            t0 = time.time()
            logits: dict[int, np.ndarray] = {}
            # Same propagation as the app, but keep the logits for soft alphas.
            import torch

            with be._lock, torch.inference_mode():
                s["state"].reset_tracking_data()
                be._add_prompt(s, Keyframe(0, mask=gts[0] == obj))
                be._tracker(inference_session=s["state"], frame_idx=0)
                for out in be._tracker.propagate_in_video_iterator(inference_session=s["state"], start_frame_idx=0):
                    logits[int(out.frame_idx)] = be._logits(s, out.pred_masks)
            n = len(frames)
            soft = [sigmoid(logits.get(i, np.full((h, w), -30.0, np.float32))) for i in range(n)]
            radius = args.radius or max(2, round(h / 72))
            refined = [guided_refine(a, rgb[i], radius) for i, a in enumerate(soft)]
            alphas = {
                "sam3": soft,
                "+refine": refined,
                "+temporal": temporal_smooth(soft, args.window),
                "+refine+temporal": temporal_smooth(refined, args.window),
            }
            for v in variants:
                js, fs = [], []
                for i in range(1, n):  # frame 0 is the given mask
                    if gts[i] is None:
                        continue
                    gt = gts[i] == obj
                    pred = alphas[v][i] > 0.5
                    js.append(j_score(pred, gt))
                    fs.append(f_score(pred, gt))
                rows.append({"sequence": seq, "object": obj, "variant": v, "J": float(np.mean(js)), "F": float(np.mean(fs))})
            print(f"{seq}#{obj}: " + "  ".join(
                f"{r['variant']} J&F {(r['J'] + r['F']) / 2:.4f}" for r in rows[-len(variants):]
            ) + f"  ({time.time() - t0:.1f}s)", flush=True)
        be.delete_session(sid)

    summary = {}
    for v in variants:
        sel = [r for r in rows if r["variant"] == v]
        J = float(np.mean([r["J"] for r in sel])) if sel else 0.0
        F = float(np.mean([r["F"] for r in sel])) if sel else 0.0
        summary[v] = {"J": J, "F": F, "J&F": (J + F) / 2, "objects": len(sel)}
    return {"model": be.name, "dataset": str(root), "split": args.split, "summary": summary, "rows": rows}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", required=True, help="DAVIS-style dataset root")
    p.add_argument("--split", default="val")
    p.add_argument("--res", default="480p")
    p.add_argument("--sequences", nargs="*", help="only these sequences")
    p.add_argument("--limit", type=int, default=0, help="first N sequences")
    p.add_argument("--radius", type=int, default=0, help="guided filter radius (default ≈ H/72)")
    p.add_argument("--window", type=int, default=1, help="temporal median half-window")
    p.add_argument("--workdir", default="/tmp/opensam-bench")
    p.add_argument("--out", default="sam3_bench.json")
    return p.parse_args(argv)


def main(argv=None) -> None:
    args = parse_args(argv)
    result = run(args)
    Path(args.out).write_text(json.dumps(result, indent=2))
    print("\nvariant            J       F       J&F")
    base = result["summary"]["sam3"]["J&F"]
    for v, s in result["summary"].items():
        print(f"{v:<18} {s['J']:.4f}  {s['F']:.4f}  {s['J&F']:.4f}  ({(s['J&F'] - base) * 100:+.2f} vs SAM 3)")


if __name__ == "__main__":
    main()
