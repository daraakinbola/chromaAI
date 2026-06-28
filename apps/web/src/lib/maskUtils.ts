// Client-side mask generation and manipulation utilities (Phase 3 PRD Section 4)

export interface ImagePixelData {
  data: Uint8ClampedArray; // RGBA, width × height × 4
  width: number;
  height: number;
}

const MAX_MASK_PIXELS = 3840 * 2160;

/** Compute working mask resolution (same cap as WebGL renderer). */
export function getMaskResolution(imageWidth: number, imageHeight: number): { w: number; h: number } {
  if (imageWidth * imageHeight <= MAX_MASK_PIXELS) return { w: imageWidth, h: imageHeight };
  const scale = Math.sqrt(MAX_MASK_PIXELS / (imageWidth * imageHeight));
  return { w: Math.round(imageWidth * scale), h: Math.round(imageHeight * scale) };
}

/** Decode image data URL into RGBA pixel data at working resolution. */
export function getImagePixelData(dataUrl: string, maxW: number, maxH: number): Promise<ImagePixelData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = maxW;
      canvas.height = maxH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("No 2D context")); return; }
      ctx.drawImage(img, 0, 0, maxW, maxH);
      resolve({ data: ctx.getImageData(0, 0, maxW, maxH).data as Uint8ClampedArray, width: maxW, height: maxH });
    };
    img.onerror = () => reject(new Error("Failed to decode image for masking"));
    img.src = dataUrl;
  });
}

// ─── Gaussian approximation (3 box-blur passes) ──────────────────────────────

function boxBlurH(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const dst = new Float32Array(w * h);
  const inv = 1 / (r * 2 + 1);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      dst[y * w + x] = sum * inv;
      sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  return dst;
}

function boxBlurV(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const dst = new Float32Array(w * h);
  const inv = 1 / (r * 2 + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += src[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
  return dst;
}

export function gaussianBlurMask(mask: Uint8ClampedArray, width: number, height: number, radius: number): Uint8ClampedArray {
  if (radius < 1) return mask;
  const r = Math.max(1, Math.round(radius));
  let buf: Float32Array<ArrayBufferLike> = new Float32Array(mask);
  for (let pass = 0; pass < 3; pass++) {
    buf = boxBlurH(buf, width, height, r);
    buf = boxBlurV(buf, width, height, r);
  }
  const out = new Uint8ClampedArray(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(255, Math.max(0, buf[i])));
  return out;
}

// ─── Mask generators ─────────────────────────────────────────────────────────

/** Generate a luminance range mask. White = pixels within [min, max] luminance. */
export function generateLuminanceMask(
  pixels: ImagePixelData,
  min: number,
  max: number,
  featherRadius = 0,
): Uint8ClampedArray {
  const { data, width, height } = pixels;
  const mask = new Uint8ClampedArray(width * height);
  const feather = Math.max(1, (max - min) * 0.08); // soft edge ≈ 8% of range
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let v = 0;
    if (lum >= min && lum <= max) {
      v = 255;
    } else if (lum < min && lum >= min - feather) {
      v = Math.round(255 * (lum - (min - feather)) / feather);
    } else if (lum > max && lum <= max + feather) {
      v = Math.round(255 * (1 - (lum - max) / feather));
    }
    mask[i] = Math.max(0, Math.min(255, v));
  }
  return featherRadius > 0 ? gaussianBlurMask(mask, width, height, featherRadius) : mask;
}

function rgbToHS(r: number, g: number, b: number): { h: number; s: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta > 0.001) {
    if (max === r)      h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else                h = 60 * ((r - g) / delta + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max < 0.001 ? 0 : delta / max };
}

/** Generate a color range mask. White = pixels with hue near `hue` and saturation ≥ satMin. */
export function generateColorRangeMask(
  pixels: ImagePixelData,
  hue: number,
  hueRange: number,
  satMin: number,
  featherRadius = 0,
): Uint8ClampedArray {
  const { data, width, height } = pixels;
  const mask = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const { h, s } = rgbToHS(r, g, b);
    if (s < satMin) { mask[i] = 0; continue; }
    let diff = Math.abs(h - hue);
    if (diff > 180) diff = 360 - diff;
    mask[i] = diff <= hueRange ? Math.round(255 * (1 - diff / hueRange)) : 0;
  }
  return featherRadius > 0 ? gaussianBlurMask(mask, width, height, featherRadius) : mask;
}

/** Invert a mask. */
export function invertMask(mask: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - mask[i];
  return out;
}

// ─── Brush painting ──────────────────────────────────────────────────────────

/**
 * Paint (or erase) a soft-edged brush stroke into a grayscale mask in-place.
 * cx, cy: center in mask pixel coordinates.
 */
export function paintBrush(
  maskData: Uint8ClampedArray,
  maskWidth: number,
  maskHeight: number,
  cx: number,
  cy: number,
  radius: number,
  hardness: number, // 0=softest, 1=hard edge
  erase: boolean,
): void {
  const softZone = radius * (1 - hardness);
  const xMin = Math.max(0, Math.floor(cx - radius));
  const xMax = Math.min(maskWidth - 1, Math.ceil(cx + radius));
  const yMin = Math.max(0, Math.floor(cy - radius));
  const yMax = Math.min(maskHeight - 1, Math.ceil(cy + radius));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > radius) continue;
      let alpha = 1;
      if (softZone > 0 && dist > radius - softZone) {
        alpha = 1 - (dist - (radius - softZone)) / softZone;
      }
      const idx = y * maskWidth + x;
      if (erase) {
        maskData[idx] = Math.max(0, Math.round(maskData[idx] - 255 * alpha));
      } else {
        maskData[idx] = Math.min(255, Math.round(maskData[idx] + 255 * alpha));
      }
    }
  }
}

// ─── PNG encode / decode ──────────────────────────────────────────────────────

/** Encode grayscale mask (one byte per pixel) as a PNG data URL. */
export function maskToPng(mask: Uint8ClampedArray, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imgData = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const v = mask[i];
    imgData.data[i * 4]     = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Decode a grayscale PNG data URL back to a Uint8ClampedArray (one byte per pixel). */
export function pngToMask(pngDataUrl: string, width: number, height: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const mask = new Uint8ClampedArray(width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4];
      resolve(mask);
    };
    img.onerror = () => reject(new Error("Failed to decode mask PNG"));
    img.src = pngDataUrl;
  });
}

/** Create an all-black (transparent) mask PNG for a brush layer. */
export function createEmptyMaskPng(width: number, height: number): string {
  return maskToPng(new Uint8ClampedArray(width * height), width, height);
}

/** Sample the hue of the pixel nearest to (x, y) in image pixel space. */
export function sampleHue(pixels: ImagePixelData, x: number, y: number): number {
  const px = Math.max(0, Math.min(pixels.width - 1, Math.round(x)));
  const py = Math.max(0, Math.min(pixels.height - 1, Math.round(y)));
  const i = (py * pixels.width + px) * 4;
  const r = pixels.data[i] / 255, g = pixels.data[i + 1] / 255, b = pixels.data[i + 2] / 255;
  return rgbToHS(r, g, b).h;
}
