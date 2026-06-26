from fastapi import APIRouter, HTTPException
from models.schemas import PromptSubmitRequest, PromptSubmitResponse
from services import ai_engine

router = APIRouter(prefix="/prompt", tags=["prompt"])


@router.post("/submit", response_model=PromptSubmitResponse)
async def submit_prompt(req: PromptSubmitRequest):
    """
    Parse a natural-language grading prompt and return suggested adjustments.

    The AI engine triangulates the prompt against:
    - Session genre context
    - Active reference images
    - Prior manual adjustments (treated as correction signals)

    Returns adjustments + confidence + optional clarification question.
    """
    if not req.text.strip():
        raise HTTPException(400, "Prompt text cannot be empty")
    if len(req.text) > 2000:
        raise HTTPException(400, "Prompt exceeds maximum length of 2000 characters")

    try:
        return await ai_engine.parse_prompt(req)
    except EnvironmentError as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"AI engine error: {exc}") from exc
