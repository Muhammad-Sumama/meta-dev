"""Tiny, randomly initialised SAM 3 models and processors.

They exercise Sam3Backend's calls into transformers (argument names, tensor
shapes, sessions, propagation, post-processing) without downloading weights or
needing a GPU. Their outputs are noise; tests check plumbing, not quality.
"""

from __future__ import annotations

import json
import string
import tempfile
from pathlib import Path

SIZE = 224  # 16×16 patches of 14 px
FEAT = [[64, 64], [32, 32], [16, 16]]


def _shrink_vision(vc) -> None:
    bb = vc.backbone_config
    for k, v in dict(hidden_size=64, intermediate_size=128, num_hidden_layers=2, num_attention_heads=2,
                     image_size=SIZE, pretrain_image_size=SIZE, window_size=8, global_attn_indexes=[1]).items():
        setattr(bb, k, v)
    vc.backbone_feature_sizes = FEAT


def _image_processor():
    from transformers import Sam3ImageProcessor

    return Sam3ImageProcessor(size={"height": SIZE, "width": SIZE})


def tracker():
    """(Sam3TrackerVideoModel, Sam3TrackerVideoProcessor)"""
    from transformers import Sam3TrackerVideoConfig, Sam3TrackerVideoModel, Sam3TrackerVideoProcessor
    from transformers.models.sam2_video.video_processing_sam2_video import Sam2VideoVideoProcessor

    cfg = Sam3TrackerVideoConfig()
    _shrink_vision(cfg.vision_config)
    cfg.image_size = SIZE
    cfg.prompt_encoder_config.image_size = SIZE
    cfg.memory_attention_rope_feat_sizes = FEAT[2]
    cfg.memory_attention_num_layers = 1
    cfg.memory_fuser_num_layers = 1
    model = Sam3TrackerVideoModel(cfg).eval()
    proc = Sam3TrackerVideoProcessor(
        image_processor=_image_processor(),
        video_processor=Sam2VideoVideoProcessor(size={"height": SIZE, "width": SIZE}),
        target_size=SIZE,
    )
    return model, proc


def _tokenizer():
    """A character-level CLIP BPE tokenizer (no merges) built offline."""
    from transformers import CLIPTokenizer

    d = Path(tempfile.mkdtemp(prefix="tiny-clip-"))
    chars = list(string.ascii_lowercase + string.digits + ".,'-")
    vocab = {"<|startoftext|>": 0, "<|endoftext|>": 1}
    for c in chars:
        vocab.setdefault(c, len(vocab))
        vocab.setdefault(c + "</w>", len(vocab))
    (d / "vocab.json").write_text(json.dumps(vocab))
    (d / "merges.txt").write_text("#version: 0.2\n")
    return CLIPTokenizer(vocab_file=str(d / "vocab.json"), merges_file=str(d / "merges.txt"), pad_token="<|endoftext|>"), len(vocab)


def detector():
    """(Sam3Model, Sam3Processor)"""
    from transformers import Sam3Config, Sam3Model, Sam3Processor

    tok, vocab_size = _tokenizer()
    cfg = Sam3Config()
    _shrink_vision(cfg.vision_config)
    tc = cfg.text_config
    for k, v in dict(vocab_size=vocab_size, hidden_size=64, intermediate_size=128, num_hidden_layers=2,
                     num_attention_heads=2, pad_token_id=1, bos_token_id=0, eos_token_id=1).items():
        setattr(tc, k, v)
    for sub in (cfg.geometry_encoder_config, cfg.detr_encoder_config, cfg.detr_decoder_config):
        sub.num_layers = 1
    cfg.detr_decoder_config.num_queries = 16
    model = Sam3Model(cfg).eval()
    proc = Sam3Processor(image_processor=_image_processor(), tokenizer=tok, target_size=SIZE)
    return model, proc


def loader():
    """Sam3Backend(loader=...) hook."""
    import torch

    t, tp = tracker()
    d, dp = detector()
    return t, tp, d, dp, "cpu", torch.float32


if __name__ == "__main__":
    t, _ = tracker()
    d, _ = detector()
    print(f"tracker {sum(p.numel() for p in t.parameters()) / 1e6:.1f}M, detector {sum(p.numel() for p in d.parameters()) / 1e6:.1f}M params")
