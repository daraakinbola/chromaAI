/**
 * imageWorker — off-main-thread thumbnail generation (PRD Section 5.2)
 * Decodes images and renders thumbnails in a dedicated worker, keeping the
 * import pipeline non-blocking when importing batches of files.
 */
import { expose } from "comlink";

const THUMB_W = 200;
const THUMB_H = 133;

async function blobToDataUrl(blob: Blob, mimeType: string): Promise<string> {
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return `data:${mimeType};base64,` + btoa(binary);
}

async function fetchBitmap(dataUrl: string): Promise<ImageBitmap> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  return createImageBitmap(blob);
}

const imageWorkerApi = {
  async generateThumbnail(dataUrl: string): Promise<string> {
    const bitmap = await fetchBitmap(dataUrl);
    const imgAspect = bitmap.width / bitmap.height;
    const thumbAspect = THUMB_W / THUMB_H;

    let drawW: number, drawH: number, drawX: number, drawY: number;
    if (imgAspect > thumbAspect) {
      drawW = THUMB_W;
      drawH = THUMB_W / imgAspect;
      drawX = 0;
      drawY = (THUMB_H - drawH) / 2;
    } else {
      drawH = THUMB_H;
      drawW = THUMB_H * imgAspect;
      drawX = (THUMB_W - drawW) / 2;
      drawY = 0;
    }

    const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, THUMB_W, THUMB_H);
    ctx.drawImage(bitmap, drawX, drawY, drawW, drawH);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    return blobToDataUrl(blob, "image/jpeg");
  },

  async getImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
    const bitmap = await fetchBitmap(dataUrl);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  },
};

expose(imageWorkerApi);
export type ImageWorkerApi = typeof imageWorkerApi;
