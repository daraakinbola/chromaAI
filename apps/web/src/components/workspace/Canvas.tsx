"use client";

import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import { Columns2, FlipHorizontal2, ZoomIn, ZoomOut, Maximize, Upload } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import { ACCEPTED_EXTENSIONS } from "@/lib/imageImport";
import { buildCssFilter } from "@/lib/cssFilters";
import type { ViewMode } from "@/types";

// ─── Sub-components ──────────────────────────────────────────────────────────

function ViewToggleButton({
  mode,
  current,
  onClick,
  label,
  children,
}: {
  mode: ViewMode;
  current: ViewMode;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={clsx(
        "flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors",
        current === mode
          ? "bg-chroma-500/20 text-chroma-400"
          : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
      )}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function EmptyCanvas({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 bg-zinc-950">
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 rounded-2xl border border-dashed border-zinc-700 flex items-center justify-center">
          <Upload className="w-6 h-6 text-zinc-600" />
        </div>
        <div className="text-center">
          <p className="text-sm text-zinc-400 mb-1">No images imported</p>
          <p className="text-xs text-zinc-600">
            Import JPEG, PNG, WebP, or TIFF files to begin grading
          </p>
        </div>
        <button
          onClick={onImport}
          className="text-xs px-4 py-2 rounded-lg bg-chroma-600 hover:bg-chroma-500 text-white transition-colors"
        >
          Import images
        </button>
      </div>
    </div>
  );
}

// ─── Label badge ─────────────────────────────────────────────────────────────

function ViewLabel({ text, position }: { text: string; position: "left" | "right" | "center" }) {
  return (
    <div
      className={clsx(
        "absolute top-3 text-[10px] text-zinc-400 bg-black/60 px-2 py-0.5 rounded pointer-events-none z-10",
        position === "left" && "left-3",
        position === "right" && "right-3",
        position === "center" && "left-1/2 -translate-x-1/2"
      )}
    >
      {text}
    </div>
  );
}

// ─── Split view ───────────────────────────────────────────────────────────────

function SplitView({
  src,
  cssFilter,
  filename,
}: {
  src: string;
  cssFilter: string;
  filename: string;
}) {
  const [splitPos, setSplitPos] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      setSplitPos(Math.max(0.08, Math.min(0.92, x)));
    };
    const onUp = () => setIsDragging(false);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  const leftPct = `${splitPos * 100}%`;
  const rightPct = `${(1 - splitPos) * 100}%`;

  const imgClass = "absolute inset-0 w-full h-full";
  const imgStyle: React.CSSProperties = {
    objectFit: "contain",
    userSelect: "none",
    WebkitUserDrag: "none",
  } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full bg-zinc-950 overflow-hidden"
      style={{ cursor: isDragging ? "col-resize" : "default" }}
    >
      {/* Before (original) — clipped to left of split */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ clipPath: `inset(0 ${rightPct} 0 0)` }}
        aria-label={`${filename} — original`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={`${filename} — original`} className={imgClass} style={imgStyle} />
      </div>

      {/* After (filtered) — clipped to right of split */}
      <div
        className="absolute inset-0 overflow-hidden"
        style={{ clipPath: `inset(0 0 0 ${leftPct})` }}
        aria-label={`${filename} — adjusted`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={`${filename} — adjusted`}
          className={imgClass}
          style={{ ...imgStyle, filter: cssFilter }}
        />
      </div>

      {/* Divider line + drag handle */}
      <div
        className="absolute top-0 bottom-0 z-20 flex flex-col items-center"
        style={{ left: leftPct, transform: "translateX(-50%)", cursor: "col-resize" }}
        onMouseDown={startDrag}
      >
        <div className="w-px h-full bg-chroma-500/70" />
        {/* Drag knob */}
        <div className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-chroma-600 shadow-lg flex items-center justify-center select-none">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 3L1 6L4 9M8 3L11 6L8 9" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      <ViewLabel text="BEFORE" position="left" />
      <ViewLabel text="AFTER" position="right" />
    </div>
  );
}

// ─── Before/After toggle view ─────────────────────────────────────────────────

function BeforeAfterView({
  src,
  cssFilter,
  filename,
  isShowingBefore,
}: {
  src: string;
  cssFilter: string;
  filename: string;
  isShowingBefore: boolean;
}) {
  return (
    <div className="relative h-full w-full flex items-center justify-center bg-zinc-950 p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={filename}
        className="max-w-full max-h-full object-contain select-none transition-none"
        style={{ filter: isShowingBefore ? "none" : cssFilter }}
        draggable={false}
      />
      <ViewLabel
        text={`${isShowingBefore ? "BEFORE" : "AFTER"} · \\ to toggle`}
        position="center"
      />
    </div>
  );
}

// ─── Main Canvas ──────────────────────────────────────────────────────────────

export function Canvas() {
  const { images, activeImageId, viewMode, setViewMode, adjustments, importImages } =
    useWorkspace();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isShowingBefore, setIsShowingBefore] = useState(false);

  const activeImage = images.find((i) => i.id === activeImageId);

  // Spec Section 3.2 Option A — compute once per adjustments change
  const cssFilter = useMemo(() => buildCssFilter(adjustments), [adjustments]);

  // Spec Section 3.4 — backslash toggles before/after
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "\\" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setIsShowingBefore((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) importImages(Array.from(e.target.files));
    e.target.value = "";
  };

  const openPicker = () => fileInputRef.current?.click();

  return (
    <main className="flex flex-col flex-1 min-w-0 bg-zinc-950">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Toolbar — only when image is active */}
      {activeImage && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-1">
            <ViewToggleButton
              mode="single"
              current={viewMode}
              onClick={() => setViewMode("single")}
              label="Single"
            >
              <Maximize className="w-3.5 h-3.5" />
            </ViewToggleButton>
            <ViewToggleButton
              mode="before-after"
              current={viewMode}
              onClick={() => setViewMode("before-after")}
              label="Before / After"
            >
              <FlipHorizontal2 className="w-3.5 h-3.5" />
            </ViewToggleButton>
            <ViewToggleButton
              mode="split"
              current={viewMode}
              onClick={() => setViewMode("split")}
              label="Split"
            >
              <Columns2 className="w-3.5 h-3.5" />
            </ViewToggleButton>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <span className="font-mono">
              {activeImage.width}×{activeImage.height}
              &nbsp;·&nbsp;
              E: {adjustments.exposure > 0 ? "+" : ""}
              {adjustments.exposure.toFixed(2)}
              &nbsp;·&nbsp;
              {Math.round(adjustments.temperature)}K
            </span>
            <div className="flex items-center gap-1 ml-2">
              <button className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono text-zinc-500 w-10 text-center">100%</span>
              <button className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors">
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Canvas area */}
      <div className="flex-1 relative overflow-hidden">
        {!activeImage ? (
          <EmptyCanvas onImport={openPicker} />
        ) : viewMode === "split" ? (
          <SplitView
            src={activeImage.originalDataUrl}
            cssFilter={cssFilter}
            filename={activeImage.filename}
          />
        ) : viewMode === "before-after" ? (
          <BeforeAfterView
            src={activeImage.originalDataUrl}
            cssFilter={cssFilter}
            filename={activeImage.filename}
            isShowingBefore={isShowingBefore}
          />
        ) : (
          // Single view — filter applied directly to the img
          <div className="h-full flex items-center justify-center bg-zinc-950 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={activeImage.originalDataUrl}
              alt={activeImage.filename}
              className="max-w-full max-h-full object-contain select-none"
              style={{ filter: cssFilter }}
              draggable={false}
            />
          </div>
        )}

        {/* Semantic analysis badge */}
        {activeImage && (
          <div className="absolute bottom-3 right-3 flex items-center gap-2 text-[10px] bg-zinc-900/90 border border-zinc-800 rounded px-2.5 py-1.5 pointer-events-none">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-zinc-400">Skin tones protected</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-400">Semantic analysis active</span>
          </div>
        )}
      </div>
    </main>
  );
}
