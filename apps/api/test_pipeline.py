#!/usr/bin/env python3
"""
End-to-end smoke test for POST /moodboard/analyze.

Generates two synthetic 300x300 images (warm golden-hour gradient and cool
blue-hour gradient), converts them to data URLs, builds hand-crafted
ColorProfiles, and sends everything to the orchestrator endpoint. Prints
the full three-layer result so we can verify each stage contributed.

Usage:
    py test_pipeline.py
"""

import base64
import io
import json
import urllib.request
import urllib.error
from PIL import Image

ENDPOINT = "http://localhost:8000/moodboard/analyze"


# ─── Synthetic image generation ───────────────────────────────────────────────

def make_gradient_image(top_rgb: tuple, bottom_rgb: tuple, size: int = 300) -> Image.Image:
    """Vertical gradient from top_rgb to bottom_rgb."""
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    tr, tg, tb = top_rgb
    br, bg, bb = bottom_rgb
    for y in range(size):
        t = y / (size - 1)
        r = int(tr + (br - tr) * t)
        g = int(tg + (bg - tg) * t)
        b = int(tb + (bb - tb) * t)
        for x in range(size):
            pixels[x, y] = (r, g, b)
    return img


def image_to_data_url(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


# Image 1: warm golden-hour — rich amber top fading to deep orange
warm_img = make_gradient_image(top_rgb=(255, 200, 80), bottom_rgb=(180, 70, 20))

# Image 2: cool blue-hour — deep indigo top fading to steel blue
cool_img = make_gradient_image(top_rgb=(30, 40, 120), bottom_rgb=(80, 120, 180))

images = [image_to_data_url(warm_img), image_to_data_url(cool_img)]
print(f"Images encoded: {len(images[0]):,} chars  |  {len(images[1]):,} chars\n")


# ─── Hand-crafted ColorProfiles ───────────────────────────────────────────────
# These deliberately contrast each other on key dimensions so the Statistical
# Synthesizer and Creative Director have something real to synthesize.

warm_profile = {
    "averageTemperature": 7200.0,   # warm/golden
    "averageSaturation":  0.72,
    "contrastRatio":      2.8,
    "shadowHue":          [180, 80, 20],   # deep burnt orange in shadows
    "midtoneHue":         [230, 150, 60],  # amber midtones
    "highlightHue":       [255, 220, 130], # pale gold highlights
    "exposureBias":       0.15,
    "toneCurveShape":     "lifted_blacks",
}

cool_profile = {
    "averageTemperature": 4400.0,   # cool/blue
    "averageSaturation":  0.45,
    "contrastRatio":      1.6,
    "shadowHue":          [20, 30, 100],   # deep indigo shadows
    "midtoneHue":         [50, 80, 160],   # steel blue midtones
    "highlightHue":       [120, 160, 220], # pale blue highlights
    "exposureBias":       -0.10,
    "toneCurveShape":     "flat",
}

profiles = [warm_profile, cool_profile]


# ─── Call the endpoint ────────────────────────────────────────────────────────

payload = json.dumps({"images": images, "profiles": profiles}).encode()
req = urllib.request.Request(
    ENDPOINT,
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)

print(f"Sending to {ENDPOINT} ...")
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"HTTP {e.code}: {body}")
    raise SystemExit(1)
except urllib.error.URLError as e:
    print(f"Could not reach {ENDPOINT}: {e.reason}")
    raise SystemExit(1)


# ─── Print results ────────────────────────────────────────────────────────────

def bar(score: float, width: int = 20) -> str:
    filled = round(score * width)
    return "#" * filled + "-" * (width - filled)


SEP = "=" * 60

print("\n" + SEP)
print("  MOODBOARD PIPELINE RESULT")
print(SEP)

# Stage 1 -- Vision Analyst
print("\n-- Stage 1: Vision Analyst " + "-" * 33)
for i, v in enumerate(result["visionAnalysis"]):
    name = "Warm golden-hour" if i == 0 else "Cool blue-hour"
    conf = v["confidence"]
    refs = ", ".join(v["styleReferences"]) if v["styleReferences"] else "(none)"
    print(f"\n  Image {i+1}: {name}")
    print(f"  Description     {v['description']}")
    print(f"  Tech character  {v['technicalCharacter']}")
    print(f"  Style refs      {refs}")
    print(f"  Confidence      {bar(conf)}  {round(conf*100)}%")

# Stage 2 -- Statistical Synthesizer
print("\n-- Stage 2: Statistical Synthesizer " + "-" * 23)
c = result["statisticalConsensus"]
print(f"  Overall agreement   {bar(c['overall_agreement_score'])}  {round(c['overall_agreement_score']*100)}%")
print(f"  Temperature         consensus {c['averageTemperature']['value']:.0f}K  "
      f"agreement {round(c['averageTemperature']['agreement_score']*100)}%")
print(f"  Saturation          consensus {c['averageSaturation']['value']:.2f}   "
      f"agreement {round(c['averageSaturation']['agreement_score']*100)}%")
print(f"  Contrast ratio      consensus {c['contrastRatio']['value']:.2f}   "
      f"agreement {round(c['contrastRatio']['agreement_score']*100)}%")
print(f"  Tone curve shape    {c['toneCurveShape']}  "
      f"({round(c['toneCurveShapeAgreement']*100)}% agree)")
outliers = c["outlier_image_indices"]
print(f"  Outlier images      {[i+1 for i in outliers] if outliers else 'none'}")

# Stage 3 -- Creative Director
print("\n-- Stage 3: Creative Director " + "-" * 29)
cd = result["creativeDirection"]
print(f"\n  Creative brief:\n")
for line in cd["creativeBrief"].split(". "):
    line = line.strip()
    if line:
        print(f"    {line}{'.' if not line.endswith('.') else ''}")
print(f"\n  Confidence assessment:\n    {cd['confidenceAssessment']}")
print(f"\n  Recommended weight  {bar(cd['recommendedWeight'])}  "
      f"{round(cd['recommendedWeight']*100)}%")

tensions = cd["flaggedTensions"]
if tensions:
    print(f"\n  Flagged tensions ({len(tensions)}):")
    for t in tensions:
        print(f"    !!  {t}")
else:
    print("\n  Flagged tensions    (none -- sources in agreement)")

# Timing breakdown
print("\n-- Processing times " + "-" * 40)
t = result["processingTimeMs"]
print(f"  Vision analyst      {t['visionAnalyst']:.0f} ms")
print(f"  Stat synthesizer    {t['statisticalSynthesizer']:.0f} ms  (concurrent with vision)")
print(f"  Creative director   {t['creativeDirector']:.0f} ms")
print(f"  Total wall-clock    {t['visionAnalyst'] + t['creativeDirector']:.0f} ms")
print("\n" + SEP)
