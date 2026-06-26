"""
Color science utilities — non-destructive pipeline helpers.

All operations are applied in linear light before conversion to output color space.
"""
import numpy as np
from typing import Literal

ColorSpace = Literal["sRGB", "P3", "Rec2020", "ACES"]


def srgb_to_linear(v: np.ndarray) -> np.ndarray:
    """Inverse sRGB EOTF — gamma expand to linear light."""
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(v: np.ndarray) -> np.ndarray:
    """sRGB EOTF — gamma compress from linear light."""
    return np.where(v <= 0.0031308, 12.92 * v, 1.055 * (v ** (1.0 / 2.4)) - 0.055)


def apply_exposure(linear: np.ndarray, stops: float) -> np.ndarray:
    """Exposure adjustment in linear light (stops)."""
    return linear * (2.0 ** stops)


def apply_contrast_curve(linear: np.ndarray, amount: float) -> np.ndarray:
    """S-curve contrast around 18% grey pivot (amount: -100 to +100)."""
    if amount == 0:
        return linear
    pivot = 0.18
    strength = amount / 100.0
    # Lift the contrast: compress or expand around pivot
    return np.clip(pivot + (linear - pivot) * (1.0 + strength), 0.0, None)


def kelvin_to_rgb_multiplier(kelvin: float) -> tuple[float, float, float]:
    """Approximate RGB white balance multipliers for a given colour temperature."""
    # Simplified Planckian locus approximation
    t = kelvin / 100.0
    if t <= 66:
        r = 1.0
        g = np.clip((99.4708025861 * np.log(t) - 161.1195681661) / 255.0, 0.0, 1.0)
        b = 1.0 if t >= 66 else (
            0.0 if t <= 19 else
            np.clip((138.5177312231 * np.log(t - 10) - 305.0447927307) / 255.0, 0.0, 1.0)
        )
    else:
        r = np.clip((329.698727446 * ((t - 60) ** -0.1332047592)) / 255.0, 0.0, 1.0)
        g = np.clip((288.1221695283 * ((t - 60) ** -0.0755148492)) / 255.0, 0.0, 1.0)
        b = 1.0
    return float(r), float(g), float(b)


def protect_skin_tones(mask: np.ndarray, adjustments: dict) -> dict:
    """
    Attenuate saturation adjustments in detected skin-tone regions.
    mask: H×W float array, 1.0 = skin, 0.0 = not skin.
    Returns attenuated adjustments dict.
    """
    if mask.max() < 0.1:
        return adjustments
    skin_coverage = float(mask.mean())
    protected = dict(adjustments)
    # Reduce saturation impact proportionally to skin coverage
    if "saturation" in protected:
        protected["saturation"] = protected["saturation"] * (1.0 - skin_coverage * 0.6)
    return protected
