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
import { buildCurveLUT, parametricToPoints } from "@/lib/curveMath";
import type { AdjustmentState, ColorWheelState, CurveChannel, CurveState, HslAdjustments, ToneCurve, ViewMode } from "@/types";
import { defaultColorWheelState, defaultCurveState } from "@/types";

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
          <p className="text-xs text-zinc-600">Import JPEG, PNG, WebP, TIFF, or RAW files to begin grading</p>
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
  adjustments: AdjustmentState,
  hsl: HslAdjustments,
  colorWheels: ColorWheelState,
  curveState: CurveState,
  highlightRecovery: number,
  shadowRecovery: number,
): { isReady: boolean } {
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const adjRef = useRef(adjustments);
  adjRef.current = adjustments;
  const hslRef = useRef(hsl);
  hslRef.current = hsl;
  const wheelsRef = useRef(colorWheels);
  wheelsRef.current = colorWheels;
  const curvesRef = useRef(curveState);
  curvesRef.current = curveState;
  const hrRef = useRef(highlightRecovery);
  hrRef.current = highlightRecovery;
  const srRef = useRef(shadowRecovery);
  srRef.current = shadowRecovery;

  // Destroy renderer on unmount only
  useEffect(() => {
    return () => {
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Keep canvas backing-store in sync with its CSS display size (spec Section 3.3)
  // CSS transforms don't affect offsetWidth/Height, so this stays at container resolution.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      const { offsetWidth: w, offsetHeight: h } = canvas;
      if (w && h && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        if (isReady) rendererRef.current?.render(adjRef.current, hslRef.current, wheelsRef.current, curvesRef.current, hrRef.current, srRef.current);
      }
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  // Load image texture.
  // The renderer is lazy-initialised here rather than at mount because the
  // <canvas> element lives inside the activeImage conditional branch — its ref
  // is null at mount time (no image yet).  By the time imageSrc becomes
  // non-null the canvas is already in the DOM, so canvasRef.current is valid.
  useEffect(() => {
    if (!imageSrc) { setIsReady(false); return; }

    if (!rendererRef.current) {
      const canvas = canvasRef.current;
      if (!canvas || !webglSupported()) { setIsReady(false); return; }
      try {
        rendererRef.current = new WebGLRenderer(canvas);
      } catch (e) {
        console.warn("WebGL renderer failed to init:", e);
        setIsReady(false);
        return;
      }
    }

    setIsReady(false);
    rendererRef.current.loadImage(imageSrc)
      .then(() => setIsReady(true))
      .catch(console.error);
  }, [imageSrc]);

  // Re-render when adjustments, HSL, wheels, curves, or RAW recovery change
  useEffect(() => {
    if (!isReady) return;
    rendererRef.current?.render(adjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery, isReady]);

  return { isReady };
}

// ─── Canvas component ─────────────────────────────────────────────────────────

export function Canvas() {
  const {
    images, activeImageId, viewMode, setViewMode,
    adjustments, effectiveAdjustments, hsl, colorWheels, curveState, importImages,
    tatActive, setTatActive, setTatLuminance, setCurve,
    highlightRecovery, shadowRecovery,
  } = useWorkspace();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const glCanvasRef  = useRef<HTMLCanvasElement>(null);

  // TAT drag tracking
  const tatDragRef = useRef<{
    startY: number;
    inputLum: number;
    initialOutput: number;
  } | null>(null);

  const [isShowingBefore, setIsShowingBefore] = useState(false);
  const [splitPos, setSplitPos]               = useState(0.5);
  const [isDragging, setIsDragging]           = useState(false);
  const [containerSize, setContainerSize]     = useState({ w: 0, h: 0 });

  // ── Zoom / pan state ───────────────────────────────────────────────────────
  const [zoom, setZoom]       = useState(1.0);
  const [pan, setPan]         = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);

  // Refs for use inside event handlers without stale closures
  const zoomRef      = useRef(zoom);
  zoomRef.current    = zoom;
  const panRef       = useRef(pan);
  panRef.current     = pan;
  const panOriginRef = useRef({ startX: 0, startY: 0, panX: 0, panY: 0 });

  const activeImage = images.find((i) => i.id === activeImageId) ?? null;

  // WebGL renderer — renders effectiveAdjustments + HSL + color wheels + tone curve + RAW recovery
  const { isReady } = useWebGLCanvas(
    glCanvasRef,
    activeImage?.originalDataUrl ?? null,
    effectiveAdjustments,
    hsl,
    colorWheels,
    curveState,
    highlightRecovery,
    shadowRecovery,
  );

  // ── TAT helpers ────────────────────────────────────────────────────────────

  const readLuminance = useCallback((clientX: number, clientY: number): number | null => {
    const canvas = glCanvasRef.current;
    if (!canvas || !isReady) return null;
    const gl = canvas.getContext("webgl");
    if (!gl) return null;
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((clientX - rect.left) * canvas.width / rect.width);
    const py = Math.floor((clientY - rect.top) * canvas.height / rect.height);
    if (px < 0 || px >= canvas.width || py < 0 || py >= canvas.height) return null;
    const pixel = new Uint8Array(4);
    gl.readPixels(px, canvas.height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return Math.round(0.299 * pixel[0] + 0.587 * pixel[1] + 0.114 * pixel[2]);
  }, [isReady]);

  const handleTatPointerMove = useCallback((e: React.PointerEvent) => {
    if (!tatActive) return;
    const lum = readLuminance(e.clientX, e.clientY);
    setTatLuminance(lum);
    if (!tatDragRef.current) return;
    const { startY, inputLum, initialOutput } = tatDragRef.current;
    const dy = startY - e.clientY; // positive = dragged up = brighter output
    const newOutput = Math.max(0, Math.min(255, Math.round(initialOutput + dy)));
    const ch = curveState.activeChannel;
    const curve = curveState[ch];
    if (curve.mode !== "point") return;
    const newPts = [...curve.points];
    const idx = newPts.findIndex(([x]) => x === inputLum);
    if (idx >= 0) newPts[idx] = [inputLum, newOutput];
    setCurve(ch, { ...curve, points: newPts });
  }, [tatActive, readLuminance, setTatLuminance, curveState, setCurve]);

  const handleTatPointerDown = useCallback((e: React.PointerEvent) => {
    if (!tatActive || e.button !== 0) return;
    const lum = readLuminance(e.clientX, e.clientY);
    if (lum === null) return;
    const ch = curveState.activeChannel;
    const curve = curveState[ch];
    if (curve.mode !== "point") return;
    const pts = curve.mode === "point"
      ? curve.points
      : parametricToPoints(curve.parametric);
    const lut = buildCurveLUT(pts);
    const currentOutput = Math.round(lut[lum] * 255);
    tatDragRef.current = { startY: e.clientY, inputLum: lum, initialOutput: currentOutput };
    // Add a control point at this luminance if one doesn't already exist (max 16 pts)
    if (!curve.points.some(([x]) => x === lum) && curve.points.length < 16) {
      const newPts = [...curve.points, [lum, currentOutput] as [number, number]]
        .sort((a, b) => a[0] - b[0]);
      setCurve(ch, { ...curve, points: newPts });
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [tatActive, readLuminance, curveState, setCurve]);

  const handleTatPointerUp = useCallback(() => {
    tatDragRef.current = null;
  }, []);

  // Escape key deactivates TAT
  useEffect(() => {
    if (!tatActive) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setTatActive(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tatActive, setTatActive]);

  // Track container dimensions for containFit calculation and split clip math
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

  // ── Zoom helpers ───────────────────────────────────────────────────────────

  const zoomIn   = useCallback(() => setZoom(z => Math.min(20, z * 1.25)), []);
  const zoomOut  = useCallback(() => setZoom(z => Math.max(0.1, z / 1.25)), []);
  const resetZoom = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire when user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "\\") setIsShowingBefore(s => !s);
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomIn(); }
      if (e.key === "-") { e.preventDefault(); zoomOut(); }
      if (e.key === "0") { e.preventDefault(); resetZoom(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zoomIn, zoomOut, resetZoom]);

  // ── Scroll-wheel zoom toward cursor ───────────────────────────────────────
  // Must be non-passive to call preventDefault and suppress browser page scroll.

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // Cursor position relative to container center
      const mx = e.clientX - rect.left - rect.width  / 2;
      const my = e.clientY - rect.top  - rect.height / 2;
      const factor  = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.max(0.1, Math.min(20, zoomRef.current * factor));
      const k = newZoom / zoomRef.current;
      // Update ref immediately so rapid successive events compound correctly
      zoomRef.current = newZoom;
      // Zoom toward cursor: keep the world point under the cursor stationary
      setPan(p => ({ x: mx - (mx - p.x) * k, y: my - (my - p.y) * k }));
      setZoom(newZoom);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // ── Drag to pan ────────────────────────────────────────────────────────────

  const startPan = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (tatActive) return; // TAT takes over pointer events
    e.preventDefault();
    panOriginRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
    setIsPanning(true);
  }, []);

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e: MouseEvent) => {
      const { startX, startY, panX, panY } = panOriginRef.current;
      setPan({ x: panX + (e.clientX - startX), y: panY + (e.clientY - startY) });
    };
    const onUp = () => setIsPanning(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isPanning]);

  // ── Split divider drag ─────────────────────────────────────────────────────

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Prevent triggering startPan on the transform wrapper
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
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) importImages(Array.from(e.target.files));
    e.target.value = "";
  };

  // ── Derived geometry ───────────────────────────────────────────────────────

  const fit = activeImage
    ? containFit(containerSize.w, containerSize.h, activeImage.width, activeImage.height)
    : null;

  /**
   * Split-view clip positions in element-local space (pre-transform).
   *
   * The transform wrapper is `translate(panX, panY) scale(zoom)` from center.
   * The screen-space divider at `splitPos * containerW` maps to wrapper-local X:
   *   X_local = containerW/2 + (splitPos*containerW - containerW/2 - panX) / zoom
   *
   * We then express that as clip-path percentages for each element.
   */
  const splitXLocal = containerSize.w > 0
    ? containerSize.w / 2 + (splitPos * containerSize.w - containerSize.w / 2 - pan.x) / zoom
    : splitPos * containerSize.w;

  // GL canvas (fills wrapper = container dims): clip from left at this %
  const canvasSplitPct = containerSize.w > 0
    ? Math.max(0, Math.min(100, (splitXLocal / containerSize.w) * 100))
    : splitPos * 100;

  // Before-img (positioned at fit.left, fit.width): clip from right so right side is hidden
  const imgSplitFromRight = (fit && containerSize.w > 0)
    ? Math.max(0, Math.min(100, 100 - ((splitXLocal - fit.left) / fit.width) * 100))
    : 100 - splitPos * 100;

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
              &nbsp;·&nbsp;E:&nbsp;{effectiveAdjustments.exposure > 0 ? "+" : ""}
              {effectiveAdjustments.exposure.toFixed(2)}
              &nbsp;·&nbsp;{Math.round(effectiveAdjustments.temperature)}K
            </span>
            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={zoomOut}
                title="Zoom out (−)"
                className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={resetZoom}
                title="Reset zoom (0)"
                className="font-mono text-zinc-500 hover:text-zinc-300 w-12 text-center text-xs transition-colors rounded px-1 py-0.5 hover:bg-zinc-800"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={zoomIn}
                title="Zoom in (+)"
                className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
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
             * Transform wrapper — applies zoom/pan via CSS transform.
             * All image content lives inside so they move together.
             * The split divider is a sibling (outside) so it stays in screen space.
             *
             * CSS transforms do not affect offsetWidth/Height, so the WebGL
             * canvas backing-store remains at container resolution regardless
             * of zoom level (visual scaling is handled by the browser).
             */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "50% 50%",
                cursor: tatActive ? "crosshair" : isPanning ? "grabbing" : "grab",
              }}
              onMouseDown={startPan}
              onPointerDown={handleTatPointerDown}
              onPointerMove={handleTatPointerMove}
              onPointerUp={handleTatPointerUp}
            >
              {/*
               * WebGL canvas — always mounted so the GL context survives view-mode
               * switches. Fills the transform wrapper; shader handles contain-fit
               * letterboxing internally.
               *
               * Visibility / clip rules:
               *   single        → visible, no clip
               *   before-after (after) → visible, no clip
               *   before-after (before) → hidden (original <img> shown instead)
               *   split         → visible, clipped to right of canvasSplitPct
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
                      ? `inset(0 0 0 ${canvasSplitPct}%)`
                      : undefined,
                }}
              />

              {/*
               * Original "before" image — shown when:
               *   before-after AND isShowingBefore → full view, no clip
               *   split                            → left half, clipped at imgSplitFromRight
               *
               * Positioned using containFit to overlay the exact letterbox rect
               * that the WebGL shader is rendering into.
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
                        ? `inset(0 ${imgSplitFromRight}% 0 0)`
                        : undefined,
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>

            {/* Split divider — outside the transform wrapper so it stays at screen-space splitPos */}
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

            {/* Semantic analysis badge — driven by real sceneAnalysis data */}
            {activeImage.sceneAnalysis ? (
              <div className="absolute bottom-3 right-3 flex items-center gap-2 text-[10px] bg-zinc-900/90 border border-zinc-800 rounded px-2.5 py-1.5 pointer-events-none z-10">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-zinc-400">
                  {activeImage.sceneAnalysis.subject}
                </span>
                {activeImage.sceneAnalysis.has_skin_tones && (
                  <>
                    <span className="text-zinc-600">·</span>
                    <span className="text-zinc-400">Skin tones protected</span>
                  </>
                )}
                <span className="text-zinc-600">·</span>
                <span className="text-zinc-600">
                  {Math.round(activeImage.sceneAnalysis.confidence * 100)}% confidence
                </span>
              </div>
            ) : activeImage.sceneAnalysis === null ? (
              <div className="absolute bottom-3 right-3 flex items-center gap-2 text-[10px] bg-zinc-900/90 border border-zinc-800 rounded px-2.5 py-1.5 pointer-events-none z-10">
                <div className="w-1.5 h-1.5 rounded-full bg-zinc-600 animate-pulse" />
                <span className="text-zinc-600">Analyzing scene…</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
