import JSZip from "jszip";
import { WebGLRenderer, webglSupported } from "@/lib/webglRenderer";
import type { RendererLocalLayer } from "@/lib/webglRenderer";
import { pngToMask } from "@/lib/maskUtils";
import { getExportWorker } from "@/lib/workerBridge";
import type { AdjustmentState, ColorWheelState, CurveState, HslAdjustments, ImageRecord, LocalAdjustmentLayer } from "@/types";
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
 * Renders one image onto an existing renderer+canvas.
 * Canvas dimensions are resized per image so the caller owns the lifecycle.
 * Used internally by both single-image and batch export paths.
 */
async function _renderOnRenderer(
  renderer: WebGLRenderer,
  canvas: HTMLCanvasElement,
  image: ImageRecord,
  options: ExportOptions,
  adjustments: AdjustmentState,
  hsl: HslAdjustments,
  colorWheels: ColorWheelState,
  curveState: CurveState,
  localLayers: LocalAdjustmentLayer[],
): Promise<Blob> {
  const { format, quality, resolution } = options;
  const { width, height } = resolveResolution(image.width, image.height, resolution);
  const hr = image.highlightRecovery ?? 0;
  const sr = image.shadowRecovery ?? 0;

  canvas.width = width;
  canvas.height = height;

  await renderer.loadImage(image.originalDataUrl);

  const visibleLayers = localLayers
    .filter((l) => l.visible && l.mask?.maskPng && !l.mask.isLoading)
    .slice(0, 4);
  await Promise.all(visibleLayers.map(async (layer, i) => {
    const { maskWidth: mw, maskHeight: mh } = layer.mask!;
    const data = await pngToMask(layer.mask!.maskPng!, mw, mh);
    renderer.updateMaskLayer(i, data, mw, mh);
  }));
  const llUniforms: RendererLocalLayer[] = visibleLayers.map((l) => ({
    opacity: l.opacity,
    adjustments: l.adjustments,
  }));

  renderer.drawSync(adjustments, hsl, colorWheels, curveState, hr, sr, llUniforms);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      format,
      format === "image/png" ? undefined : quality
    );
  });
}

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
  curveState: CurveState = defaultCurveState,
  localLayers: LocalAdjustmentLayer[] = [],
): Promise<Blob> {
  if (webglSupported()) {
    const canvas = document.createElement("canvas");
    const renderer = new WebGLRenderer(canvas);
    try {
      return await _renderOnRenderer(renderer, canvas, image, options, adjustments, hsl, colorWheels, curveState, localLayers);
    } finally {
      renderer.destroy();
    }
  } else {
    // CSS-filter fallback for browsers without WebGL
    const { buildCssFilter } = await import("@/lib/cssFilters");
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
  curveState: CurveState = defaultCurveState,
  localLayers: LocalAdjustmentLayer[] = [],
): Promise<void> {
  const blob = await renderToBlob(image, options, adjustments, hsl, colorWheels, curveState, localLayers);
  triggerDownload(blob, outputFilename(image, options.format));
}

/**
 * Spec Section 5.4: batch export.
 *
 * Each image in `images` should already have its effective adjustments set
 * (i.e., `image.adjustments = applyReferencesToAdjustments(base, refs)`).
 * ExportModal pre-patches the array before calling this function.
 *
 * PRD §5.5 performance: a single WebGL context is created for the entire batch
 * (one context creation + N texture uploads) instead of N context creations.
 * The event loop yields at every `await` so the UI stays responsive throughout.
 */
export async function batchExportImages(
  images: ImageRecord[],
  options: ExportOptions,
  onProgress: (done: number, total: number) => void,
  hsl: HslAdjustments = defaultHslAdjustments,
  colorWheels: ColorWheelState = defaultColorWheelState,
  curveState: CurveState = defaultCurveState,
  localLayers: LocalAdjustmentLayer[] = [],
): Promise<void> {
  const total = images.length;

  // Render all images on the main thread (WebGL requires canvas access).
  // Reuse a single renderer for the whole batch to avoid N context creations.
  const entries: { filename: string; arrayBuffer: ArrayBuffer }[] = [];

  if (webglSupported()) {
    const canvas = document.createElement("canvas");
    const renderer = new WebGLRenderer(canvas);
    try {
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        const blob = await _renderOnRenderer(renderer, canvas, image, options, image.adjustments, hsl, colorWheels, curveState, localLayers);
        entries.push({ filename: outputFilename(image, options.format), arrayBuffer: await blob.arrayBuffer() });
        onProgress(i + 1, total);
      }
    } finally {
      renderer.destroy();
    }
  } else {
    // CSS-filter fallback: reuse a single canvas across the batch
    const { buildCssFilter } = await import("@/lib/cssFilters");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get 2D canvas context");
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const { format, quality, resolution } = options;
      const { width, height } = resolveResolution(image.width, image.height, resolution);
      canvas.width = width;
      canvas.height = height;
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load ${image.filename} for export`));
        img.src = image.originalDataUrl;
      });
      const filterStr = buildCssFilter(image.adjustments);
      ctx.filter = filterStr !== "none" ? filterStr : "none";
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob returned null")), format, format === "image/png" ? undefined : quality)
      );
      entries.push({ filename: outputFilename(image, options.format), arrayBuffer: await blob.arrayBuffer() });
      onProgress(i + 1, total);
    }
  }

  // Package ZIP off the main thread via exportWorker (PRD Section 5.2).
  // Falls back to JSZip on the main thread if the worker is unavailable.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipFilename = `chromaai_export_${timestamp}.zip`;

  const exportWorker = getExportWorker();
  if (exportWorker) {
    // Transfer ArrayBuffers to worker — zero-copy via Transferable
    const zipBuffer = await exportWorker.packageZip(entries);
    triggerDownload(new Blob([zipBuffer], { type: "application/zip" }), zipFilename);
  } else {
    // Fallback: main-thread ZIP
    const zip = new JSZip();
    for (const { filename, arrayBuffer } of entries) zip.file(filename, arrayBuffer);
    const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    triggerDownload(zipBlob, zipFilename);
  }
}
