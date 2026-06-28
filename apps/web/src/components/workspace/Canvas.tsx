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
import type { RendererLocalLayer } from "@/lib/webglRenderer";
import { buildCurveLUT, parametricToPoints } from "@/lib/curveMath";
import { pngToMask, paintBrush, maskToPng, getMaskResolution } from "@/lib/maskUtils";
import type { AdjustmentState, ColorWheelState, CurveChannel, CurveState, HslAdjustments, LocalAdjustmentLayer, ToneCurve, ViewMode } from "@/types";
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

// ─── Render cache helpers (PRD Section 5.4) ──────────────────────────────────

/** Maximum number of rendered frames cached per active image. */
const RENDER_CACHE_MAX = 10;

/** Stable fingerprint for a complete render state used as the LRU cache key. */
function buildFingerprint(
  adj: AdjustmentState,
  hsl: HslAdjustments,
  wheels: ColorWheelState,
  curves: CurveState,
  hr: number,
  sr: number,
  ll: RendererLocalLayer[],
  maskLens: (number | null)[],
): string {
  return JSON.stringify({ adj, hsl, wheels, curves, hr, sr, ll, masks: maskLens });
}

// ─── WebGL canvas hook ────────────────────────────────────────────────────────

/**
 * Manages a WebGLRenderer instance tied to `canvasRef`.
 *
 * - Initialises once on mount; destroys on unmount.
 * - Reloads the texture whenever `imageSrc` changes.
 * - Schedules RAF-batched renders whenever `adjustments` change (spec: ≤ 8 ms debounce).
 * - Resizes the canvas backing-store via ResizeObserver so gl.viewport stays accurate.
 * - For images > 4 MP: renders at 25% resolution immediately on slider change, then
 *   at full resolution after 200 ms of inactivity (PRD Section 5.3 progressive rendering).
 */
function useWebGLCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  imageSrc: string | null,
  imageMpx: number,
  adjustments: AdjustmentState,
  hsl: HslAdjustments,
  colorWheels: ColorWheelState,
  curveState: CurveState,
  highlightRecovery: number,
  shadowRecovery: number,
  localLayers: LocalAdjustmentLayer[],
): { isReady: boolean; rendererRef: React.RefObject<WebGLRenderer | null> } {
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const progressiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageMpxRef = useRef(imageMpx);
  imageMpxRef.current = imageMpx;
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
  const layersRef = useRef(localLayers);
  layersRef.current = localLayers;

  // Track which mask PNG was last uploaded per layer slot to avoid redundant uploads
  const uploadedMaskPngs = useRef<(string | null)[]>([null, null, null, null]);

  // ── Render cache (PRD Section 5.4) ────────────────────────────────────────
  // Stores up to RENDER_CACHE_MAX full-resolution framebuffer snapshots keyed
  // by adjustment fingerprint.  Cache hits bypass the full shader pipeline.
  type CacheEntry = { data: Uint8Array; width: number; height: number };
  const renderCache = useRef<Map<string, CacheEntry>>(new Map());
  const cacheKeys   = useRef<string[]>([]);

  const lruGet = (key: string): CacheEntry | null => {
    const entry = renderCache.current.get(key);
    if (!entry) return null;
    // Promote to most-recently-used
    const idx = cacheKeys.current.indexOf(key);
    if (idx !== -1) cacheKeys.current.splice(idx, 1);
    cacheKeys.current.push(key);
    return entry;
  };

  const lruSet = (key: string, entry: CacheEntry): void => {
    if (renderCache.current.has(key)) {
      renderCache.current.set(key, entry);
      const idx = cacheKeys.current.indexOf(key);
      if (idx !== -1) cacheKeys.current.splice(idx, 1);
    } else {
      if (cacheKeys.current.length >= RENDER_CACHE_MAX) {
        const oldest = cacheKeys.current.shift()!;
        renderCache.current.delete(oldest);
      }
      renderCache.current.set(key, entry);
    }
    cacheKeys.current.push(key);
  };

  const _maskLens = (): (number | null)[] =>
    uploadedMaskPngs.current.map((m) => (m !== null ? m.length : null));

  const _buildLayerUniforms = (): RendererLocalLayer[] =>
    layersRef.current
      .filter((l) => l.visible && l.mask?.maskPng && !l.mask.isLoading)
      .slice(0, 4)
      .map((l) => ({ opacity: l.opacity, adjustments: l.adjustments }));

  // Destroy renderer on unmount only; clear any pending progressive timer
  useEffect(() => {
    return () => {
      if (progressiveTimerRef.current !== null) {
        clearTimeout(progressiveTimerRef.current);
        progressiveTimerRef.current = null;
      }
      rendererRef.current?.destroy();
      rendererRef.current = null;
    };
  }, []);

  // Keep canvas backing-store in sync with its CSS display size (spec Section 3.3).
  // Skip sync during active progressive-render cycles to avoid undoing the 25% downscale.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      const { offsetWidth: w, offsetHeight: h } = canvas;
      if (!w || !h) return;
      // During progressive rendering the canvas is intentionally smaller than its CSS
      // size. Only sync when there's no pending full-res timer.
      if (progressiveTimerRef.current !== null) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        if (isReady) rendererRef.current?.render(
          adjRef.current, hslRef.current, wheelsRef.current, curvesRef.current,
          hrRef.current, srRef.current, _buildLayerUniforms(),
        );
      }
    });
    obs.observe(canvas);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

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
    // Clear all per-image state when image changes
    uploadedMaskPngs.current = [null, null, null, null];
    renderCache.current.clear();
    cacheKeys.current = [];
    if (progressiveTimerRef.current !== null) {
      clearTimeout(progressiveTimerRef.current);
      progressiveTimerRef.current = null;
    }
    rendererRef.current.loadImage(imageSrc)
      .then(() => setIsReady(true))
      .catch(console.error);
  }, [imageSrc]);

  // Upload changed mask textures and re-render
  useEffect(() => {
    if (!isReady || !rendererRef.current) return;

    const renderer = rendererRef.current;
    const visibleLayers = localLayers
      .filter((l) => l.visible && l.mask?.maskPng && !l.mask.isLoading)
      .slice(0, 4);

    // Upload any mask textures that changed
    visibleLayers.forEach((layer, i) => {
      const png = layer.mask!.maskPng!;
      if (uploadedMaskPngs.current[i] === png) return;
      uploadedMaskPngs.current[i] = png;
      const { maskWidth: w, maskHeight: h } = layer.mask!;
      pngToMask(png, w, h).then((data) => {
        renderer.updateMaskLayer(i, data, w, h);
        renderer.render(
          adjRef.current, hslRef.current, wheelsRef.current, curvesRef.current,
          hrRef.current, srRef.current, _buildLayerUniforms(),
        );
      }).catch(console.error);
    });

    // Clear slots for layers that disappeared
    for (let i = visibleLayers.length; i < 4; i++) {
      if (uploadedMaskPngs.current[i] !== null) {
        uploadedMaskPngs.current[i] = null;
        renderer.updateMaskLayer(i, null, 1, 1);
      }
    }

    renderer.render(
      adjRef.current, hslRef.current, wheelsRef.current, curvesRef.current,
      hrRef.current, srRef.current, _buildLayerUniforms(),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localLayers, isReady]);

  // Re-render when global adjustments change.
  //
  // Large images (> 4 MP) — PRD Section 5.3 progressive rendering:
  //   Pass 1 (immediate): render at 25% resolution for instant slider feedback.
  //   Pass 2 (deferred):  200 ms after the last change, render full-res.
  //     → Check render cache first (PRD Section 5.4): if this exact state was
  //       rendered before, blit the cached pixels via the pass-through shader
  //       instead of running the full pipeline.
  //
  // Small images (≤ 4 MP) — always render at full resolution, also cache-aware:
  //   Cache hit  → renderFromCache() immediately (no RAF, no GPU pipeline).
  //   Cache miss → render() via RAF; capture pixels in the onRendered callback.
  useEffect(() => {
    if (!isReady) return;
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    if (!renderer || !canvas) return;

    const ll  = _buildLayerUniforms();
    const mls = _maskLens();
    const key = buildFingerprint(adjustments, hsl, colorWheels, curveState,
      highlightRecovery, shadowRecovery, ll, mls);

    if (imageMpxRef.current > 4_000_000) {
      // ── Large image: progressive + cache ───────────────────────────────────
      if (progressiveTimerRef.current !== null) clearTimeout(progressiveTimerRef.current);

      // Pass 1 — 25% preview (no cache — ephemeral)
      const fullW = canvas.offsetWidth;
      const fullH = canvas.offsetHeight;
      if (fullW && fullH) {
        canvas.width  = Math.max(1, Math.round(fullW / 2));
        canvas.height = Math.max(1, Math.round(fullH / 2));
      }
      renderer.render(adjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery, ll);

      // Pass 2 — full-res after 200 ms idle, cache-aware
      progressiveTimerRef.current = setTimeout(() => {
        progressiveTimerRef.current = null;
        const c = canvasRef.current;
        const r = rendererRef.current;
        if (!c || !r) return;
        const w = c.offsetWidth, h = c.offsetHeight;
        if (w && h) { c.width = w; c.height = h; }

        // Build the key from the LATEST refs so it reflects any interim changes
        const latestLl  = _buildLayerUniforms();
        const latestMls = _maskLens();
        const latestKey = buildFingerprint(
          adjRef.current, hslRef.current, wheelsRef.current, curvesRef.current,
          hrRef.current, srRef.current, latestLl, latestMls,
        );

        const cached = lruGet(latestKey);
        if (cached && cached.width === w && cached.height === h) {
          // Cache hit — blit stored pixels, skip the full shader pipeline
          r.cancelPending();
          r.renderFromCache(cached.data, cached.width, cached.height);
        } else {
          // Cache miss — full synchronous render then capture
          r.cancelPending();
          r.drawSync(
            adjRef.current, hslRef.current, wheelsRef.current, curvesRef.current,
            hrRef.current, srRef.current, latestLl,
          );
          const captured = r.capturePixels();
          if (captured) lruSet(latestKey, captured);
        }
      }, 200);
    } else {
      // ── Small image: full-res, cache-aware ─────────────────────────────────
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      const cached = lruGet(key);
      if (cached && cached.width === w && cached.height === h) {
        // Cache hit — instant blit, no GPU pipeline
        renderer.cancelPending();
        renderer.renderFromCache(cached.data, cached.width, cached.height);
      } else {
        // Cache miss — RAF render; capture result for future hits
        renderer.render(
          adjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery, ll,
          () => {
            const captured = rendererRef.current?.capturePixels();
            if (captured) lruSet(key, captured);
          },
        );
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery, isReady]);

  return { isReady, rendererRef };
}

// ─── Canvas component ─────────────────────────────────────────────────────────

export function Canvas() {
  const {
    images, activeImageId, viewMode, setViewMode,
    adjustments, effectiveAdjustments, hsl, colorWheels, curveState, importImages,
    tatActive, setTatActive, setTatLuminance, setCurve,
    highlightRecovery, shadowRecovery,
    localLayers, activeBrushLayerId, brushSize, brushHardness, commitBrushMask,
  } = useWorkspace();
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const glCanvasRef    = useRef<HTMLCanvasElement>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement>(null);

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

  // WebGL renderer — renders effectiveAdjustments + HSL + color wheels + tone curve + local layers
  const { isReady, rendererRef } = useWebGLCanvas(
    glCanvasRef,
    activeImage?.originalDataUrl ?? null,
    (activeImage?.width ?? 0) * (activeImage?.height ?? 0),
    effectiveAdjustments,
    hsl,
    colorWheels,
    curveState,
    highlightRecovery,
    shadowRecovery,
    localLayers,
  );

  // ── Brush tool ─────────────────────────────────────────────────────────────

  // Live mask data for the active brush layer (decoded once, painted in-memory)
  const brushMaskDataRef = useRef<Uint8ClampedArray | null>(null);
  const brushMaskDirtyRef = useRef(false);
  const brushLastPosRef = useRef<{ x: number; y: number } | null>(null);
  const brushIsDown = useRef(false);

  const activeBrushLayer = activeBrushLayerId
    ? localLayers.find((l) => l.id === activeBrushLayerId) ?? null
    : null;

  // Load brush mask data whenever the active brush layer changes
  useEffect(() => {
    brushMaskDataRef.current = null;
    brushMaskDirtyRef.current = false;
    if (!activeBrushLayer?.mask?.maskPng || !activeImage) return;
    const { maskWidth: w, maskHeight: h } = activeBrushLayer.mask;
    pngToMask(activeBrushLayer.mask.maskPng, w, h)
      .then((data) => { brushMaskDataRef.current = new Uint8ClampedArray(data); })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrushLayerId, activeImage?.id]);

  /** Convert a screen-space point (relative to container) to mask-space. */
  const screenToMask = useCallback((sx: number, sy: number): { x: number; y: number } | null => {
    if (!containerSize.w || !containerSize.h || !activeImage || !activeBrushLayer?.mask) return null;
    const fit = containFit(containerSize.w, containerSize.h, activeImage.width, activeImage.height);
    // Invert zoom/pan: screen → container-local
    const cx = containerSize.w / 2, cy = containerSize.h / 2;
    const lx = cx + (sx - cx - pan.x) / zoom;
    const ly = cy + (sy - cy - pan.y) / zoom;
    // Container-local → image fraction → mask pixels
    const fx = (lx - fit.left) / fit.width;
    const fy = (ly - fit.top) / fit.height;
    const { maskWidth: mw, maskHeight: mh } = activeBrushLayer.mask;
    return { x: fx * mw, y: fy * mh };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerSize, activeImage, activeBrushLayer, pan, zoom]);

  /** Paint a stroke at the given screen point and refresh the WebGL mask texture. */
  const doBrushStroke = useCallback((sx: number, sy: number, erase: boolean) => {
    if (!brushMaskDataRef.current || !activeBrushLayer?.mask) return;
    const pos = screenToMask(sx, sy);
    if (!pos) return;
    const { maskWidth: mw, maskHeight: mh } = activeBrushLayer.mask;

    // Interpolate with last position for smooth strokes
    const last = brushLastPosRef.current;
    if (last) {
      const steps = Math.ceil(Math.hypot(pos.x - last.x, pos.y - last.y) / (brushSize * 0.3));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        paintBrush(brushMaskDataRef.current, mw, mh,
          last.x + (pos.x - last.x) * t, last.y + (pos.y - last.y) * t,
          brushSize, brushHardness, erase);
      }
    } else {
      paintBrush(brushMaskDataRef.current, mw, mh, pos.x, pos.y, brushSize, brushHardness, erase);
    }
    brushLastPosRef.current = pos;
    brushMaskDirtyRef.current = true;

    // Upload updated mask texture directly to renderer for 60fps feedback
    if (rendererRef.current) {
      rendererRef.current.updateMaskLayer(
        localLayers.filter((l) => l.visible && l.mask?.maskPng && !l.mask.isLoading).slice(0, 4)
          .findIndex((l) => l.id === activeBrushLayerId),
        brushMaskDataRef.current, mw, mh,
      );
      rendererRef.current.render(
        effectiveAdjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery,
        localLayers.filter((l) => l.visible && l.mask?.maskPng && !l.mask.isLoading).slice(0, 4)
          .map((l) => ({ opacity: l.opacity, adjustments: l.adjustments })),
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrushLayer, brushSize, brushHardness, screenToMask, rendererRef,
      activeBrushLayerId, localLayers, effectiveAdjustments, hsl, colorWheels, curveState, highlightRecovery, shadowRecovery]);

  const handleBrushPointerDown = useCallback((e: React.PointerEvent) => {
    if (!activeBrushLayerId || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    brushIsDown.current = true;
    brushLastPosRef.current = null;
    const rect = containerRef.current!.getBoundingClientRect();
    doBrushStroke(e.clientX - rect.left, e.clientY - rect.top, e.altKey);
  }, [activeBrushLayerId, doBrushStroke]);

  const handleBrushPointerMove = useCallback((e: React.PointerEvent) => {
    if (!activeBrushLayerId || !brushIsDown.current) return;
    const rect = containerRef.current!.getBoundingClientRect();
    doBrushStroke(e.clientX - rect.left, e.clientY - rect.top, e.altKey);
  }, [activeBrushLayerId, doBrushStroke]);

  const handleBrushPointerUp = useCallback(() => {
    if (!activeBrushLayerId || !brushMaskDirtyRef.current || !brushMaskDataRef.current || !activeBrushLayer?.mask) return;
    brushIsDown.current = false;
    brushLastPosRef.current = null;
    brushMaskDirtyRef.current = false;
    const { maskWidth: mw, maskHeight: mh } = activeBrushLayer.mask;
    const png = maskToPng(brushMaskDataRef.current, mw, mh);
    commitBrushMask(activeBrushLayerId, png);
  }, [activeBrushLayerId, activeBrushLayer, commitBrushMask]);

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
            {/* Brush painting overlay — outside the zoom/pan transform so coords are in container space */}
            {activeBrushLayerId && (
              <div
                className="absolute inset-0 z-30"
                style={{ cursor: "none" }}
                onPointerDown={handleBrushPointerDown}
                onPointerMove={handleBrushPointerMove}
                onPointerUp={handleBrushPointerUp}
              >
                <div className="absolute top-2 left-1/2 -translate-x-1/2 text-[10px] bg-black/70 text-zinc-300 px-2 py-0.5 rounded pointer-events-none">
                  Brush · Paint to add · Alt+paint to erase
                </div>
              </div>
            )}

            <div
              style={{
                position: "absolute",
                inset: 0,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: "50% 50%",
                cursor: activeBrushLayerId ? "none" : tatActive ? "crosshair" : isPanning ? "grabbing" : "grab",
              }}
              onMouseDown={activeBrushLayerId ? undefined : startPan}
              onPointerDown={activeBrushLayerId ? undefined : handleTatPointerDown}
              onPointerMove={activeBrushLayerId ? undefined : handleTatPointerMove}
              onPointerUp={activeBrushLayerId ? undefined : handleTatPointerUp}
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
