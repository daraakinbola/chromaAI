from fastapi import APIRouter, File, HTTPException, UploadFile
import base64
import io

router = APIRouter(prefix="/raw", tags=["raw"])


def _wb_to_kelvin(r: float, g: float, b: float) -> int:
    """Estimate color temperature in Kelvin from white-balance multipliers."""
    if g == 0:
        return 5500
    rn = r / g
    bn = b / g
    if bn == 0:
        return 5500
    # Warm scene (rn/bn high) → low K; cool scene (rn/bn low) → high K
    rb = rn / bn
    k = int(10000 / max(rb, 0.01) ** 0.6)
    return max(2000, min(50000, k))


@router.post("/decode")
async def decode_raw(file: UploadFile = File(...)):
    """Decode a RAW camera file to PNG and return camera metadata."""
    try:
        import rawpy
        from PIL import Image
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Server-side RAW decode requires rawpy and Pillow: {exc}",
        )

    data = await file.read()
    try:
        with rawpy.imread(io.BytesIO(data)) as raw:
            wb = raw.camera_whitebalance  # [R, G1, B, G2]
            g = wb[1] if wb[1] > 0 else (wb[3] if len(wb) > 3 and wb[3] > 0 else 1.0)
            temperature = _wb_to_kelvin(wb[0], g, wb[2])

            rgb = raw.postprocess(
                use_camera_wb=True,
                no_auto_bright=True,
                output_color=rawpy.ColorSpace.sRGB,
                highlight=5,
                demosaic_algorithm=rawpy.DemosaicAlgorithm.AHD,
                output_bps=8,
            )

        img = Image.fromarray(rgb)
        buf = io.BytesIO()
        img.save(buf, format="PNG", compress_level=1)
        encoded = base64.b64encode(buf.getvalue()).decode()

        return {
            "dataUrl": f"data:image/png;base64,{encoded}",
            "width": int(rgb.shape[1]),
            "height": int(rgb.shape[0]),
            "cameraTemperature": temperature,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"RAW decode failed: {exc}")
