/**
 * maskWorker — off-main-thread mask generation (PRD §5.2 + §7)
 *
 * Handles three mask categories:
 *  1. Luminance range masks — client-side pixel analysis
 *  2. Color range masks    — client-side pixel analysis
 *  3. AI segmentation      — @xenova/transformers SegFormer inference (PRD §7)
 *     subject / sky / background masks via Xenova/segformer-b0-finetuned-ade-512-512
 *     Model is lazy-loaded on first use and cached in the browser's Cache Storage.
 */
import { expose } from "comlink";
import { pipeline, env } from "@xenova/transformers";
import {
  generateLuminanceMask,
  generateColorRangeMask,
  gaussianBlurMask,
  invertMask,
} from "@/lib/maskUtils";
import type { LuminanceMaskParams, ColorMaskParams } from "@/types";

// Configure transformers.js: allow model downloads from HuggingFace Hub,
// cache models in the browser's Cache Storage (persists across sessions).
env.allowLocalModels = false;

// ─── Segmentation pipeline singleton ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _segPipeline: any = null;

async function getSegPipeline() {
  if (!_segPipeline) {
    // segformer-b0 is ~6 MB quantized — fast to download, accurate enough for V1.
    // The first call triggers a download; subsequent calls use the Cache Storage copy.
    _segPipeline = await pipeline(
      "image-segmentation",
      "Xenova/segformer-b2-finetuned-ade-512-512",
    );
  }
  return _segPipeline;
}

// ADE20K semantic labels mapped to our mask type categories
const SUBJECT_LABELS = new Set([
  "person", "man", "woman", "boy", "girl", "child", "people",
  "animal", "cat", "dog", "horse", "cow", "sheep", "bird",
]);
const SKY_LABELS = new Set(["sky"]);

// Resize a single-channel mask (Uint8ClampedArray, values 0/255) to dstW×dstH
async function resizeMaskChannel(
  src: Uint8ClampedArray, srcW: number, srcH: number,
  dstW: number, dstH: number,
): Promise<Uint8ClampedArray> {
  // Expand to RGBA for createImageBitmap, then downsample via OffscreenCanvas
  const rgba = new Uint8ClampedArray(srcW * srcH * 4);
  for (let i = 0; i < srcW * srcH; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = src[i];
    rgba[i * 4 + 3] = 255;
  }
  const srcCanvas = new OffscreenCanvas(srcW, srcH);
  srcCanvas.getContext("2d")!.putImageData(new ImageData(rgba, srcW, srcH), 0, 0);
  const bmp = await createImageBitmap(srcCanvas, { resizeWidth: dstW, resizeHeight: dstH, resizeQuality: "pixelated" });
  const dstCanvas = new OffscreenCanvas(dstW, dstH);
  dstCanvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const dstRgba = dstCanvas.getContext("2d")!.getImageData(0, 0, dstW, dstH).data;
  const gray = new Uint8ClampedArray(dstW * dstH);
  for (let i = 0; i < dstW * dstH; i++) gray[i] = dstRgba[i * 4];
  return gray;
}

async function decodeToPixels(
  dataUrl: string,
  w: number,
  h: number,
): Promise<Uint8ClampedArray> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: "pixelated",
  });
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return ctx.getImageData(0, 0, w, h).data as Uint8ClampedArray;
}

async function encodeToPng(mask: Uint8ClampedArray, w: number, h: number): Promise<string> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  const id = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = mask[i];
    id.data[i * 4]     = v;
    id.data[i * 4 + 1] = v;
    id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  // ArrayBuffer → base64 in chunks to avoid stack overflow
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return "data:image/png;base64," + btoa(binary);
}

const maskWorkerApi = {
  /**
   * PRD §7: AI segmentation via @xenova/transformers SegFormer.
   * Downloads the model on first call (~100 MB, cached in Cache Storage).
   * Returns a PNG data URL mask for the requested segment type.
   */
  async generateSegmentationMaskPng(
    dataUrl: string,
    maskW: number,
    maskH: number,
    type: "subject" | "sky" | "background",
    featherRadius: number,
    inverted: boolean,
  ): Promise<string> {
    const pipe = await getSegPipeline();
    // Run semantic segmentation; SegFormer returns one entry per detected class
    const segments: Array<{ label: string; score: number | null; mask: { data: Uint8ClampedArray; width: number; height: number } }> =
      await pipe(dataUrl, { subtask: "semantic" });

    const combined = new Uint8ClampedArray(maskW * maskH); // start as all-zero

    for (const seg of segments) {
      const isSubject = SUBJECT_LABELS.has(seg.label);
      const isSky = SKY_LABELS.has(seg.label);
      const include =
        type === "subject"    ? isSubject :
        type === "sky"        ? isSky :
        /* background */        !isSubject && !isSky;

      if (!include) continue;

      const { data, width, height } = seg.mask;
      const resized = await resizeMaskChannel(data, width, height, maskW, maskH);
      // OR-blend: any pixel covered by a matching segment becomes white
      for (let i = 0; i < maskW * maskH; i++) {
        if (resized[i] > 127) combined[i] = 255;
      }
    }

    let mask: Uint8ClampedArray<ArrayBufferLike> = combined;
    if (featherRadius > 0) mask = gaussianBlurMask(mask, maskW, maskH, featherRadius);
    if (inverted) mask = invertMask(mask);
    return encodeToPng(mask, maskW, maskH);
  },

  async generateLuminanceMaskPng(
    dataUrl: string,
    maskW: number,
    maskH: number,
    params: LuminanceMaskParams,
    featherRadius: number,
    inverted: boolean,
  ): Promise<string> {
    const rgba = await decodeToPixels(dataUrl, maskW, maskH);
    let mask = generateLuminanceMask(
      { data: rgba, width: maskW, height: maskH },
      params.min,
      params.max,
    );
    if (featherRadius > 0) mask = gaussianBlurMask(mask, maskW, maskH, featherRadius);
    if (inverted) mask = invertMask(mask);
    return encodeToPng(mask, maskW, maskH);
  },

  async generateColorRangeMaskPng(
    dataUrl: string,
    maskW: number,
    maskH: number,
    params: ColorMaskParams,
    featherRadius: number,
    inverted: boolean,
  ): Promise<string> {
    const rgba = await decodeToPixels(dataUrl, maskW, maskH);
    let mask = generateColorRangeMask(
      { data: rgba, width: maskW, height: maskH },
      params.hue,
      params.hueRange,
      params.satMin,
    );
    if (featherRadius > 0) mask = gaussianBlurMask(mask, maskW, maskH, featherRadius);
    if (inverted) mask = invertMask(mask);
    return encodeToPng(mask, maskW, maskH);
  },
};

expose(maskWorkerApi);
export type MaskWorkerApi = typeof maskWorkerApi;
