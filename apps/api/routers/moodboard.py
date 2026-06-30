from fastapi import APIRouter, HTTPException
from models.schemas import (
    VisionAnalystOutput,
    VisionAnalystTestRequest,
    MoodboardConsensus,
    SynthesizerTestRequest,
    CreativeDirectorOutput,
    CreativeDirectorTestRequest,
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
