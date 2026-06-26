import type { ImageRecord } from "@/types";
import { buildCssFilter } from "@/lib/cssFilters";

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp";
export type ExportResolution = "full" | "2k" | "1080p";

export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 0.5 | 0.75 | 0.90 | 1.0
  resolution: ExportResolution;
}

function resolveResolution(
  origW: number,
  origH: number,
  resolution: ExportResolution
): { width: number; height: number } {
  if (resolution === "full") return { width: origW, height: origH };
  const maxW = resolution === "2k" ? 2048 : 1920;
  if (origW <= maxW) return { width: origW, height: origH };
  const scale = maxW / origW;
  return { width: maxW, height: Math.round(origH * scale) };
}

// Spec Section 5.3 Step 2-6
export async function exportImage(image: ImageRecord, options: ExportOptions): Promise<void> {
  const { format, quality, resolution } = options;
  const { width, height } = resolveResolution(image.width, image.height, resolution);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D canvas context");

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image for export"));
    img.src = image.originalDataUrl;
  });

  const filterStr = buildCssFilter(image.adjustments);
  if (filterStr !== "none") ctx.filter = filterStr;
  ctx.drawImage(img, 0, 0, width, height);

  const ext = format === "image/png" ? "png" : format === "image/webp" ? "webp" : "jpg";
  const base = image.filename.replace(/\.[^.]+$/, "");
  const filename = `${base}_chromaai.${ext}`;

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      format,
      format === "image/png" ? undefined : quality
    );
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
