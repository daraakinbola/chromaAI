import type { ColorProfile, ReferenceImage } from "@/types";

// Spec Section 4.4: client-side extraction — no server round-trip

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
  // ratio ~2.0 → warm ~2700K, ratio ~1.0 → neutral ~5500K, ratio ~0.6 → cool ~9000K
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
  for (const i of indices) {
    r += pixels[i];
    g += pixels[i + 1];
    b += pixels[i + 2];
  }
  const n = indices.length;
  return [r / n, g / n, b / n];
}

// Spec Section 4.4: full extraction pipeline
export function extractColorProfile(imageData: ImageData): ColorProfile {
  const { data, width, height } = imageData;

  const shadowIdx: number[] = [];
  const midtoneIdx: number[] = [];
  const highlightIdx: number[] = [];
  let totalSat = 0;
  let pixelCount = 0;
  const luminances: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Spec Step 2: luminance formula
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      luminances.push(L);

      // Spec Step 3: bucket by luminance thresholds
      if (L < 85) shadowIdx.push(i);
      else if (L <= 170) midtoneIdx.push(i);
      else highlightIdx.push(i);

      // Spec Step 5: saturation average
      const [, s] = rgbToHsl(r, g, b);
      totalSat += s;
      pixelCount++;
    }
  }

  const shadowHue = avgRgbBucket(data, shadowIdx);
  const midtoneHue = avgRgbBucket(data, midtoneIdx);
  const highlightHue = avgRgbBucket(data, highlightIdx);

  // Spec Step 4: temperature from highlight R/B ratio
  const averageTemperature = rbRatioToKelvin(highlightHue[0], highlightHue[2]);

  // Spec Step 5
  const averageSaturation = pixelCount > 0 ? totalSat / pixelCount : 0;

  // Contrast ratio: highlight avg luminance vs shadow avg luminance
  const shadowAvgL = shadowIdx.length
    ? shadowIdx.reduce((s, i) => s + (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]), 0) / shadowIdx.length
    : 0;
  const highlightAvgL = highlightIdx.length
    ? highlightIdx.reduce((s, i) => s + (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]), 0) / highlightIdx.length
    : 255;
  const contrastRatio = shadowAvgL > 0 ? highlightAvgL / shadowAvgL : highlightAvgL;

  // Exposure bias: how far average luminance is from neutral (127.5)
  const avgL = luminances.reduce((s, v) => s + v, 0) / luminances.length;
  const exposureBias = (avgL - 127.5) / 127.5; // -1 to +1 → EV units

  // Spec Step 6: tone curve shape
  const mean = avgL;
  const variance = luminances.reduce((s, v) => s + (v - mean) ** 2, 0) / luminances.length;
  const stdDev = Math.sqrt(variance);
  const toneCurveShape = inferToneCurveShape(shadowAvgL, highlightAvgL, stdDev);

  return {
    averageTemperature,
    averageSaturation,
    contrastRatio,
    shadowHue,
    midtoneHue,
    highlightHue,
    exposureBias,
    toneCurveShape,
  };
}

// Spec Section 4.4 Step 1: decode to 400×400 offscreen canvas
async function decodeToCanvas(file: File): Promise<{ canvas: HTMLCanvasElement; imageData: ImageData }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = 400;
  canvas.height = 400;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, 400, 400);
  const imageData = ctx.getImageData(0, 0, 400, 400);
  return { canvas, imageData };
}

// Generate 120×80 thumbnail with letterboxing (black background)
async function generateThumbnail(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  const W = 120, H = 80;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  const sw = img.naturalWidth * scale;
  const sh = img.naturalHeight * scale;
  ctx.drawImage(img, (W - sw) / 2, (H - sh) / 2, sw, sh);

  return canvas.toDataURL("image/jpeg", 0.8);
}

// Entry point: accepts a file, returns a fully populated ReferenceImage
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
