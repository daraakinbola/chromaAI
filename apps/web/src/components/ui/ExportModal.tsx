"use client";

import { useState } from "react";
import { X, Download, Loader2, Archive } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import { applyReferencesToAdjustments } from "@/lib/referenceExtract";
import {
  exportImage,
  batchExportImages,
  type ExportFormat,
  type ExportResolution,
  type ExportScope,
} from "@/lib/exportImage";

// ─── Shared UI ────────────────────────────────────────────────────────────────

function OptionGroup({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={clsx(disabled && "opacity-40 pointer-events-none")}>
      <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function RadioPill({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "text-xs px-2.5 py-1 rounded-full border transition-colors",
        selected
          ? "bg-chroma-500/20 border-chroma-500/50 text-chroma-300"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
      )}
    >
      {label}
    </button>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function BatchProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-zinc-400">
          Processing image {done} of {total}…
        </span>
        <span className="text-zinc-600 font-mono">{Math.round(pct)}%</span>
      </div>
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-chroma-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

export function ExportModal({ onClose }: { onClose: () => void }) {
  const { images, activeImageId, references, effectiveAdjustments } = useWorkspace();
  const activeImage = images.find((i) => i.id === activeImageId);

  const [scope, setScope]           = useState<ExportScope>("active");
  const [format, setFormat]         = useState<ExportFormat>("image/jpeg");
  const [quality, setQuality]       = useState(0.9);
  const [resolution, setResolution] = useState<ExportResolution>("full");
  const [exporting, setExporting]   = useState(false);
  const [progress, setProgress]     = useState<{ done: number; total: number } | null>(null);
  const [error, setError]           = useState<string | null>(null);

  const isBatch = scope === "all";
  const ext = format === "image/png" ? "png" : format === "image/webp" ? "webp" : "jpg";
  const singleFilename = activeImage
    ? `${activeImage.filename.replace(/\.[^.]+$/, "")}_chromaai.${ext}`
    : "";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipFilename = `chromaai_export_${timestamp}.zip`;

  const hasReferences = references.some((r) => r.weight > 0);

  const handleExport = async () => {
    setExporting(true);
    setError(null);
    setProgress(null);

    try {
      if (isBatch) {
        // Pre-patch each image's adjustments with effective (base + references)
        // so batchExportImages renders the same look as the canvas preview.
        const patchedImages = references.length > 0
          ? images.map((img) => ({
              ...img,
              adjustments: applyReferencesToAdjustments(img.adjustments, references),
            }))
          : images;
        await batchExportImages(
          patchedImages,
          { format, quality, resolution },
          (done, total) => setProgress({ done, total })
        );
      } else {
        if (!activeImage) return;
        // effectiveAdjustments already reflects base + active reference contributions
        await exportImage(activeImage, { format, quality, resolution }, effectiveAdjustments);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
      setExporting(false);
      setProgress(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70"
        onClick={exporting ? undefined : onClose}
      />

      <div
        className="relative z-10 w-[22rem] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Export</h2>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {isBatch
                ? `${images.length} image${images.length !== 1 ? "s" : ""} · ZIP archive`
                : (activeImage?.filename ?? "No image selected")}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={exporting}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:pointer-events-none"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {images.length === 0 ? (
          <div className="p-6 text-center text-sm text-zinc-500">
            No images in session to export.
          </div>
        ) : (
          <>
            <div className="p-4 flex flex-col gap-4">
              {/* Scope */}
              <OptionGroup label="Scope">
                <RadioPill
                  label="Active image"
                  selected={scope === "active"}
                  onClick={() => setScope("active")}
                />
                <RadioPill
                  label={`All images (${images.length})`}
                  selected={scope === "all"}
                  onClick={() => setScope("all")}
                />
              </OptionGroup>

              {/* Format */}
              <OptionGroup label="Format">
                {(
                  [
                    ["image/jpeg", "JPEG"],
                    ["image/png", "PNG"],
                    ["image/webp", "WebP"],
                  ] as [ExportFormat, string][]
                ).map(([f, label]) => (
                  <RadioPill
                    key={f}
                    label={label}
                    selected={format === f}
                    onClick={() => setFormat(f)}
                  />
                ))}
              </OptionGroup>

              {/* Quality */}
              <OptionGroup label="Quality" disabled={format === "image/png"}>
                {([0.5, 0.75, 0.9, 1.0] as const).map((q) => (
                  <RadioPill
                    key={q}
                    label={`${Math.round(q * 100)}%`}
                    selected={quality === q}
                    onClick={() => setQuality(q)}
                  />
                ))}
              </OptionGroup>

              {/* Resolution */}
              <OptionGroup label="Resolution">
                <RadioPill
                  label={`Full${activeImage ? ` (${activeImage.width}×${activeImage.height})` : ""}`}
                  selected={resolution === "full"}
                  onClick={() => setResolution("full")}
                />
                <RadioPill label="2K" selected={resolution === "2k"} onClick={() => setResolution("2k")} />
                <RadioPill label="1080p" selected={resolution === "1080p"} onClick={() => setResolution("1080p")} />
              </OptionGroup>

              {/* Output filename preview */}
              <div className="bg-zinc-950 rounded px-3 py-2 border border-zinc-800">
                <p className="text-[10px] text-zinc-600 mb-0.5">
                  {isBatch ? "ZIP archive" : "Output filename"}
                </p>
                <p className="text-xs font-mono text-zinc-400 truncate">
                  {isBatch ? zipFilename : singleFilename}
                </p>
                {isBatch && (
                  <p className="text-[10px] text-zinc-600 mt-0.5">
                    Contains {images.length} file{images.length !== 1 ? "s" : ""}
                    {" "}named {`<original>_chromaai.${ext}`}
                  </p>
                )}
              </div>

              {/* Reference active notice */}
              {hasReferences && (
                <p className="text-[10px] text-chroma-400/80 bg-chroma-500/8 border border-chroma-500/20 rounded px-2.5 py-1.5">
                  {references.filter((r) => r.weight > 0).length} reference{references.filter((r) => r.weight > 0).length !== 1 ? "s" : ""} active · effect baked into export
                </p>
              )}

              {/* Batch progress */}
              {exporting && progress && (
                <BatchProgressBar done={progress.done} total={progress.total} />
              )}

              {/* Error */}
              {error && (
                <p className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2 border border-red-500/20">
                  {error}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 px-4 pb-4">
              <button
                onClick={onClose}
                disabled={exporting}
                className="flex-1 text-xs py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors disabled:opacity-40 disabled:pointer-events-none"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={exporting || (scope === "active" && !activeImage)}
                className={clsx(
                  "flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg font-medium transition-colors",
                  exporting
                    ? "bg-chroma-600/50 text-chroma-300 cursor-not-allowed"
                    : "bg-chroma-600 hover:bg-chroma-500 text-white disabled:opacity-40 disabled:pointer-events-none"
                )}
              >
                {exporting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {progress ? `${progress.done} of ${progress.total}` : "Preparing…"}
                  </>
                ) : isBatch ? (
                  <>
                    <Archive className="w-3.5 h-3.5" />
                    Export ZIP
                  </>
                ) : (
                  <>
                    <Download className="w-3.5 h-3.5" />
                    Export
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
