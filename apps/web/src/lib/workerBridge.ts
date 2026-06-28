/**
 * workerBridge — lazy singleton Web Worker instances (PRD Section 5.2)
 * Each worker is created once on first use and reused for all subsequent calls.
 * All functions return null on the server (no Worker global).
 */
import { wrap, type Remote } from "comlink";
import type { MaskWorkerApi }   from "@/workers/maskWorker";
import type { ImageWorkerApi }  from "@/workers/imageWorker";
import type { ExportWorkerApi } from "@/workers/exportWorker";

// ─── Mask worker ──────────────────────────────────────────────────────────────

let _maskWorker: Remote<MaskWorkerApi> | null = null;

export function getMaskWorker(): Remote<MaskWorkerApi> | null {
  if (typeof Worker === "undefined") return null;
  if (!_maskWorker) {
    const w = new Worker(new URL("../workers/maskWorker", import.meta.url));
    _maskWorker = wrap<MaskWorkerApi>(w);
  }
  return _maskWorker;
}

// ─── Image worker ─────────────────────────────────────────────────────────────

let _imageWorker: Remote<ImageWorkerApi> | null = null;

export function getImageWorker(): Remote<ImageWorkerApi> | null {
  if (typeof Worker === "undefined") return null;
  if (!_imageWorker) {
    const w = new Worker(new URL("../workers/imageWorker", import.meta.url));
    _imageWorker = wrap<ImageWorkerApi>(w);
  }
  return _imageWorker;
}

// ─── Export worker ────────────────────────────────────────────────────────────

let _exportWorker: Remote<ExportWorkerApi> | null = null;

export function getExportWorker(): Remote<ExportWorkerApi> | null {
  if (typeof Worker === "undefined") return null;
  if (!_exportWorker) {
    const w = new Worker(new URL("../workers/exportWorker", import.meta.url));
    _exportWorker = wrap<ExportWorkerApi>(w);
  }
  return _exportWorker;
}
