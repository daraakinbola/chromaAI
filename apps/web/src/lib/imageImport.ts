import type { ImageRecord, AdjustmentState } from "@/types";
import { defaultAdjustmentState } from "@/types";

// Accepted types per Section 2.2 of Phase 2 TechSpec
export const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
]);

// Used as the <input accept="..."> attribute value
export const ACCEPTED_EXTENSIONS =
  ".jpg,.jpeg,.png,.webp,.tif,.tiff,image/jpeg,image/png,image/webp,image/tiff";

const THUMB_W = 200;
const THUMB_H = 133;

// ─── Low-level helpers ───────────────────────────────────────────────────────

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`FileReader failed for ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`FileReader failed for ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to decode"));
    img.src = src;
  });
}

// ─── Thumbnail generation (200×133, letterboxed, Section 2.4 Step 3) ────────

function generateThumbnail(
  img: HTMLImageElement
): { thumbnailDataUrl: string; width: number; height: number } {
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext("2d")!;

  // Black letterbox background
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);

  const imgAspect = img.naturalWidth / img.naturalHeight;
  const thumbAspect = THUMB_W / THUMB_H;

  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (imgAspect > thumbAspect) {
    // Wider than thumb — fit to width, letterbox top/bottom
    drawW = THUMB_W;
    drawH = THUMB_W / imgAspect;
    drawX = 0;
    drawY = (THUMB_H - drawH) / 2;
  } else {
    // Taller than thumb — fit to height, letterbox left/right
    drawH = THUMB_H;
    drawW = THUMB_H * imgAspect;
    drawX = (THUMB_W - drawW) / 2;
    drawY = 0;
  }

  ctx.drawImage(img, drawX, drawY, drawW, drawH);
  return {
    thumbnailDataUrl: canvas.toDataURL("image/jpeg", 0.8),
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

// ─── TIFF decode (Section 2.2 — requires tiff library) ──────────────────────

async function decodeTiffToDataUrl(file: File): Promise<string> {
  // Dynamic import keeps tiff out of the SSR bundle
  const { decode } = await import("tiff");
  const buffer = await readFileAsArrayBuffer(file);
  const ifds = decode(buffer);
  if (!ifds.length) throw new Error("TIFF contains no images");

  const ifd = ifds[0];
  const { width, height, data, samplesPerPixel = 3 } = ifd as {
    width: number;
    height: number;
    data: Uint8Array | Uint16Array;
    samplesPerPixel: number;
  };

  // Normalise to 8-bit: 16-bit TIFFs divide by 257 (65535/255)
  const is16bit = data instanceof Uint16Array;
  const scale = is16bit ? 1 / 257 : 1;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (samplesPerPixel === 4) {
      rgba[i * 4]     = data[i * 4] * scale;
      rgba[i * 4 + 1] = data[i * 4 + 1] * scale;
      rgba[i * 4 + 2] = data[i * 4 + 2] * scale;
      rgba[i * 4 + 3] = data[i * 4 + 3] * scale;
    } else if (samplesPerPixel === 3) {
      rgba[i * 4]     = data[i * 3] * scale;
      rgba[i * 4 + 1] = data[i * 3 + 1] * scale;
      rgba[i * 4 + 2] = data[i * 3 + 2] * scale;
      rgba[i * 4 + 3] = 255;
    } else {
      // Grayscale
      const v = data[i] * scale;
      rgba[i * 4]     = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

// ─── Public: import a single File → ImageRecord (Section 2.4) ───────────────

export async function importFile(file: File): Promise<ImageRecord> {
  const mimeType = file.type || "image/jpeg";

  if (!ACCEPTED_MIME_TYPES.has(mimeType) && !isAcceptedByExtension(file.name)) {
    throw new Error(`Unsupported file type: ${file.name}`);
  }

  let dataUrl: string;
  if (mimeType === "image/tiff" || /\.tiff?$/i.test(file.name)) {
    dataUrl = await decodeTiffToDataUrl(file);
  } else {
    // Step 2: FileReader.readAsDataURL() — result is the originalDataUrl
    dataUrl = await readFileAsDataUrl(file);
  }

  // Step 3: decode to HTMLImageElement to get natural dimensions + thumbnail
  const img = await loadImage(dataUrl);
  const { thumbnailDataUrl, width, height } = generateThumbnail(img);

  // Step 4: build ImageRecord with default AdjustmentState
  const record: ImageRecord = {
    id: crypto.randomUUID(),
    filename: file.name,
    mimeType,
    originalDataUrl: dataUrl, // never mutated after this point
    thumbnailDataUrl,
    width,
    height,
    importedAt: Date.now(),
    adjustments: { ...defaultAdjustmentState },
    consistencyScore: 100,  // recalculated by batch engine after import
    flagged: false,
  };

  return record;
}

function isAcceptedByExtension(filename: string): boolean {
  return /\.(jpe?g|png|webp|tiff?)$/i.test(filename);
}

// ─── Public: import multiple files with per-file progress callback ───────────

export async function importFiles(
  files: File[],
  onProgress: (current: number, total: number) => void,
  onError: (filename: string, message: string) => void
): Promise<ImageRecord[]> {
  const results: ImageRecord[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress(i, files.length);
    try {
      const record = await importFile(files[i]);
      results.push(record);
    } catch (err) {
      onError(files[i].name, err instanceof Error ? err.message : String(err));
    }
  }
  onProgress(files.length, files.length);
  return results;
}
