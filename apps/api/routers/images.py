import uuid
import shutil
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException
from models.schemas import ImageMeta, BatchAnalysisResponse, BatchConsistencyItem
import random

router = APIRouter(prefix="/images", tags=["images"])

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

# In-memory store (replace with DB)
_images: dict[str, ImageMeta] = {}


@router.get("", response_model=list[ImageMeta])
async def list_images():
    return list(_images.values())


@router.post("/upload", response_model=ImageMeta)
async def upload_image(file: UploadFile = File(...)):
    allowed = {".jpg", ".jpeg", ".png", ".tiff", ".tif", ".nef", ".cr2", ".arw", ".dng"}
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in allowed:
        raise HTTPException(400, f"Unsupported format: {suffix}")

    image_id = str(uuid.uuid4())
    dest = UPLOAD_DIR / f"{image_id}{suffix}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    fmt_map = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG",
               ".tiff": "TIFF", ".tif": "TIFF"}
    fmt = fmt_map.get(suffix, "RAW")

    meta = ImageMeta(
        id=image_id,
        name=file.filename or "unknown",
        path=str(dest),
        width=0,   # populated after Pillow analysis
        height=0,
        format=fmt,  # type: ignore[arg-type]
    )
    _images[image_id] = meta
    return meta


@router.get("/{image_id}", response_model=ImageMeta)
async def get_image(image_id: str):
    if image_id not in _images:
        raise HTTPException(404, "Image not found")
    return _images[image_id]


@router.delete("/{image_id}")
async def delete_image(image_id: str):
    if image_id not in _images:
        raise HTTPException(404, "Image not found")
    meta = _images.pop(image_id)
    Path(meta.path).unlink(missing_ok=True)
    return {"deleted": image_id}


@router.post("/batch/analyze", response_model=BatchAnalysisResponse)
async def analyze_batch(image_ids: list[str]):
    """Compute consistency scores across a batch of images."""
    items = []
    for iid in image_ids:
        if iid not in _images:
            continue
        # Stub: real implementation runs the batch consistency engine
        score = random.uniform(60, 98)
        items.append(BatchConsistencyItem(
            image_id=iid,
            consistency_score=round(score, 1),
            flagged=score < 70,
            deviation_reason="Exposure deviation > 1.5 stops" if score < 70 else None,
        ))
    overall = sum(i.consistency_score for i in items) / len(items) if items else 0.0
    return BatchAnalysisResponse(overall_score=round(overall, 1), items=items)
