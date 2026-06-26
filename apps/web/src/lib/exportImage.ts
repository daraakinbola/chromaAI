import JSZip from "jszip";
import { WebGLRenderer, webglSupported } from "@/lib/webglRenderer";
import type { ImageRecord } from "@/types";

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
  // Revoke after a tick so the browser has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Core render-to-blob ──────────────────────────────────────────────────────

/**
 * Renders one ImageRecord with its current adjustments to a Blob.
 *
 * Spec Section 5.3 Step 2–4:
 *   - Full-resolution offscreen canvas at the target export dimensions.
 *   - WebGL shader applies all AdjustmentState values (CSS-filter fallback for
 *     browsers without WebGL).
 *   - canvas.toBlob() at the requested format/quality.
 */
async function renderToBlob(
  image: ImageRecord,
  options: ExportOptions
): Promise<Blob> {
  const { format, quality, resolution } = options;
  const { width, height } = resolveResolution(image.width, image.height, resolution);

  if (webglSupported()) {
    // ── WebGL path ────────────────────────────────────────────────────────────
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const renderer = new WebGLRenderer(canvas);
    try {
      await renderer.loadImage(image.originalDataUrl);
      renderer.drawSync(image.adjustments);
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
    // ── CSS-filter fallback ───────────────────────────────────────────────────
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

    const filterStr = buildCssFilter(image.adjustments);
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
 * Spec Section 5.3: Export the active image and trigger a browser download.
 */
export async function exportImage(image: ImageRecord, options: ExportOptions): Promise<void> {
  const blob = await renderToBlob(image, options);
  triggerDownload(blob, outputFilename(image, options.format));
}

/**
 * Spec Section 5.4: Batch export — processes every ImageRecord sequentially
 * through the WebGL pipeline, packages all output blobs into a ZIP, and
 * triggers a single browser download.
 *
 * @param images  All session images
 * @param options Export format/quality/resolution
 * @param onProgress  Called after each image completes with (done, total)
 */
export async function batchExportImages(
  images: ImageRecord[],
  options: ExportOptions,
  onProgress: (done: number, total: number) => void
): Promise<void> {
  const zip = new JSZip();
  const total = images.length;

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    const blob = await renderToBlob(image, options);
    zip.file(outputFilename(image, options.format), blob);
    onProgress(i + 1, total);
  }

  // Images are already compressed formats — STORE avoids double-compression
  // overhead and keeps the 30-second budget for large batches (spec 5.5).
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  triggerDownload(zipBlob, `chromaai_export_${timestamp}.zip`);
}
