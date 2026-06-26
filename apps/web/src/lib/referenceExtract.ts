import type { AdjustmentState, ColorProfile, ReferenceImage } from "@/types";

// ─── Utilities ────────────────────────────────────────────────────────────────

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ─── Spec Section 4.4: extraction helpers ─────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

// Spec Step 4: R/B ratio → Kelvin approximation
function rbRatioToKelvin(rAvg: number, bAvg: number): number {
  if (bAvg === 0) return 2000;
  const ratio = rAvg / bAvg;
  const clamped = Math.max(0.5, Math.min(3.0, ratio));
  const t = (clamped - 0.5) / 2.5; // 0 = cool, 1 = warm
  return Math.round(Math.max(2000, Math.min(50000, 10000 - t * 8000)));
}

// Spec Section 4.4 Step 6: infer tone curve shape from histogram
function inferToneCurveShape(
  shadowMeanL: number,
  highlightMeanL: number,
  stdDev: number
): ColorProfile["toneCurveShape"] {
  if (shadowMeanL > 50) return "lifted_blacks";
  if (shadowMeanL < 15 && highlightMeanL > 200) return "crushed_blacks";
  if (stdDev > 80) return "high_contrast";
  if (stdDev < 30) return "low_contrast";
  return "flat";
}

function avgRgbBucket(pixels: Uint8ClampedArray, indices: number[]): [number, number, number] {
  if (!indices.length) return [128, 128, 128];
  let r = 0, g = 0, b = 0;
  for (const i of indices) { r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; }
  const n = indices.length;
  return [r / n, g / n, b / n];
}

// ─── Spec Section 4.4: full extraction pipeline ───────────────────────────────

export function extractColorProfile(imageData: ImageData): ColorProfile {
  const { data, width, height } = imageData;
  const shadowIdx: number[] = [], midtoneIdx: number[] = [], highlightIdx: number[] = [];
  let totalSat = 0, pixelCount = 0;
  const luminances: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      luminances.push(L);
      if (L < 85) shadowIdx.push(i);
      else if (L <= 170) midtoneIdx.push(i);
      else highlightIdx.push(i);
      const [, s] = rgbToHsl(r, g, b);
      totalSat += s;
      pixelCount++;
    }
  }

  const shadowHue    = avgRgbBucket(data, shadowIdx);
  const midtoneHue   = avgRgbBucket(data, midtoneIdx);
  const highlightHue = avgRgbBucket(data, highlightIdx);

  const averageTemperature = rbRatioToKelvin(highlightHue[0], highlightHue[2]);
  const averageSaturation  = pixelCount > 0 ? totalSat / pixelCount : 0;

  const shadowAvgL = shadowIdx.length
    ? shadowIdx.reduce((s, i) => s + (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]), 0) / shadowIdx.length
    : 0;
  const highlightAvgL = highlightIdx.length
    ? highlightIdx.reduce((s, i) => s + (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]), 0) / highlightIdx.length
    : 255;
  const contrastRatio = shadowAvgL > 0 ? highlightAvgL / shadowAvgL : highlightAvgL;

  const avgL = luminances.reduce((s, v) => s + v, 0) / luminances.length;
  const exposureBias = (avgL - 127.5) / 127.5;
  const variance = luminances.reduce((s, v) => s + (v - avgL) ** 2, 0) / luminances.length;
  const stdDev = Math.sqrt(variance);
  const toneCurveShape = inferToneCurveShape(shadowAvgL, highlightAvgL, stdDev);

  return {
    averageTemperature, averageSaturation, contrastRatio,
    shadowHue, midtoneHue, highlightHue, exposureBias, toneCurveShape,
  };
}

// ─── Spec Section 4.4 Step 1: decode to 400×400 offscreen canvas ─────────────

async function decodeToCanvas(file: File): Promise<{ imageData: ImageData }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload  = () => resolve();
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 400; canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, 400, 400);
  return { imageData: ctx.getImageData(0, 0, 400, 400) };
}

// Generate 120×80 thumbnail with letterboxing
async function generateThumbnail(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload  = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });
  const W = 120, H = 80;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  const sw = img.naturalWidth * scale, sh = img.naturalHeight * scale;
  ctx.drawImage(img, (W - sw) / 2, (H - sh) / 2, sw, sh);
  return canvas.toDataURL("image/jpeg", 0.8);
}

// Entry point: accepts a File, returns a fully populated ReferenceImage
export async function importReference(file: File): Promise<ReferenceImage> {
  const [{ imageData }, thumbnailDataUrl] = await Promise.all([
    decodeToCanvas(file),
    generateThumbnail(file),
  ]);
  const extractedProfile = extractColorProfile(imageData);
  return {
    id: crypto.randomUUID(),
    filename: file.name,
    thumbnailDataUrl,
    extractedProfile,
    weight: 1.0,
    activeAttributes: {
      toneCurve: true,
      colorTemperature: true,
      saturation: true,
      contrast: true,
      shadowColor: true,
      highlightColor: true,
    },
  };
}

// ─── Spec Section 4.5: apply references → effective AdjustmentState ───────────

/**
 * Tone curve shape → absolute target values for each affected slider.
 * Returned targets are expressed relative to the base so that lerp at
 * weight=1 adds the full preset offset from whatever the user has set.
 */
function toneCurveTargets(
  shape: ColorProfile["toneCurveShape"],
  base: AdjustmentState
): Partial<AdjustmentState> {
  switch (shape) {
    case "lifted_blacks":
      return { blacks: base.blacks + 25, shadows: base.shadows + 20 };
    case "crushed_blacks":
      return { blacks: base.blacks - 30, shadows: base.shadows - 15 };
    case "high_contrast":
      return { contrast: base.contrast + 30, blacks: base.blacks - 20, highlights: base.highlights - 15 };
    case "low_contrast":
      return { contrast: base.contrast - 20, blacks: base.blacks + 15, highlights: base.highlights + 20 };
    case "flat":
    default:
      return {};
  }
}

/**
 * Spec Section 4.5: for a single ReferenceImage, return per-attribute ABSOLUTE
 * target values (i.e., what the slider should be at weight=1.0).
 * Only includes entries for attributes that are active.
 */
function referenceTargets(ref: ReferenceImage, base: AdjustmentState): Partial<AdjustmentState> {
  const p = ref.extractedProfile;
  const a = ref.activeAttributes;
  const targets: Partial<AdjustmentState> = {};

  // Temperature: "replaces current value, scaled by weight" (spec 4.5)
  if (a.colorTemperature) {
    targets.temperature = p.averageTemperature;
  }

  // Saturation: averageSaturation 0..1 maps to -100..+100 slider
  // 0.5 = neutral → 0 contribution; 1.0 → +100; 0.0 → -100
  if (a.saturation) {
    targets.saturation = clamp((p.averageSaturation * 2 - 1) * 100, -100, 100);
  }

  // Contrast: contrastRatio ~1=flat, ~2=neutral, ~5+=contrasty
  if (a.contrast) {
    targets.contrast = clamp((p.contrastRatio - 2.0) / 3.0 * 100, -100, 100);
  }

  // Shadow color: green bias in shadows → tint (neg=green, pos=magenta)
  if (a.shadowColor) {
    const g  = p.shadowHue[1] / 255;
    const rb = (p.shadowHue[0] + p.shadowHue[2]) / 2 / 255;
    targets.tint = clamp(-(g - rb) * 300, -150, 150);
  }

  // Highlight color: brightness of highlights → whites slider
  if (a.highlightColor) {
    const lum = (p.highlightHue[0] * 0.299 + p.highlightHue[1] * 0.587 + p.highlightHue[2] * 0.114) / 255;
    targets.whites = clamp((lum - 0.82) * 200, -100, 100);
  }

  // Tone curve: shape preset maps to contrast + blacks + shadows + highlights
  if (a.toneCurve) {
    Object.assign(targets, toneCurveTargets(p.toneCurveShape, base));
  }

  return targets;
}

/**
 * Spec Section 4.5: translate all active ReferenceImages into an effective
 * AdjustmentState using a weighted average of each reference's contribution.
 *
 * For each attribute:
 *   1. Gather contributions from every reference that has the attribute active.
 *   2. Compute the weighted average target value across those references.
 *   3. Lerp from the base value to that average at min(1.0, totalWeight).
 *
 * This ensures weight=0 has no effect and that multiple references average
 * their contributions rather than stacking them unboundedly.
 */
export function applyReferencesToAdjustments(
  base: AdjustmentState,
  refs: ReferenceImage[]
): AdjustmentState {
  const active = refs.filter((r) => r.weight > 0);
  if (!active.length) return base;

  // Accumulate per-attribute weighted sums and total weights
  const weightSum: Partial<Record<keyof AdjustmentState, number>> = {};
  const valueSum:  Partial<Record<keyof AdjustmentState, number>> = {};

  for (const ref of active) {
    const targets = referenceTargets(ref, base);
    for (const [key, target] of Object.entries(targets) as [keyof AdjustmentState, number][]) {
      weightSum[key] = (weightSum[key] ?? 0) + ref.weight;
      valueSum[key]  = (valueSum[key]  ?? 0) + target * ref.weight;
    }
  }

  // Lerp each affected attribute from base toward weighted average
  const effective: AdjustmentState = { ...base };
  for (const key of Object.keys(weightSum) as (keyof AdjustmentState)[]) {
    const totalW = weightSum[key]!;
    const avg    = valueSum[key]! / totalW;
    (effective as unknown as Record<string, number>)[key] = lerp(base[key], avg, Math.min(1.0, totalW));
  }

  // Clamp all values to spec-defined ranges
  return {
    exposure:    clamp(effective.exposure,    -5,     5),
    contrast:    clamp(effective.contrast,    -100,   100),
    highlights:  clamp(effective.highlights,  -100,   100),
    shadows:     clamp(effective.shadows,     -100,   100),
    whites:      clamp(effective.whites,      -100,   100),
    blacks:      clamp(effective.blacks,      -100,   100),
    clarity:     clamp(effective.clarity,     -100,   100),
    vibrance:    clamp(effective.vibrance,    -100,   100),
    saturation:  clamp(effective.saturation,  -100,   100),
    temperature: clamp(effective.temperature, 2000,   50000),
    tint:        clamp(effective.tint,        -150,   150),
  };
}
