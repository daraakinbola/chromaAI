"use client";

import { useEffect, useRef, useState } from "react";
import { Flag, Grid2X2, List, Upload, Loader2 } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import { ACCEPTED_EXTENSIONS } from "@/lib/imageImport";
import type { ImageRecord } from "@/types";

// ── Consistency badge ─────────────────────────────────────────────────────────

function ConsistencyBadge({ score }: { score: number }) {
  const color =
    score >= 85 ? "text-emerald-400" : score >= 70 ? "text-amber-400" : "text-red-400";
  return (
    <span className={clsx("text-[9px] font-mono tabular-nums font-semibold", color)}>
      {score}%
    </span>
  );
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface ContextMenuState {
  imageId: string;
  x: number;
  y: number;
}

function ThumbnailContextMenu({
  menu,
  image,
  onApplyGrade,
  onUnflag,
  onClose,
}: {
  menu: ContextMenuState;
  image: ImageRecord | undefined;
  onApplyGrade: () => void;
  onUnflag: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Clamp so menu doesn't overflow viewport
  const x = Math.min(menu.x, window.innerWidth - 200);
  const y = Math.min(menu.y, window.innerHeight - 100);

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[190px]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={onApplyGrade}
        className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
      >
        Apply this grade to all
      </button>
      {image?.flagged && (
        <>
          <div className="h-px bg-zinc-800 mx-2 my-1" />
          <button
            onClick={onUnflag}
            className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Unflag
          </button>
        </>
      )}
    </div>
  );
}

// ── Thumbnail ─────────────────────────────────────────────────────────────────

function Thumbnail({
  image,
  selected,
  onClick,
  onContextMenu,
}: {
  image: ImageRecord;
  selected: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={clsx(
        "relative w-full aspect-[3/2] rounded overflow-hidden border transition-all",
        selected
          ? "border-chroma-500 ring-1 ring-chroma-500/50"
          : "border-zinc-800 hover:border-zinc-600"
      )}
    >
      {image.thumbnailDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.thumbnailDataUrl}
          alt={image.filename}
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 bg-zinc-900 flex items-center justify-center">
          <span className="text-[10px] text-zinc-600 font-mono">
            {image.mimeType.split("/")[1]?.toUpperCase()}
          </span>
        </div>
      )}
      {image.isRaw && (
        <span className="absolute top-1 left-1 text-[8px] font-mono font-bold bg-amber-500/80 text-white px-1 py-0.5 rounded leading-none z-10">
          RAW
        </span>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-0.5 flex items-center justify-between">
        <ConsistencyBadge score={image.consistencyScore} />
        {image.flagged && <Flag className="w-2.5 h-2.5 text-amber-400" />}
      </div>
      {selected && <div className="absolute inset-0 ring-inset ring-1 ring-chroma-500/40" />}
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 gap-3">
      <div className="w-10 h-10 rounded-full border border-dashed border-zinc-700 flex items-center justify-center">
        <Upload className="w-4 h-4 text-zinc-600" />
      </div>
      <p className="text-[11px] text-zinc-600 text-center leading-relaxed">
        No images yet.<br />Import to get started.
      </p>
      <button
        onClick={onImport}
        className="text-xs text-chroma-400 hover:text-chroma-300 transition-colors"
      >
        + Import images
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ImageBrowser() {
  const {
    images,
    activeImageId,
    selectImage,
    importImages,
    isImporting,
    importProgress,
    batchConsistencyScore,
    applyGradeToAll,
    unflagImage,
    isApplyingGrade,
  } = useWorkspace();

  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) importImages(Array.from(files));
    e.target.value = "";
  };

  const openPicker = () => fileInputRef.current?.click();

  const handleContextMenu = (e: React.MouseEvent, imageId: string) => {
    e.preventDefault();
    setContextMenu({ imageId, x: e.clientX, y: e.clientY });
  };

  const flaggedCount = images.filter((i) => i.flagged).length;

  return (
    <aside className="flex flex-col h-full w-60 shrink-0 border-r border-zinc-800 bg-zinc-950">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Context menu portal */}
      {contextMenu && (
        <ThumbnailContextMenu
          menu={contextMenu}
          image={images.find((i) => i.id === contextMenu.imageId)}
          onApplyGrade={() => {
            applyGradeToAll(contextMenu.imageId);
            setContextMenu(null);
          }}
          onUnflag={() => {
            unflagImage(contextMenu.imageId);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800 shrink-0">
        <div>
          <p className="text-xs font-medium text-zinc-200">
            {images.length} {images.length === 1 ? "image" : "images"}
          </p>
          {flaggedCount > 0 && (
            <p className="text-[10px] text-amber-400">{flaggedCount} flagged</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setLayout("grid")}
            className={clsx(
              "p-1 rounded transition-colors",
              layout === "grid"
                ? "text-chroma-400 bg-chroma-500/10"
                : "text-zinc-600 hover:text-zinc-400"
            )}
          >
            <Grid2X2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setLayout("list")}
            className={clsx(
              "p-1 rounded transition-colors",
              layout === "list"
                ? "text-chroma-400 bg-chroma-500/10"
                : "text-zinc-600 hover:text-zinc-400"
            )}
          >
            <List className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Batch consistency bar — real score from Section 6.2 */}
      {images.length > 0 && (
        <div className="px-3 py-2 border-b border-zinc-800/60">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
              Batch Consistency
            </span>
            {isApplyingGrade ? (
              <Loader2 className="w-3 h-3 text-chroma-400 animate-spin" />
            ) : (
              <span
                className={clsx(
                  "text-[10px] font-mono",
                  batchConsistencyScore >= 85
                    ? "text-emerald-400"
                    : batchConsistencyScore >= 70
                    ? "text-amber-400"
                    : "text-red-400"
                )}
              >
                {batchConsistencyScore}%
              </span>
            )}
          </div>
          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={clsx(
                "h-full rounded-full transition-all duration-300",
                batchConsistencyScore >= 85
                  ? "bg-emerald-500/70"
                  : batchConsistencyScore >= 70
                  ? "bg-amber-500/70"
                  : "bg-red-500/70"
              )}
              style={{ width: `${batchConsistencyScore}%` }}
            />
          </div>
          {isApplyingGrade && (
            <p className="text-[10px] text-zinc-500 mt-1">Applying grade…</p>
          )}
        </div>
      )}

      {/* Import progress */}
      {isImporting && importProgress && (
        <div className="px-3 py-2 border-b border-zinc-800/60">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-chroma-400 animate-spin shrink-0" />
            <span className="text-[10px] text-zinc-400">
              Importing {importProgress.current + 1} of {importProgress.total}…
            </span>
          </div>
          <div className="mt-1.5 h-0.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-chroma-500 rounded-full transition-all duration-200"
              style={{
                width: `${((importProgress.current + 1) / importProgress.total) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Image grid / list / empty state */}
      <div className="flex-1 overflow-y-auto">
        {images.length === 0 && !isImporting ? (
          <EmptyState onImport={openPicker} />
        ) : layout === "grid" ? (
          <div className="p-2 grid grid-cols-2 gap-1.5">
            {images.map((img) => (
              <Thumbnail
                key={img.id}
                image={img}
                selected={img.id === activeImageId}
                onClick={() => selectImage(img.id)}
                onContextMenu={(e) => handleContextMenu(e, img.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 p-2">
            {images.map((img) => (
              <button
                key={img.id}
                onClick={() => selectImage(img.id)}
                onContextMenu={(e) => handleContextMenu(e, img.id)}
                className={clsx(
                  "flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors",
                  img.id === activeImageId
                    ? "bg-chroma-500/15 text-zinc-200"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                )}
              >
                {img.thumbnailDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={img.thumbnailDataUrl}
                    alt={img.filename}
                    className="w-7 h-5 rounded object-cover shrink-0"
                    draggable={false}
                  />
                ) : (
                  <div className="w-7 h-5 rounded bg-zinc-800 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] truncate">{img.filename}</p>
                  <p className="text-[9px] text-zinc-600">
                    {img.width}×{img.height}
                    {img.isRaw && <span className="ml-1 text-amber-400">RAW</span>}
                  </p>
                </div>
                <ConsistencyBadge score={img.consistencyScore} />
                {img.flagged && (
                  <Flag className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Import button */}
      <div className="px-3 py-2 border-t border-zinc-800 shrink-0">
        <button
          onClick={openPicker}
          disabled={isImporting}
          className={clsx(
            "w-full text-xs py-1.5 border border-dashed rounded transition-colors",
            isImporting
              ? "text-zinc-700 border-zinc-800 cursor-not-allowed"
              : "text-zinc-500 hover:text-zinc-300 border-zinc-700 hover:border-zinc-600"
          )}
        >
          {isImporting ? "Importing…" : "+ Import images"}
        </button>
      </div>
    </aside>
  );
}
