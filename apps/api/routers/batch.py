"""
Batch processing — grade adaptation and consistency analysis (Section 6).
"""
import math
from fastapi import APIRouter
from models.schemas import (
    AdjustmentDelta,
    BatchAdaptRequest,
    BatchAdaptResponse,
    ImageAdjustmentResult,
)

router = APIRouter(prefix="/batch", tags=["batch"])


@router.post("/adapt-grade", response_model=BatchAdaptResponse)
async def adapt_grade(req: BatchAdaptRequest) -> BatchAdaptResponse:
    """
    Given a source grade and per-image luminance/color-temp stats, return
    per-image AdjustmentState deltas that preserve the creative intent of the
    grade while compensating for technical exposure and white-balance differences.

    Core logic (spec Section 6.3):
    - Exposure delta: compensate for natural luminance difference between images.
      An image that is naturally 1 stop brighter has its exposure correction
      reduced by 1 stop.
    - Temperature delta: 50 % correction for natural WB difference, preserving
      creative temperature intent.
    """
    src_lum = req.source_stats.luminance
    src_temp = req.source_stats.colorTemperature
    results: list[ImageAdjustmentResult] = []

    for target in req.targets:
        delta = AdjustmentDelta()

        # Exposure correction — log2 luminance ratio gives stop difference
        if src_lum > 0.001 and target.luminance > 0.001:
            stops_diff = math.log2(src_lum / target.luminance)
            # Clamp to ±5 stops (full exposure range)
            delta.exposure = max(-5.0, min(5.0, stops_diff))

        # Temperature correction — apply 50 % to preserve creative WB intent
        temp_diff = src_temp - target.colorTemperature
        delta.temperature = max(-3500.0, min(3500.0, temp_diff * 0.5))

        results.append(ImageAdjustmentResult(image_id=target.image_id, delta=delta))

    return BatchAdaptResponse(adjustments=results)
