"""
AI mask generation endpoints — Phase 3 PRD Section 4.3 (backend SAM approach).
Subject and sky detection via transformers/SegFormer on the FastAPI server.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/masks", tags=["masks"])


class MaskRequest(BaseModel):
    data_url: str  # base64-encoded image data URL


class MaskResponse(BaseModel):
    mask_png: str  # grayscale PNG data URL
    width: int
    height: int


@router.post("/subject", response_model=MaskResponse)
async def subject_mask(req: MaskRequest):
    """Generate a subject (person) segmentation mask."""
    try:
        from services.segmentation import generate_subject_mask
        png, w, h = generate_subject_mask(req.data_url)
        return MaskResponse(mask_png=png, width=w, height=h)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Subject mask failed: {exc}")


@router.post("/sky", response_model=MaskResponse)
async def sky_mask(req: MaskRequest):
    """Generate a sky segmentation mask."""
    try:
        from services.segmentation import generate_sky_mask
        png, w, h = generate_sky_mask(req.data_url)
        return MaskResponse(mask_png=png, width=w, height=h)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Sky mask failed: {exc}")


@router.post("/background", response_model=MaskResponse)
async def background_mask(req: MaskRequest):
    """Generate a background mask (inverse of subject)."""
    try:
        from services.segmentation import generate_background_mask
        png, w, h = generate_background_mask(req.data_url)
        return MaskResponse(mask_png=png, width=w, height=h)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Background mask failed: {exc}")
