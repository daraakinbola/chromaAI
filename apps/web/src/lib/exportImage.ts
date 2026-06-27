import JSZip from "jszip";
import { WebGLRenderer, webglSupported } from "@/lib/webglRenderer";
import type { AdjustmentState, ColorWheelState, CurveState, HslAdjustments, ImageRecord } from "@/types";
import { defaultColorWheelState, defaultCurveState, defaultHslAdjustments } from "@/types";

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp";
export type ExportResolution = "full" | "2k" | "1080p";
export type ExportScope = "active" | "all";

export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 0.5 | 0.75 | 0.90 | 1.0
  resolution: ExportResolution;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function outputFilename(image: ImageRecord, format: ExportFormat): string {
  const ext = format === "image/png" ? "png" : format === "image/webp" ? "webp" : "jpg";
  const base = image.filename.replace(/\.[^.]+$/, "");
  return `${base}_chromaai.${ext}`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Core render-to-blob ──────────────────────────────────────────────────────

/**
 * Renders one image to a Blob using the provided adjustments.
 *
 * `adjustments` is passed explicitly — callers supply effectiveAdjustments
 * (base + reference contributions) so that reference effects are baked into
 * exports, matching what the canvas preview shows (spec Section 5.5).
 */
async function renderToBlob(
  image: ImageRecord,
  options: ExportOptions,
  adjustments: AdjustmentState,
  hsl: HslAdjustments = defaultHslAdjustments,
  colorWheels: ColorWheelState = defaultColorWheelState,
  curveState: CurveState = defaultCurveState
): Promise<Blob> {
  const { format, quality, resolution } = options;
  const { width, height } = resolveResolution(image.width, image.height, resolution);

  if (webglSupported()) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const renderer = new WebGLRenderer(canvas);
    try {
      await renderer.loadImage(image.originalDataUrl);
      renderer.drawSync(adjustments, hsl, colorWheels, curveState);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
          format,
          format === "image/png" ? undefined : quality
        );
      });
    } finally {
      renderer.destroy();
    }
  } else {
    // CSS-filter fallback for browsers without WebGL
    const { buildCssFilter } = await import("@/lib/cssFilters");
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
    const filterStr = buildCssFilter(adjustments);
    if (filterStr !== "none") ctx.filter = filterStr;
    ctx.drawImage(img, 0, 0, width, height);
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        format,
        format === "image/png" ? undefined : quality
      );
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Spec Section 5.3: export the active image and trigger a browser download.
 * Pass `effectiveAdjustments` from WorkspaceContext to bake in reference effects.
 */
export async function exportImage(
  image: ImageRecord,
  options: ExportOptions,
  adjustments: AdjustmentState,
  hsl: HslAdjustments = defaultHslAdjustments,
  colorWheels: ColorWheelState = defaultColorWheelState,
  curveState: CurveState = defaultCurveState
): Promise<void> {
  const blob = await renderToBlob(image, options, adjustments, hsl, colorWheels, curveState);
  triggerDownload(blob, outputFilename(image, options.format));
}

/**
 * Spec Section 5.4: batch export.
 *
 * Each image in `images` should already have its effective adjustments set
 * (i.e., `image.adjustments = applyReferencesToAdjustments(base, refs)`).
 * ExportModal pre-patches the array before calling this function.
 */
export async function batchExportImages(
  images: ImageRecord[],
  options: ExportOptions,
  onProgress: (done: number, total: number) => void,
  hsl: HslAdjustments = defaultHslAdjustments,
  colorWheels: ColorWheelState = defaultColorWheelState,
  curveState: CurveState = defaultCurveState
): Promise<void> {
  const zip = new JSZip();
  const total = images.length;

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const blob = await renderToBlob(image, options, image.adjustments, hsl, colorWheels, curveState);
    zip.file(outputFilename(image, options.format), blob);
    onProgress(i + 1, total);
  }

  // JPEG/PNG/WebP are already compressed — STORE avoids double-compression
  // and keeps batch of 10×10MB within the 30s spec budget (Section 5.5).
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  triggerDownload(zipBlob, `chromaai_export_${timestamp}.zip`);
}
