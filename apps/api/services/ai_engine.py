"""
AI engine — orchestrates Claude for prompt parsing and scene analysis.
"""
import os
import json
import asyncio
from anthropic import AsyncAnthropic
from models.schemas import (
    Adjustments,
    SceneAnalysis,
    PromptSubmitRequest,
    PromptSubmitResponse,
    PromptVariation,
    SessionGenre,
    VisionAnalystOutput,
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


def _parse_data_url(data_url: str) -> tuple[str, str]:
    """Split a data URL into (media_type, base64_data)."""
    header, data = data_url.split(",", 1)
    media_type = header.split(";")[0].replace("data:", "")
    return media_type, data


VISION_ANALYST_SYSTEM = """\
You are the Vision Analyst for ChromaAI's moodboard intelligence pipeline.
Your only job is to look at an image and describe what it visually communicates
and how it achieves its look.

Rules — follow these exactly:
1. Describe what you SEE, not what color grading values to use. Do not mention
   exposure, contrast, temperature, or any numeric adjustment parameter.
   Translation to grading values is handled by a separate agent, not you.
2. Distinguish CONTENT (what is literally in the frame — subject, setting,
   light source) from STYLE (how it is rendered — grain, tonal character,
   color treatment). Address both, separately, in your output.
3. styleReferences must only list influences you genuinely recognize — specific
   film stocks, photographic genres, cinematographic eras, or named visual
   styles. If you are uncertain, omit the reference entirely. An empty array
   is correct and preferred over a fabricated or guessed reference.
   False specificity is worse than honest generality.
4. Respond ONLY with a valid JSON object — no prose, no markdown fences.
"""

VISION_ANALYST_USER = """\
Analyze this moodboard image.

Respond with exactly this JSON structure:
{
  "description": "2-3 sentences covering the subject matter, quality of light, and overall emotional mood",
  "technicalCharacter": "comma-separated style descriptors as a colorist would name them — e.g. 'film grain, lifted blacks, warm highlight rolloff, desaturated midtones'",
  "styleReferences": ["only genuine recognized influences — omit any you are not confident about; empty array is fine"],
  "confidence": 0.9
}
"""


async def run_vision_analyst(image_data_url: str) -> VisionAnalystOutput:
    """
    Vision Analyst agent — looks at a single moodboard image and returns a
    qualitative description of its content and visual style.

    Section 3.3 contract: describes what it sees, never suggests adjustment
    values, never fabricates style references it isn't genuinely recognizing.
    """
    media_type, b64_data = _parse_data_url(image_data_url)

    response = await _client().messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        system=VISION_ANALYST_SYSTEM,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64_data,
                        },
                    },
                    {"type": "text", "text": VISION_ANALYST_USER},
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

    return VisionAnalystOutput(
        description=data["description"],
        technicalCharacter=data["technicalCharacter"],
        styleReferences=data.get("styleReferences", []),
        confidence=float(data["confidence"]),
    )


async def run_vision_analyst_batch(image_data_urls: list[str]) -> list[VisionAnalystOutput]:
    """Run Vision Analyst concurrently across all images (Section 3.4)."""
    return await asyncio.gather(*[run_vision_analyst(url) for url in image_data_urls])


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
