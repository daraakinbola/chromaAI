"""
AI engine — orchestrates Claude for prompt parsing and scene analysis.
"""
import os
import json
from anthropic import AsyncAnthropic
from models.schemas import (
    Adjustments,
    SceneAnalysis,
    PromptSubmitRequest,
    PromptSubmitResponse,
    PromptVariation,
    SessionGenre,
)

def _client() -> AsyncAnthropic:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise EnvironmentError("ANTHROPIC_API_KEY is not set. Add it to apps/api/.env")
    return AsyncAnthropic(api_key=key)

SYSTEM_PROMPT = """\
You are the AI engine for ChromaAI, a professional color grading platform.
Your role is to translate the user's creative intent into precise color grading adjustments.

Rules:
1. Never make autonomous aesthetic decisions — always interpret the user's intent.
2. When uncertain, flag the ambiguity explicitly rather than guessing.
3. Skin tone regions are protected — never recommend adjustments that would shift skin tones unnaturally.
4. Manual adjustments override AI suggestions — respect any active manual adjustments when proposing changes.
5. Respond ONLY with a valid JSON object matching the schema described in the user message.
"""


async def parse_prompt(request: PromptSubmitRequest) -> PromptSubmitResponse:
    """Translate a natural-language grading prompt into adjustment parameters."""

    context_parts = [f'User prompt: "{request.text}"']
    if request.session_genre:
        context_parts.append(f"Session genre: {request.session_genre.value}")
    if request.session_brief:
        context_parts.append(f"Session brief: {request.session_brief}")
    if request.current_adjustments:
        context_parts.append(f"Current adjustments: {request.current_adjustments.model_dump_json()}")

    adj_schema = """{
    "exposure": 0.0,       // -5 to +5 stops
    "contrast": 0,         // -100 to +100
    "highlights": 0,       // -100 to +100
    "shadows": 0,          // -100 to +100
    "whites": 0,           // -100 to +100
    "blacks": 0,           // -100 to +100
    "clarity": 0,          // -100 to +100
    "vibrance": 0,         // -100 to +100
    "saturation": 0,       // -100 to +100
    "temperature": 5500,   // Kelvin
    "tint": 0              // -150 to +150
  }"""

    user_message = "\n".join(context_parts) + f"""

Respond with a JSON object with these fields:
{{
  "interpretation": "Plain-English description of how you interpreted the prompt",
  "suggested_adjustments": {adj_schema},
  "confidence": 0.85,        // 0.0 to 1.0
  "flagged_ambiguity": null, // string describing the ambiguity, or null
  "requires_clarification": false,
  "clarification_question": null,
  "variations": null
}}

AMBIGUITY RULES — apply exactly one of these three paths:
1. confidence >= 0.65: Set variations=null. Apply your best interpretation directly.
2. confidence < 0.65 AND a single question would resolve the ambiguity: Set requires_clarification=true, write clarification_question, set variations=null.
3. confidence < 0.65 AND multiple interpretations are equally plausible: Set variations to an array of 2-3 objects — do NOT set requires_clarification. Each variation:
   {{
     "label": "Short name (2-4 words)",
     "interpretation": "One sentence describing this reading of the prompt",
     "adjustments": {adj_schema}
   }}
   Make the variations meaningfully distinct (e.g. warm vs cool, subtle vs dramatic).
   suggested_adjustments should be your best-guess fallback for this case."""

    response = await _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_message}],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    data = json.loads(raw)

    variations = None
    if data.get("variations"):
        variations = [
            PromptVariation(
                label=v["label"],
                interpretation=v["interpretation"],
                adjustments=Adjustments(**v["adjustments"]),
            )
            for v in data["variations"]
        ]

    return PromptSubmitResponse(
        interpretation=data["interpretation"],
        suggested_adjustments=Adjustments(**data["suggested_adjustments"]),
        confidence=data["confidence"],
        flagged_ambiguity=data.get("flagged_ambiguity"),
        requires_clarification=data.get("requires_clarification", False),
        clarification_question=data.get("clarification_question"),
        variations=variations,
    )


async def analyze_scene(image_b64: str, genre: SessionGenre | None = None) -> SceneAnalysis:
    """Run semantic scene analysis on an image."""
    genre_ctx = f" The session genre is {genre.value}." if genre else ""

    response = await _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": image_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Analyze this image for color grading.{genre_ctx} "
                            "Respond with JSON: "
                            '{"subject": "...", "lighting_condition": "...", '
                            '"has_skin_tones": true, "mood_baseline": "...", '
                            '"color_temperature_estimate": 5500, "confidence": 0.9}'
                        ),
                    },
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    data = json.loads(raw)
    return SceneAnalysis(**data)
