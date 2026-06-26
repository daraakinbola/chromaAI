from pydantic import BaseModel, Field
from typing import Optional, Literal
from enum import Enum


class SessionGenre(str, Enum):
    portrait = "portrait"
    landscape = "landscape"
    documentary = "documentary"
    fashion = "fashion"
    narrative_film = "narrative-film"
    product = "product"
    wedding = "wedding"
    social = "social"


class OutputDestination(str, Enum):
    web = "web"
    print = "print"
    broadcast = "broadcast"
    streaming = "streaming"


class Adjustments(BaseModel):
    exposure: float = Field(0.0, ge=-5.0, le=5.0)
    contrast: float = Field(0.0, ge=-100.0, le=100.0)
    highlights: float = Field(0.0, ge=-100.0, le=100.0)
    shadows: float = Field(0.0, ge=-100.0, le=100.0)
    whites: float = Field(0.0, ge=-100.0, le=100.0)
    blacks: float = Field(0.0, ge=-100.0, le=100.0)
    clarity: float = Field(0.0, ge=-100.0, le=100.0)
    vibrance: float = Field(0.0, ge=-100.0, le=100.0)
    saturation: float = Field(0.0, ge=-100.0, le=100.0)
    temperature: float = Field(5500.0, ge=2000.0, le=50000.0)
    tint: float = Field(0.0, ge=-150.0, le=150.0)


class SceneAnalysis(BaseModel):
    subject: str
    lighting_condition: str
    has_skin_tones: bool
    mood_baseline: str
    color_temperature_estimate: float
    confidence: float = Field(..., ge=0.0, le=1.0)


class PromptSubmitRequest(BaseModel):
    image_id: str
    text: str
    session_genre: Optional[SessionGenre] = None
    session_brief: Optional[str] = None
    current_adjustments: Optional[Adjustments] = None


class PromptSubmitResponse(BaseModel):
    interpretation: str
    suggested_adjustments: Adjustments
    confidence: float = Field(..., ge=0.0, le=1.0)
    flagged_ambiguity: Optional[str] = None
    requires_clarification: bool = False
    clarification_question: Optional[str] = None


class ApplyGradeRequest(BaseModel):
    image_id: str
    adjustments: Adjustments


class ApplyGradeResponse(BaseModel):
    preview_url: str
    render_time_ms: int


class BatchConsistencyItem(BaseModel):
    image_id: str
    consistency_score: float = Field(..., ge=0.0, le=100.0)
    flagged: bool = False
    deviation_reason: Optional[str] = None


class BatchAnalysisResponse(BaseModel):
    overall_score: float
    items: list[BatchConsistencyItem]


class ReferenceAnalysis(BaseModel):
    color_palette: list[str]  # hex strings
    contrast_ratio: float
    color_temperature: float
    tone_curve_shape: Literal["flat", "s-curve", "high-contrast", "low-contrast"]
    grain_estimate: float = Field(..., ge=0.0, le=1.0)


class ImageMeta(BaseModel):
    id: str
    name: str
    path: str
    width: int
    height: int
    format: Literal["RAW", "JPEG", "PNG", "TIFF"]
    consistency_score: Optional[float] = None
    flagged: bool = False


# ── Batch processing (Section 6 of Phase 2 TechSpec) ─────────────────────────

class AdjustmentDelta(BaseModel):
    """Unclamped per-parameter delta applied on top of a source grade."""
    exposure: float = 0.0
    contrast: float = 0.0
    highlights: float = 0.0
    shadows: float = 0.0
    whites: float = 0.0
    blacks: float = 0.0
    clarity: float = 0.0
    vibrance: float = 0.0
    saturation: float = 0.0
    temperature: float = 0.0
    tint: float = 0.0


class ImageStats(BaseModel):
    luminance: float = Field(..., ge=0.0, le=1.0, description="Average luminance 0–1")
    colorTemperature: float = Field(..., ge=1000.0, le=50000.0, description="Estimated Kelvin")


class BatchAdaptTarget(BaseModel):
    image_id: str
    luminance: float = Field(..., ge=0.0, le=1.0)
    colorTemperature: float = Field(..., ge=1000.0, le=50000.0)


class BatchAdaptRequest(BaseModel):
    source_adjustments: Adjustments
    source_stats: ImageStats
    targets: list[BatchAdaptTarget]


class ImageAdjustmentResult(BaseModel):
    image_id: str
    delta: AdjustmentDelta


class BatchAdaptResponse(BaseModel):
    adjustments: list[ImageAdjustmentResult]
