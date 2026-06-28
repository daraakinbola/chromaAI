"""
AI segmentation service — Phase 3 PRD Section 4.3 (backend SAM/SegFormer approach).

Uses nvidia/segformer-b0-finetuned-ade-512-512 for semantic segmentation.
The model is lazy-loaded on first use; subsequent calls reuse the cached pipeline.
ADE20K classes: sky, person / people, building, vegetation, etc.
"""
from __future__ import annotations

import base64
import io
import logging
from typing import Optional

import numpy as np
from PIL import Image

logger = logging.getLogger("chromaai.segmentation")

_pipeline: Optional[object] = None
_pipeline_attempted = False


def _get_pipeline():
    global _pipeline, _pipeline_attempted
    if _pipeline_attempted:
        return _pipeline
    _pipeline_attempted = True
    try:
        from transformers import pipeline as hf_pipeline
        logger.info("Loading segmentation model (nvidia/segformer-b0-finetuned-ade-512-512)…")
        _pipeline = hf_pipeline(
            "image-segmentation",
            model="nvidia/segformer-b0-finetuned-ade-512-512",
        )
        logger.info("Segmentation model ready.")
    except Exception as exc:
        logger.warning("Segmentation model unavailable: %s", exc)
        _pipeline = None
    return _pipeline


def _decode_data_url(data_url: str) -> Image.Image:
    _header, encoded = data_url.split(",", 1)
    return Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")


def _mask_to_png_data_url(mask_arr: np.ndarray) -> str:
    img = Image.fromarray(mask_arr.astype(np.uint8), mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/png;base64,{b64}"


def _run_segmentation(data_url: str, target_labels: list[str]) -> tuple[str, int, int]:
    img = _decode_data_url(data_url)
    orig_w, orig_h = img.size

    pipe = _get_pipeline()
    if pipe is None:
        # Fallback when the model cannot be loaded: return full-white mask
        fallback = np.full((orig_h, orig_w), 255, dtype=np.uint8)
        return _mask_to_png_data_url(fallback), orig_w, orig_h

    results = pipe(img)
    mask = np.zeros((orig_h, orig_w), dtype=np.uint8)
    for seg in results:
        label: str = (seg.get("label") or "").lower()
        if any(t in label for t in target_labels):
            seg_pil: Image.Image = seg["mask"]
            seg_arr = np.array(seg_pil)
            if seg_arr.shape[:2] != (orig_h, orig_w):
                seg_arr = np.array(
                    Image.fromarray(seg_arr).resize((orig_w, orig_h), Image.NEAREST)
                )
            mask = np.maximum(mask, (seg_arr > 128).astype(np.uint8) * 255)

    return _mask_to_png_data_url(mask), orig_w, orig_h


def generate_subject_mask(data_url: str) -> tuple[str, int, int]:
    """Segment the primary subject (person). Returns (png_data_url, width, height)."""
    return _run_segmentation(
        data_url,
        ["person", "people", "man", "woman", "child", "human", "face", "body"],
    )


def generate_sky_mask(data_url: str) -> tuple[str, int, int]:
    """Segment sky. Returns (png_data_url, width, height)."""
    return _run_segmentation(data_url, ["sky"])


def generate_background_mask(data_url: str) -> tuple[str, int, int]:
    """Background = inverse of subject mask."""
    png, w, h = generate_subject_mask(data_url)
    _hdr, enc = png.split(",", 1)
    arr = np.array(Image.open(io.BytesIO(base64.b64decode(enc))).convert("L"))
    inverted = (255 - arr).astype(np.uint8)
    return _mask_to_png_data_url(inverted), w, h
