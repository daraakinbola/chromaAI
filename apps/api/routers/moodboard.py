from fastapi import APIRouter, HTTPException
from models.schemas import (
    Adjustments,
    VisionAnalystOutput,
    VisionAnalystTestRequest,
    MoodboardConsensus,
    SynthesizerTestRequest,
    CreativeDirectorOutput,
    CreativeDirectorTestRequest,
    MoodboardAnalyzeRequest,
    MoodboardPipelineResult,
    MoodboardApplyRequest,
)
from services import ai_engine
from services.statistical_synthesizer import compute_moodboard_consensus

router = APIRouter(prefix="/moodboard", tags=["moodboard"])


@router.post("/test-vision", response_model=VisionAnalystOutput)
async def test_vision_analyst(req: VisionAnalystTestRequest) -> VisionAnalystOutput:
    """
    Smoke-test for the Vision Analyst agent in isolation.
    Accepts a single image as a base64 data URL; returns qualitative output.
    Not wired into the full pipeline yet.
    """
    if not req.image_data_url.startswith("data:image/"):
        raise HTTPException(400, "image_data_url must be a base64 data URL (data:image/...)")
    try:
        return await ai_engine.run_vision_analyst(req.image_data_url)
    except EnvironmentError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Vision Analyst error: {exc}") from exc


@router.post("/test-synthesizer", response_model=MoodboardConsensus)
def test_statistical_synthesizer(req: SynthesizerTestRequest) -> MoodboardConsensus:
    """
    Smoke-test for the Statistical Synthesizer in isolation.
    Accepts 2+ ColorProfiles (as JSON); returns per-dimension MAD consensus.
    Pure computation — no AI calls, synchronous.
    """
    try:
        return compute_moodboard_consensus(req.profiles)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Synthesizer error: {exc}") from exc


@router.post("/test-creative-director", response_model=CreativeDirectorOutput)
async def test_creative_director(req: CreativeDirectorTestRequest) -> CreativeDirectorOutput:
    """
    Smoke-test for the Creative Director agent in isolation.
    Accepts pre-computed Vision Analyst outputs + Statistical Synthesizer consensus;
    returns a unified creative brief, tension flags, and recommended weight.
    Not wired into the full pipeline yet.
    """
    try:
        return await ai_engine.run_creative_director(req.vision_results, req.consensus)
    except EnvironmentError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Creative Director error: {exc}") from exc


@router.post("/analyze", response_model=MoodboardPipelineResult)
async def analyze_moodboard(req: MoodboardAnalyzeRequest) -> MoodboardPipelineResult:
    """
    Full three-stage moodboard pipeline: Vision Analyst + Statistical Synthesizer
    (concurrent) → Creative Director (sequential). Returns visionAnalysis,
    statisticalConsensus, creativeDirection, and processingTimeMs breakdown
    showing real wall-clock elapsed per stage.
    """
    if len(req.images) != len(req.profiles):
        raise HTTPException(
            400,
            f"images ({len(req.images)}) and profiles ({len(req.profiles)}) must be the same length",
        )
    for url in req.images:
        if not url.startswith("data:image/"):
            raise HTTPException(400, "Each image must be a base64 data URL (data:image/...)")
    try:
        return await ai_engine.run_moodboard_pipeline(req.images, req.profiles)
    except EnvironmentError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Moodboard pipeline error: {exc}") from exc


@router.post("/apply", response_model=Adjustments)
def apply_moodboard(req: MoodboardApplyRequest) -> Adjustments:
    """
    Translate MoodboardConsensus → AdjustmentState (Phase 4b PRD §4.1–4.2).

    Deterministic, no AI call. Each moodboard-derived field is scaled from its
    neutral baseline by recommended_weight. Fields the moodboard doesn't cover
    (highlights, shadows, whites, blacks, clarity, vibrance) are passed through
    unchanged from current_adjustments.
    """
    try:
        return ai_engine.moodboard_consensus_to_adjustments(
            req.consensus,
            req.current_adjustments,
            req.recommended_weight,
        )
    except Exception as exc:
        raise HTTPException(500, f"Moodboard apply error: {exc}") from exc
