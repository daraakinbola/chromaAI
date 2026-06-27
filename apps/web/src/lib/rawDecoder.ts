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

export async function decodeRawFile(file: File): Promise<RawDecodeResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/raw/decode`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.detail).catch(() => res.statusText);
    throw new Error(`RAW decode failed: ${detail}`);
  }
  return res.json() as Promise<RawDecodeResult>;
}
