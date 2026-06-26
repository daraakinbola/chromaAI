import time
import base64
from pathlib import Path
from fastapi import APIRouter, HTTPException
from models.schemas import (
    ApplyGradeRequest,
    ApplyGradeResponse,
    SceneAnalysis,
    SessionGenre,
)
from services import ai_engine

router = APIRouter(prefix="/grade", tags=["grade"])

UPLOAD_DIR = Path("uploads")


@router.post("/apply", response_model=ApplyGradeResponse)
async def apply_grade(req: ApplyGradeRequest):
    """
    Apply adjustment stack to an image and return a preview URL.
    Non-destructive: original is never modified.
    """
    # Stub: real implementation uses color_science pipeline + Pillow render
    start = time.perf_counter()
    # Simulate sub-200ms render
    elapsed_ms = int((time.perf_counter() - start) * 1000) + 85
    preview_url = f"/previews/{req.image_id}/preview.jpg"
    return ApplyGradeResponse(preview_url=preview_url, render_time_ms=elapsed_ms)


@router.get("/analyze/{image_id}", response_model=SceneAnalysis)
async def analyze_image(image_id: str, genre: SessionGenre | None = None):
    """
    Run semantic scene analysis on an uploaded image.
    Returns subject classification, lighting, skin tone detection, mood baseline.
    """
    # Find the image file
    matches = list(UPLOAD_DIR.glob(f"{image_id}.*"))
    if not matches:
        raise HTTPException(404, "Image not found")

    img_path = matches[0]
    suffix = img_path.suffix.lower()

    # Only send JPEG/PNG to the vision model; RAW needs demosaicing first
    if suffix in {".jpg", ".jpeg", ".png"}:
        with img_path.open("rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        return await ai_engine.analyze_scene(b64, genre)
    else:
        # Stub for RAW formats — real impl runs libraw demosaic first
        return SceneAnalysis(
            subject="unknown (RAW demosaic pending)",
            lighting_condition="unknown",
            has_skin_tones=False,
            mood_baseline="neutral",
            color_temperature_estimate=5500.0,
            confidence=0.0,
        )
