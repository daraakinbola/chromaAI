from fastapi import APIRouter, HTTPException
from models.schemas import VisionAnalystOutput, VisionAnalystTestRequest
from services import ai_engine

router = APIRouter(prefix="/moodboard", tags=["moodboard"])


@router.post("/test-vision", response_model=VisionAnalystOutput)
async def test_vision_analyst(req: VisionAnalystTestRequest) -> VisionAnalystOutput:
    """
    Smoke-test endpoint for the Vision Analyst agent in isolation.

    Accepts a single image as a base64 data URL and returns the agent's
    qualitative read: description, technicalCharacter, styleReferences,
    and self-reported confidence. Not wired into the full moodboard
    pipeline yet — exists to verify the agent works before orchestration
    is built.
    """
    if not req.image_data_url.startswith("data:image/"):
        raise HTTPException(400, "image_data_url must be a base64 data URL (data:image/...)")
    try:
        return await ai_engine.run_vision_analyst(req.image_data_url)
    except EnvironmentError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Vision Analyst error: {exc}") from exc
