"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Columns2, FlipHorizontal2, Maximize, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import { ACCEPTED_EXTENSIONS } from "@/lib/imageImport";
import { WebGLRenderer, webglSupported } from "@/lib/webglRenderer";
import type { AdjustmentState, ViewMode } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compute "object-fit: contain" dimensions and offsets within a container. */
function containFit(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number
): { left: number; top: number; width: number; height: number } {
  if (!containerW || !containerH || !imageW || !imageH) {
    return { left: 0, top: 0, width: containerW, height: containerH };
  }
  const cA = containerW / containerH;
  const iA = imageW / imageH;
  let w: number, h: number;
  if (iA > cA) { w = containerW; h = w / iA; }
  else          { h = containerH; w = h * iA; }
  return { left: (containerW - w) / 2, top: (containerH - h) / 2, width: w, height: h };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ViewToggleButton({
  mode, current, onClick, label, children,
}: {
  mode: ViewMode; current: ViewMode; onClick: () => void;
  label: string; children: React.ReactNode;
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
          <p className="text-xs text-zinc-600">Import JPEG, PNG, WebP, or TIFF files to begin grading</p>
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

// ─── WebGL canvas hook ────────────────────────────────────────────────────────

/**
 * Manages a WebGLRenderer instance tied to `canvasRef`.
 *
 * - Initialises once on mount; destroys on unmount.
 * - Reloads the texture whenever `imageSrc` changes.
 * - Schedules RAF-batched renders whenever `adjustments` change (spec: ≤ 8 ms debounce).
 * - Resizes the canvas backing-store via ResizeObserver so gl.viewport stays accurate.
 */
function useWebGLCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  imageSrc: string | null,
  adjustments: AdjustmentState
): { isReady: boolean } {
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const adjRef = useRef(adjustments);
  adjRef.current = adjustments;

  // Init renderer once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !webglSupported()) return;
    try {
      rendererRef.current = new WebGLRenderer(canvas);
    } catch (e) {
      console.warn("WebGL renderer failed to init:", e);
    }
    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
      setIsReady(false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep canvas backing-store in sync with its CSS display size (spec Section 3.3)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      const { offsetWidth: w, offsetHeight: h } = canvas;
      if (w && h && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        if (isReady) rendererRef.current?.render(adjRef.current);
      }
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // Load image texture
  useEffect(() => {
    if (!rendererRef.current || !imageSrc) { setIsReady(false); return; }
    setIsReady(false);
    rendererRef.current.loadImage(imageSrc)
      .then(() => setIsReady(true))
      .catch(console.error);
  }, [imageSrc]);

  // Re-render on adjustment change (RAF-batched inside renderer)
  useEffect(() => {
    if (!isReady) return;
    rendererRef.current?.render(adjustments);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustments, isReady]);

  return { isReady };
}

// ─── Canvas component ─────────────────────────────────────────────────────────

export function Canvas() {
  const { images, activeImageId, viewMode, setViewMode, adjustments, importImages } =
    useWorkspace();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const glCanvasRef  = useRef<HTMLCanvasElement>(null);

  const [isShowingBefore, setIsShowingBefore] = useState(false);
  const [splitPos, setSplitPos]               = useState(0.5);
  const [isDragging, setIsDragging]           = useState(false);
  const [containerSize, setContainerSize]     = useState({ w: 0, h: 0 });

  const activeImage = images.find((i) => i.id === activeImageId) ?? null;

  // WebGL renderer
  const { isReady } = useWebGLCanvas(
    glCanvasRef,
    activeImage?.originalDataUrl ?? null,
    adjustments
  );

  // Track container dimensions for containFit calculation
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => {
      setContainerSize({ w: el.offsetWidth, h: el.offsetHeight });
    });
    obs.observe(el);
    setContainerSize({ w: el.offsetWidth, h: el.offsetHeight });
    return () => obs.disconnect();
  }, []);

  // Backslash — before/after toggle (spec Section 3.4)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "\\" && !e.ctrlKey && !e.metaKey && !e.altKey)
        setIsShowingBefore((s) => !s);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Split divider drag
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setSplitPos(Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)));
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [isDragging]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) importImages(Array.from(e.target.files));
    e.target.value = "";
  };

  // ── Derived geometry ───────────────────────────────────────────────────────

  /**
   * The WebGL canvas fills the container 100 % × 100 % and handles its own
   * contain-fit letterboxing in the shader.  We use the same containFit()
   * math to position the "before" <img> at the identical position so that
   * split-view clip paths line up perfectly.
   */
  const fit = activeImage
    ? containFit(containerSize.w, containerSize.h, activeImage.width, activeImage.height)
    : null;

  /**
   * For split-view, the clip origin is the container (not fit).
   * Convert container-space splitPos → fit-space percentage for clip-path.
   */
  const splitPctInFit = fit
    ? Math.max(0, Math.min(100, ((splitPos * containerSize.w - fit.left) / fit.width) * 100))
    : splitPos * 100;

  return (
    <main className="flex flex-col flex-1 min-w-0 bg-zinc-950">
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_EXTENSIONS}
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Toolbar */}
      {activeImage && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-1">
            <ViewToggleButton mode="single" current={viewMode} onClick={() => setViewMode("single")} label="Single">
              <Maximize className="w-3.5 h-3.5" />
            </ViewToggleButton>
            <ViewToggleButton mode="before-after" current={viewMode} onClick={() => setViewMode("before-after")} label="Before / After">
              <FlipHorizontal2 className="w-3.5 h-3.5" />
            </ViewToggleButton>
            <ViewToggleButton mode="split" current={viewMode} onClick={() => setViewMode("split")} label="Split">
              <Columns2 className="w-3.5 h-3.5" />
            </ViewToggleButton>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-600">
            <span className="font-mono">
              {activeImage.width}×{activeImage.height}
              &nbsp;·&nbsp;E:&nbsp;{adjustments.exposure > 0 ? "+" : ""}
              {adjustments.exposure.toFixed(2)}
              &nbsp;·&nbsp;{Math.round(adjustments.temperature)}K
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
      <div ref={containerRef} className="flex-1 relative overflow-hidden bg-zinc-950">
        {!activeImage ? (
          <EmptyCanvas onImport={() => fileInputRef.current?.click()} />
        ) : (
          <>
            {/*
             * WebGL canvas — always mounted so the GL context survives view-mode
             * switches. Fills the container; the shader handles contain-fit
             * letterboxing internally.
             *
             * Visibility rules:
             *   single     → visible, no clip
             *   before-after, after → visible, no clip
             *   before-after, before → hidden (original <img> shown instead)
             *   split      → visible, clipped to right half
             */}
            <canvas
              ref={glCanvasRef}
              className={clsx(
                "absolute inset-0 w-full h-full",
                !isReady && "opacity-0"
              )}
              style={{
                visibility:
                  viewMode === "before-after" && isShowingBefore ? "hidden" : "visible",
                clipPath:
                  viewMode === "split"
                    ? `inset(0 0 0 ${splitPctInFit}%)`
                    : undefined,
              }}
            />

            {/*
             * Original "before" image — shown when:
             *   before-after AND isShowingBefore  → full view, no clip
             *   split                              → left half, clipped
             */}
            {(viewMode === "before-after" || viewMode === "split") && fit && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={activeImage.originalDataUrl}
                alt={activeImage.filename}
                draggable={false}
                style={{
                  position: "absolute",
                  left:   fit.left,
                  top:    fit.top,
                  width:  fit.width,
                  height: fit.height,
                  visibility:
                    viewMode === "before-after" && !isShowingBefore ? "hidden" : "visible",
                  clipPath:
                    viewMode === "split"
                      ? `inset(0 ${100 - splitPctInFit}% 0 0)`
                      : undefined,
                  userSelect: "none",
                  pointerEvents: "none",
                }}
              />
            )}

            {/* Split divider */}
            {viewMode === "split" && (
              <div
                className="absolute top-0 bottom-0 z-20 flex flex-col items-center"
                style={{ left: `${splitPos * 100}%`, transform: "translateX(-50%)", cursor: "col-resize" }}
                onMouseDown={startDrag}
              >
                <div className="w-px h-full bg-chroma-500/70" />
                <div className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-chroma-600 shadow-lg flex items-center justify-center select-none">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M4 3L1 6L4 9M8 3L11 6L8 9" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            )}

            {/* View mode labels */}
            {viewMode === "split" && (
              <>
                <ViewLabel text="BEFORE" position="left" />
                <ViewLabel text="AFTER"  position="right" />
              </>
            )}
            {viewMode === "before-after" && (
              <ViewLabel
                text={`${isShowingBefore ? "BEFORE" : "AFTER"} · \\ to toggle`}
                position="center"
              />
            )}

            {/* Semantic analysis badge */}
            <div className="absolute bottom-3 right-3 flex items-center gap-2 text-[10px] bg-zinc-900/90 border border-zinc-800 rounded px-2.5 py-1.5 pointer-events-none z-10">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-zinc-400">Skin tones protected</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">Semantic analysis active</span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
