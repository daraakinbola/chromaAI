/**
 * maskWorker — off-main-thread mask generation (PRD Section 5.2)
 * Runs luminance and color range mask generation in a dedicated worker so
 * the UI stays responsive while iterating on mask parameters.
 */
import { expose } from "comlink";
import {
  generateLuminanceMask,
  generateColorRangeMask,
  gaussianBlurMask,
  invertMask,
} from "@/lib/maskUtils";
import type { LuminanceMaskParams, ColorMaskParams } from "@/types";

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
