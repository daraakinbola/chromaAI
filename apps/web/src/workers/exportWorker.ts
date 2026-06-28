/**
 * exportWorker — off-main-thread ZIP packaging (PRD Section 5.2)
 * Receives already-rendered image blobs from the main thread and packages them
 * into a ZIP archive without blocking the UI.
 */
import { expose } from "comlink";
import JSZip from "jszip";

export interface ZipEntry {
  filename: string;
  arrayBuffer: ArrayBuffer;
}

const exportWorkerApi = {
  async packageZip(entries: ZipEntry[]): Promise<ArrayBuffer> {
    const zip = new JSZip();
    for (const { filename, arrayBuffer } of entries) {
      zip.file(filename, arrayBuffer);
    }
    // STORE avoids double-compression — images are already compressed.
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    return blob.arrayBuffer();
  },
};

expose(exportWorkerApi);
export type ExportWorkerApi = typeof exportWorkerApi;
