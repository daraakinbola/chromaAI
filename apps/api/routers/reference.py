"""
Reference image extraction — server-side fallback (spec Section 4.4 / 6.5).

Client-side extraction (referenceExtract.ts) runs first. This endpoint is
called only when client-side canvas analysis fails (e.g., CORS-blocked image).
Uses Pillow + numpy to replicate the same 7-step algorithm.
"""
import base64
import io
import math
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import numpy as np
from PIL import Image

router = APIRouter(prefix="/reference", tags=["reference"])


class ReferenceExtractRequest(BaseModel):
    data_url: str  # base64 data URL, e.g. "data:image/jpeg;base64,..."


class ColorProfileResponse(BaseModel):
    averageTemperature: float
    averageSaturation: float
    contrastRatio: float
    shadowHue: list[float]      # [R, G, B] 0-255
    midtoneHue: list[float]
    highlightHue: list[float]
    exposureBias: float
    toneCurveShape: str         # flat | lifted_blacks | crushed_blacks | high_contrast | low_contrast


def _rb_ratio_to_kelvin(r_avg: float, b_avg: float) -> float:
    if b_avg == 0:
        return 2000.0
    ratio = r_avg / b_avg
    clamped = max(0.5, min(3.0, ratio))
    t = (clamped - 0.5) / 2.5
    return max(2000.0, min(50000.0, 10000.0 - t * 8000.0))


def _infer_tone_curve(shadow_mean_l: float, highlight_mean_l: float, std_dev: float) -> str:
    if shadow_mean_l > 50:
        return "lifted_blacks"
    if shadow_mean_l < 15 and highlight_mean_l > 200:
        return "crushed_blacks"
    if std_dev > 80:
        return "high_contrast"
    if std_dev < 30:
        return "low_contrast"
    return "flat"


def _rgb_to_hsl_s(r: float, g: float, b: float) -> float:
    """Return only the S component of RGB→HSL (0-1)."""
    rn, gn, bn = r / 255, g / 255, b / 255
    max_c = max(rn, gn, bn)
    min_c = min(rn, gn, bn)
    l = (max_c + min_c) / 2
    if max_c == min_c:
        return 0.0
    d = max_c - min_c
    return d / (2 - max_c - min_c) if l > 0.5 else d / (max_c + min_c)


@router.post("/extract", response_model=ColorProfileResponse)
async def extract_reference(req: ReferenceExtractRequest) -> ColorProfileResponse:
    """
    Spec Section 4.4: decode reference image to 400×400, analyse pixel
    distribution, and return ColorProfile.
    """
    try:
        # Strip data URL prefix
        header, _, b64 = req.data_url.partition(",")
        if not b64:
            raise ValueError("data_url has no base64 payload")
        raw = base64.b64decode(b64)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not decode image: {exc}") from exc

    # Step 1: downsample to 400×400
    img = img.resize((400, 400), Image.LANCZOS)
    pixels = np.array(img, dtype=np.float32)   # (400, 400, 3)
    R, G, B = pixels[:, :, 0], pixels[:, :, 1], pixels[:, :, 2]

    # Step 2: luminance histogram (BT.601)
    L = 0.299 * R + 0.587 * G + 0.114 * B    # (400, 400)

    # Step 3: bucket by luminance threshold
    shadow_mask    = L < 85
    highlight_mask = L > 170
    midtone_mask   = ~shadow_mask & ~highlight_mask

    def bucket_avg(mask: np.ndarray) -> list[float]:
        if not mask.any():
            return [128.0, 128.0, 128.0]
        return [
            float(R[mask].mean()),
            float(G[mask].mean()),
            float(B[mask].mean()),
        ]

    shadow_hue    = bucket_avg(shadow_mask)
    midtone_hue   = bucket_avg(midtone_mask)
    highlight_hue = bucket_avg(highlight_mask)

    # Step 4: temperature from highlight R/B ratio
    avg_temperature = _rb_ratio_to_kelvin(highlight_hue[0], highlight_hue[2])

    # Step 5: average HSL saturation across all pixels
    sat_vals = np.vectorize(_rgb_to_hsl_s)(R, G, B)
    avg_saturation = float(sat_vals.mean())

    # Contrast ratio
    shadow_avg_l    = float(L[shadow_mask].mean())    if shadow_mask.any()    else 0.0
    highlight_avg_l = float(L[highlight_mask].mean()) if highlight_mask.any() else 255.0
    contrast_ratio  = (highlight_avg_l / shadow_avg_l) if shadow_avg_l > 0 else highlight_avg_l

    # Exposure bias
    avg_l = float(L.mean())
    exposure_bias = (avg_l - 127.5) / 127.5

    # Step 6: tone curve shape
    std_dev = float(L.std())
    tone_curve_shape = _infer_tone_curve(shadow_avg_l, highlight_avg_l, std_dev)

    return ColorProfileResponse(
        averageTemperature=round(avg_temperature),
        averageSaturation=round(avg_saturation, 4),
        contrastRatio=round(contrast_ratio, 3),
        shadowHue=shadow_hue,
        midtoneHue=midtone_hue,
        highlightHue=highlight_hue,
        exposureBias=round(exposure_bias, 4),
        toneCurveShape=tone_curve_shape,
    )
