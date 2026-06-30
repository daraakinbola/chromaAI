#!/usr/bin/env python3
"""
Quick smoke-test for POST /moodboard/test-vision.

Usage:
    python test_vision.py <image_path>
    python test_vision.py path/to/photo.jpg
"""

import sys
import base64
import json
import mimetypes
import urllib.request
import urllib.error

ENDPOINT = "http://localhost:8000/moodboard/test-vision"


def image_to_data_url(path: str) -> str:
    mime, _ = mimetypes.guess_type(path)
    if not mime or not mime.startswith("image/"):
        mime = "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{b64}"


def main():
    if len(sys.argv) < 2:
        print("Usage: python test_vision.py <image_path>")
        sys.exit(1)

    image_path = sys.argv[1]
    print(f"Reading {image_path} ...")
    data_url = image_to_data_url(image_path)
    print(f"Encoded ({len(data_url):,} chars). Sending to {ENDPOINT} ...\n")

    body = json.dumps({"image_data_url": data_url}).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        print(f"HTTP {e.code}: {error_body}")
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Could not reach {ENDPOINT}: {e.reason}")
        print("Is the API server running?  uvicorn main:app --reload --port 8000")
        sys.exit(1)

    conf_pct = round(result["confidence"] * 100)
    bar = "█" * (conf_pct // 5) + "░" * (20 - conf_pct // 5)

    print("── Vision Analyst Output ─────────────────────────────")
    print(f"\n  Description\n  {result['description']}\n")
    print(f"  Technical character\n  {result['technicalCharacter']}\n")
    refs = result["styleReferences"]
    print(f"  Style references\n  {', '.join(refs) if refs else '(none identified)'}\n")
    print(f"  Confidence  {bar}  {conf_pct}%")
    print("\n─────────────────────────────────────────────────────")


if __name__ == "__main__":
    main()
