#!/usr/bin/env python3
"""
End-to-end smoke test for the full moodboard pipeline.

Tests:
  1. POST /moodboard/analyze  -- four-image board: 3 warm portraits + 1 cool blue
  2. POST /moodboard/apply    -- translate consensus -> adjustments at full weight
                                 and at half weight, verify non-moodboard fields
                                 are preserved and weight scaling is visible

Usage:
    py test_pipeline.py
"""

import base64
import io
import json
import sys
import urllib.request
import urllib.error
from PIL import Image

BASE = "http://localhost:8000"
SEP = "=" * 60


# ─── Helpers ──────────────────────────────────────────────────────────────────

def post(path: str, payload: dict) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} on {path}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Could not reach {BASE}: {e.reason}", file=sys.stderr)
        sys.exit(1)


def gradient(top_rgb, bottom_rgb, size=300):
    img = Image.new("RGB", (size, size))
    px = img.load()
    tr, tg, tb = top_rgb
    br, bg, bb = bottom_rgb
    for y in range(size):
        t = y / (size - 1)
        r, g, b = int(tr + (br-tr)*t), int(tg + (bg-tg)*t), int(tb + (bb-tb)*t)
        for x in range(size):
            px[x, y] = (r, g, b)
    return img


def to_data_url(img):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def bar(v, width=20):
    filled = round(v * width)
    return "#" * filled + "-" * (width - filled)


# ─── Four synthetic images ────────────────────────────────────────────────────
# Three warm portraits + one cool blue — coherent enough for a real moodboard,
# but with one outlier on the cool end to test the weight mechanics.

images_raw = [
    gradient((255, 200, 80),  (180, 70, 20)),   # 1: warm golden-hour
    gradient((220, 160, 90),  (140, 60, 30)),   # 2: warm sunset
    gradient((240, 190, 110), (160, 80, 40)),   # 3: warm late afternoon
    gradient((30,  40, 120),  (80, 120, 180)),  # 4: cool blue-hour (outlier)
]
images = [to_data_url(img) for img in images_raw]

profiles = [
    # 1 — golden-hour
    {
        "averageTemperature": 7200.0, "averageSaturation": 0.72, "contrastRatio": 2.8,
        "shadowHue": [180, 80, 20], "midtoneHue": [230, 150, 60], "highlightHue": [255, 220, 130],
        "exposureBias": 0.15, "toneCurveShape": "lifted_blacks",
    },
    # 2 — warm sunset
    {
        "averageTemperature": 6800.0, "averageSaturation": 0.68, "contrastRatio": 3.0,
        "shadowHue": [160, 60, 15], "midtoneHue": [210, 130, 55], "highlightHue": [240, 200, 110],
        "exposureBias": 0.05, "toneCurveShape": "lifted_blacks",
    },
    # 3 — late afternoon
    {
        "averageTemperature": 6500.0, "averageSaturation": 0.65, "contrastRatio": 2.5,
        "shadowHue": [170, 70, 18], "midtoneHue": [220, 140, 58], "highlightHue": [245, 210, 120],
        "exposureBias": 0.10, "toneCurveShape": "flat",
    },
    # 4 — cool blue (outlier)
    {
        "averageTemperature": 4400.0, "averageSaturation": 0.45, "contrastRatio": 1.6,
        "shadowHue": [20, 30, 100], "midtoneHue": [50, 80, 160], "highlightHue": [120, 160, 220],
        "exposureBias": -0.10, "toneCurveShape": "flat",
    },
]

print(f"Four images encoded ({', '.join(f'{len(u):,}' for u in images)} chars)")
print(f"Sending to {BASE}/moodboard/analyze ...\n")


# ─── Test 1: Full pipeline ────────────────────────────────────────────────────

result = post("/moodboard/analyze", {"images": images, "profiles": profiles})

print(SEP)
print("  TEST 1 — PIPELINE RESULT (4 images)")
print(SEP)

print("\n-- Stage 1: Vision Analyst " + "-" * 33)
names = ["Warm golden-hour", "Warm sunset", "Warm late afternoon", "Cool blue-hour (outlier)"]
for i, v in enumerate(result["visionAnalysis"]):
    conf = v["confidence"]
    refs = ", ".join(v["styleReferences"]) or "(none)"
    print(f"\n  Image {i+1}: {names[i]}")
    print(f"  {v['description'][:110]}...")
    print(f"  Tech: {v['technicalCharacter'][:80]}...")
    print(f"  Refs: {refs}   Conf: {bar(conf)} {round(conf*100)}%")

print("\n-- Stage 2: Statistical Synthesizer " + "-" * 23)
c = result["statisticalConsensus"]
print(f"  Overall agreement   {bar(c['overall_agreement_score'])} {round(c['overall_agreement_score']*100)}%")
print(f"  Temperature         {c['averageTemperature']['value']:.0f}K  "
      f"(agreement {round(c['averageTemperature']['agreement_score']*100)}%)")
print(f"  Saturation          {c['averageSaturation']['value']:.3f}  "
      f"(agreement {round(c['averageSaturation']['agreement_score']*100)}%)")
print(f"  Contrast ratio      {c['contrastRatio']['value']:.2f}  "
      f"(agreement {round(c['contrastRatio']['agreement_score']*100)}%)")
print(f"  Tone curve          {c['toneCurveShape']} ({round(c['toneCurveShapeAgreement']*100)}% agree)")
outliers = c["outlier_image_indices"]
print(f"  Outlier images      {[i+1 for i in outliers] if outliers else 'none'}")

print("\n-- Stage 3: Creative Director " + "-" * 30)
cd = result["creativeDirection"]
print(f"\n  {cd['creativeBrief']}")
print(f"\n  Confidence: {cd['confidenceAssessment']}")
print(f"\n  Recommended weight  {bar(cd['recommendedWeight'])} {round(cd['recommendedWeight']*100)}%")
if cd["flaggedTensions"]:
    print(f"\n  Tensions ({len(cd['flaggedTensions'])}):")
    for t in cd["flaggedTensions"]:
        print(f"    !! {t}")
else:
    print("\n  No flagged tensions")

t = result["processingTimeMs"]
print(f"\n  Times: vision {t['visionAnalyst']:.0f}ms + stats {t['statisticalSynthesizer']:.0f}ms "
      f"(concurrent) | creative {t['creativeDirector']:.0f}ms | "
      f"total {t['visionAnalyst'] + t['creativeDirector']:.0f}ms")


# ─── Test 2: Apply endpoint ───────────────────────────────────────────────────

consensus = result["statisticalConsensus"]
weight = result["creativeDirection"]["recommendedWeight"]

# Simulate an image that already has some manual slider work done —
# the apply should preserve highlights/shadows/clarity and only touch
# the five moodboard-derived fields.
current_adj = {
    "exposure": 0.0, "contrast": 0.0, "highlights": 25.0, "shadows": -15.0,
    "whites": 0.0, "blacks": 0.0, "clarity": 10.0, "vibrance": 0.0,
    "saturation": 0.0, "temperature": 5500.0, "tint": 0.0,
}

print("\n" + SEP)
print("  TEST 2 — APPLY ENDPOINT")
print(SEP)
print(f"\n  Sending consensus to /moodboard/apply ...")
print(f"  Current image has: highlights={current_adj['highlights']}, "
      f"shadows={current_adj['shadows']}, clarity={current_adj['clarity']} (should be preserved)")
print(f"  Applying at recommended weight {round(weight*100)}%\n")

adj_full = post("/moodboard/apply", {
    "consensus": consensus,
    "recommended_weight": weight,
    "current_adjustments": current_adj,
})

half_weight = weight * 0.5
adj_half = post("/moodboard/apply", {
    "consensus": consensus,
    "recommended_weight": half_weight,
    "current_adjustments": current_adj,
})

print("  Field              Current     Full weight            Half weight")
print("  " + "-" * 64)
fields_moodboard = ["temperature", "saturation", "contrast", "exposure", "tint"]
fields_preserved = ["highlights", "shadows", "whites", "blacks", "clarity", "vibrance"]

for field in fields_moodboard:
    cur = current_adj[field]
    full = adj_full[field]
    half = adj_half[field]
    changed = "  <- moodboard" if abs(full - cur) > 0.01 else "  (unchanged)"
    print(f"  {field:<18} {cur:>8.2f}    {full:>8.2f}               {half:>8.2f}{changed}")

print()
for field in fields_preserved:
    cur = current_adj[field]
    full = adj_full[field]
    preserved = "  PRESERVED" if abs(full - cur) < 0.001 else "  !! CHANGED (bug)"
    print(f"  {field:<18} {cur:>8.2f}    {full:>8.2f}               {full:>8.2f}{preserved}")

# Acceptance criteria checks
print("\n-- Acceptance criteria checks " + "-" * 30)

# AC1: Temperature moved from default
assert abs(adj_full["temperature"] - 5500.0) > 50, "FAIL: temperature did not change"
print("  [OK] Temperature moved from 5500K default")

# AC2: Weight scaling is real (half weight -> closer to neutral)
temp_delta_full = abs(adj_full["temperature"] - 5500.0)
temp_delta_half = abs(adj_half["temperature"] - 5500.0)
assert temp_delta_half < temp_delta_full, "FAIL: half weight not more conservative"
print(f"  [OK] Weight scaling confirmed: full delta {temp_delta_full:.0f}K, half delta {temp_delta_half:.0f}K")

# AC3: Non-moodboard fields preserved
for field in fields_preserved:
    assert abs(adj_full[field] - current_adj[field]) < 0.001, f"FAIL: {field} was changed"
print(f"  [OK] All non-moodboard fields preserved: {', '.join(fields_preserved)}")

# AC4: Deterministic — applying twice gives same result
adj_again = post("/moodboard/apply", {
    "consensus": consensus,
    "recommended_weight": weight,
    "current_adjustments": adj_full,   # different starting point
})
for field in fields_moodboard:
    assert abs(adj_again[field] - adj_full[field]) < 0.001, f"FAIL: {field} not deterministic"
print("  [OK] Deterministic: re-applying after manual slider changes gives same result")

print("\n" + SEP)
print("  All tests passed.")
print(SEP)
