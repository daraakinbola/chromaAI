/**
 * RAW file decoding — PRD §3 + §7 (libraw-wasm integration).
 *
 * Primary path: libraw-wasm (client-side WASM, no network round-trip).
 * libraw-wasm spawns its own Web Worker internally so the main thread is
 * not blocked during decode.
 *
 * Fallback: FastAPI /raw/decode endpoint (for browsers where WASM fails or
 * when libraw-wasm throws during initialisation).
 */

import type LibRawType from "libraw-wasm";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const RAW_EXTENSIONS = new Set([
  ".arw", ".cr2", ".cr3", ".nef", ".nrw",
  ".raf", ".dng", ".rw2", ".orf", ".rwl",
]);

export function isRawFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return RAW_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

export interface RawDecodeResult {
  dataUrl: string;
  width: number;
  height: number;
  cameraTemperature: number;
}

// ─── libraw-wasm client-side decode ──────────────────────────────────────────

async function decodeRawWasm(file: File): Promise<RawDecodeResult> {
  const { default: LibRaw } = await import("libraw-wasm") as { default: typeof LibRawType };
  const buffer = await file.arrayBuffer();
  const lr = new LibRaw();
  try {
    await lr.open(buffer, {
      useCameraWb: true,
      userQual: 3,       // AHD (Adaptive Homogeneity-Directed) demosaicing
      highlight: 1,      // Blend highlight recovery (PRD §3.3)
      outputBps: 8,      // Force 8-bit output for canvas compatibility
    });

    const [meta, imgData] = await Promise.all([lr.metadata(true), lr.imageData()]);
    if (!imgData) throw new Error("libraw-wasm returned no image data");

    const { width, height, data, bits, colors } = imgData;
    const scale = bits === 16 ? 1 / 256 : 1;

    // Convert RGB/RGBA pixel data to RGBA Uint8ClampedArray for canvas
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      if (colors >= 3) {
        rgba[i * 4]     = Math.min(255, Math.round((data[i * colors]     as number) * scale));
        rgba[i * 4 + 1] = Math.min(255, Math.round((data[i * colors + 1] as number) * scale));
        rgba[i * 4 + 2] = Math.min(255, Math.round((data[i * colors + 2] as number) * scale));
      } else {
        const v = Math.min(255, Math.round((data[i] as number) * scale));
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
      }
      rgba[i * 4 + 3] = 255;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.95);

    // Derive colour temperature from camera white-balance multipliers.
    // cam_mul = [R, G1, B, G2] multipliers; higher R/B ratio → warmer (lower K).
    const camMul = meta?.color_data?.cam_mul;
    let cameraTemperature = 5500;
    if (camMul && camMul.length >= 3 && camMul[1] > 0 && camMul[2] > 0) {
      const rbRatio = camMul[0] / camMul[2];
      // Empirical linear approximation: rbRatio 0.8 → ~9000K, 2.5 → ~2700K
      cameraTemperature = Math.round(Math.max(2000, Math.min(10000,
        9000 - (rbRatio - 0.8) * (9000 - 2700) / (2.5 - 0.8)
      )));
    }

    return { dataUrl, width, height, cameraTemperature };
  } finally {
    lr.dispose();
  }
}

// ─── API fallback ─────────────────────────────────────────────────────────────

async function decodeRawApi(file: File): Promise<RawDecodeResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/raw/decode`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => res.statusText);
    throw new Error(`RAW decode failed: ${detail}`);
  }
  return res.json() as Promise<RawDecodeResult>;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Decode a RAW file to a JPEG data URL + metadata.
 * Tries libraw-wasm first (client-side, no network); falls back to the
 * FastAPI /raw/decode endpoint if WASM initialisation or decode fails.
 */
export async function decodeRawFile(file: File): Promise<RawDecodeResult> {
  try {
    return await decodeRawWasm(file);
  } catch (wasmErr) {
    console.warn("[ChromaAI] libraw-wasm decode failed, falling back to API:", wasmErr);
    return decodeRawApi(file);
  }
}
