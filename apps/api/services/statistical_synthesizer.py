"""
Statistical Synthesizer — Phase 4, Section 4.

Pure NumPy. No LLM calls. Computes per-dimension MAD-based consensus across a
list of ColorProfiles exactly as specified in Section 4.2 of the PRD.

Deliberately not an agent: statistical consensus across numeric dimensions is
deterministic computation, not qualitative judgment. Routing it through an LLM
would be slower, non-deterministic, and harder to audit for no benefit.
"""

from collections import Counter
import numpy as np
from models.schemas import ColorProfile, DimensionConsensus, MoodboardConsensus


def compute_dimension_consensus(values: list[float]) -> DimensionConsensus:
    """
    Per-dimension MAD-based consensus — Section 4.2.

    1. Compute median and MAD across all image values for this dimension.
    2. Scale MAD by 1.4826 (makes it comparable to std dev under normality).
    3. Flag images whose deviation from the median exceeds 3 scaled-MAD units.
    4. Assign weights: 0.1 for flagged outliers, 1/(1+deviation) for the rest.
    5. Weighted average → consensus value; relative MAD → agreement score.
    """
    arr = np.array(values, dtype=float)
    median = float(np.median(arr))
    mad = float(np.median(np.abs(arr - median)))
    scaled_mad = mad * 1.4826

    weights: list[float] = []
    outlier_flags: list[bool] = []

    for v in values:
        deviation = abs(v - median) / scaled_mad if scaled_mad > 1e-6 else 0.0
        is_outlier = deviation > 3.0
        weights.append(0.1 if is_outlier else 1.0 / (1.0 + deviation))
        outlier_flags.append(is_outlier)

    consensus_value = float(np.average(arr, weights=weights))
    agreement_score = 1.0 - min(1.0, scaled_mad / (abs(median) + 1e-6))

    return DimensionConsensus(
        value=consensus_value,
        agreement_score=agreement_score,
        outlier_image_indices=[i for i, f in enumerate(outlier_flags) if f],
    )


def compute_moodboard_consensus(profiles: list[ColorProfile]) -> MoodboardConsensus:
    """
    Run compute_dimension_consensus across every numeric dimension of ColorProfile,
    then mode-vote the categorical toneCurveShape, and aggregate results.

    Dimensions processed:
      Scalars (4):   averageTemperature, averageSaturation, contrastRatio, exposureBias
      RGB triplets:  shadowHue[R,G,B], midtoneHue[R,G,B], highlightHue[R,G,B]  (9 total)
      Categorical:   toneCurveShape (plurality vote, not MAD)
    """
    if len(profiles) < 2:
        raise ValueError("Consensus requires at least 2 profiles")

    # ── Scalar dimensions ─────────────────────────────────────────────────────
    avg_temperature = compute_dimension_consensus(
        [p.averageTemperature for p in profiles]
    )
    avg_saturation = compute_dimension_consensus(
        [p.averageSaturation for p in profiles]
    )
    contrast_ratio = compute_dimension_consensus(
        [p.contrastRatio for p in profiles]
    )
    exposure_bias = compute_dimension_consensus(
        [p.exposureBias for p in profiles]
    )

    # ── RGB triplet dimensions (per-channel) ──────────────────────────────────
    shadow_hue = [
        compute_dimension_consensus([p.shadowHue[ch] for p in profiles])
        for ch in range(3)
    ]
    midtone_hue = [
        compute_dimension_consensus([p.midtoneHue[ch] for p in profiles])
        for ch in range(3)
    ]
    highlight_hue = [
        compute_dimension_consensus([p.highlightHue[ch] for p in profiles])
        for ch in range(3)
    ]

    # ── Categorical: plurality vote ───────────────────────────────────────────
    shapes = [p.toneCurveShape for p in profiles]
    mode_shape, mode_count = Counter(shapes).most_common(1)[0]
    shape_agreement = mode_count / len(shapes)

    # ── Aggregate ─────────────────────────────────────────────────────────────
    all_numeric: list[DimensionConsensus] = (
        [avg_temperature, avg_saturation, contrast_ratio, exposure_bias]
        + shadow_hue
        + midtone_hue
        + highlight_hue
    )

    overall_agreement = float(np.mean([c.agreement_score for c in all_numeric]))

    # Union of per-dimension outlier indices — an image flagged on any dimension
    # is worth flagging overall.
    outlier_union = sorted(
        set().union(*(set(c.outlier_image_indices) for c in all_numeric))
    )

    return MoodboardConsensus(
        averageTemperature=avg_temperature,
        averageSaturation=avg_saturation,
        contrastRatio=contrast_ratio,
        exposureBias=exposure_bias,
        shadowHue=shadow_hue,
        midtoneHue=midtone_hue,
        highlightHue=highlight_hue,
        toneCurveShape=mode_shape,
        toneCurveShapeAgreement=shape_agreement,
        overall_agreement_score=overall_agreement,
        outlier_image_indices=outlier_union,
    )
