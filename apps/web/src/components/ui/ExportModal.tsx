"use client";

import { useState } from "react";
import { X, Download, Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import {
  exportImage,
  type ExportFormat,
  type ExportResolution,
} from "@/lib/exportImage";

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

export function ExportModal({ onClose }: { onClose: () => void }) {
  const { images, activeImageId } = useWorkspace();
  const activeImage = images.find((i) => i.id === activeImageId);

  const [format, setFormat] = useState<ExportFormat>("image/jpeg");
  const [quality, setQuality] = useState(0.9);
  const [resolution, setResolution] = useState<ExportResolution>("full");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outputExt =
    format === "image/png" ? "png" : format === "image/webp" ? "webp" : "jpg";
  const outputFilename = activeImage
    ? `${activeImage.filename.replace(/\.[^.]+$/, "")}_chromaai.${outputExt}`
    : "";

  const handleExport = async () => {
    if (!activeImage) return;
    setExporting(true);
    setError(null);
    try {
      await exportImage(activeImage, { format, quality, resolution });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
      setExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />

      <div
        className="relative z-10 w-[22rem] bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Export Image</h2>
            {activeImage && (
              <p className="text-[11px] text-zinc-500 mt-0.5 truncate max-w-[220px]">
                {activeImage.filename}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!activeImage ? (
          <div className="p-6 text-center text-sm text-zinc-500">
            No image selected to export.
          </div>
        ) : (
          <>
            <div className="p-4 flex flex-col gap-4">
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
                  label={`Full (${activeImage.width}×${activeImage.height})`}
                  selected={resolution === "full"}
                  onClick={() => setResolution("full")}
                />
                <RadioPill
                  label="2K"
                  selected={resolution === "2k"}
                  onClick={() => setResolution("2k")}
                />
                <RadioPill
                  label="1080p"
                  selected={resolution === "1080p"}
                  onClick={() => setResolution("1080p")}
                />
              </OptionGroup>

              {/* Filename preview */}
              <div className="bg-zinc-950 rounded px-3 py-2 border border-zinc-800">
                <p className="text-[10px] text-zinc-600 mb-0.5">Output filename</p>
                <p className="text-xs font-mono text-zinc-400 truncate">{outputFilename}</p>
              </div>

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
                className="flex-1 text-xs py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExport}
                disabled={exporting}
                className={clsx(
                  "flex-1 flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg font-medium transition-colors",
                  exporting
                    ? "bg-chroma-600/50 text-chroma-300 cursor-not-allowed"
                    : "bg-chroma-600 hover:bg-chroma-500 text-white"
                )}
              >
                {exporting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Exporting…
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
