"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pipette, RotateCcw } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import { buildSvgPath, computeHistogram, parametricToPoints } from "@/lib/curveMath";
import type { CurveChannel, ToneCurve } from "@/types";

// ─── Presets ──────────────────────────────────────────────────────────────────

const PRESETS: Record<string, [number, number][]> = {
  "Linear":                [[0, 0], [255, 255]],
  "Medium Contrast":       [[0, 0], [64, 52],  [128, 128], [192, 203], [255, 255]],
  "Strong Contrast":       [[0, 0], [64, 40],  [128, 128], [192, 215], [255, 255]],
  "Lifted Blacks":         [[0, 28], [255, 255]],
  "Crushed Blacks":        [[0, 0],  [40, 0],  [128, 128], [255, 255]],
  "Film Highlight Rolloff":[[0, 0],  [128, 128],[200, 218], [255, 243]],
};

const CHANNEL_COLOR: Record<CurveChannel, string> = {
  composite: "#ffffff",
  red:       "#ef4444",
  green:     "#22c55e",
  blue:      "#3b82f6",
};

const CHANNEL_ACTIVE_CLASS: Record<CurveChannel, string> = {
  composite: "bg-zinc-700 text-zinc-100",
  red:       "bg-red-500/20 text-red-400",
  green:     "bg-green-500/20 text-green-400",
  blue:      "bg-blue-500/20 text-blue-400",
};

// ─── ToneCurveEditor ─────────────────────────────────────────────────────────

export function ToneCurveEditor() {
  const {
    curveState,
    setCurve,
    setCurveActiveChannel,
    resetCurve,
    resetAllCurves,
    tatActive,
    setTatActive,
    tatLuminance,
    images,
    activeImageId,
  } = useWorkspace();

  const [histogram, setHistogram] = useState<number[]>([]);
  const svgRef = useRef<SVGSVGElement>(null);

  // Per-drag tracking: we store the index into curve.points being dragged
  const draggingRef = useRef<{ ptIdx: number; isAnchor: boolean } | null>(null);

  const channel = curveState.activeChannel;
  const curve: ToneCurve = curveState[channel];

  // ── Histogram ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const img = images.find((i) => i.id === activeImageId);
    if (!img) { setHistogram([]); return; }
    let cancelled = false;
    computeHistogram(img.thumbnailDataUrl)
      .then((h) => { if (!cancelled) setHistogram(h); })
      .catch(() => { if (!cancelled) setHistogram([]); });
    return () => { cancelled = true; };
  }, [activeImageId, images]);

  // ── Effective points (point mode or parametric → points) ────────────────────
  const pts: [number, number][] = curve.mode === "parametric"
    ? parametricToPoints(curve.parametric)
    : curve.points;

  // ── Curve path via bezier-js cubic segments (PRD §7) ────────────────────────
  // buildSvgPath generates proper SVG C commands from the control points using
  // the same monotone Hermite tangents as the LUT, but expressed as true cubic
  // bezier segments rather than 256 line segments.
  const pathD = useMemo(() => buildSvgPath(pts), [pts]);

  // ── Histogram path ───────────────────────────────────────────────────────────
  const histPath = useMemo(() => {
    if (!histogram.length) return "";
    const max = Math.max(...histogram, 1);
    const pts256 = histogram.map((v, i) => `${i},${256 - Math.floor((v / max) * 200)}`).join(" ");
    return `M0,256 L${pts256} L255,256 Z`;
  }, [histogram]);

  // ── Coordinate helpers ───────────────────────────────────────────────────────
  const getSvgCoords = useCallback((e: React.PointerEvent | React.MouseEvent) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 256,
      y: ((e.clientY - rect.top) / rect.height) * 256,
    };
  }, []);

  const svgToCurve = (sx: number, sy: number) => ({
    x: Math.max(0, Math.min(255, Math.round(sx))),
    y: Math.max(0, Math.min(255, Math.round(255 - sy))),
  });

  // ── Pointer events ───────────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (curve.mode !== "point") return;
    e.preventDefault();
    const coords = getSvgCoords(e);
    if (!coords) return;

    const activePts = curve.points;
    const THRESHOLD = 10;
    let hitIdx = -1;
    let minDist = Infinity;
    for (let i = 0; i < activePts.length; i++) {
      const [px, py] = activePts[i];
      const d = Math.hypot(coords.x - px, coords.y - (255 - py));
      if (d < minDist && d < THRESHOLD) { minDist = d; hitIdx = i; }
    }

    if (hitIdx >= 0) {
      const isAnchor = hitIdx === 0 || hitIdx === activePts.length - 1;
      draggingRef.current = { ptIdx: hitIdx, isAnchor };
      svgRef.current?.setPointerCapture(e.pointerId);
    } else {
      // Add new point if under the limit
      if (activePts.length >= 16) return;
      const { x, y } = svgToCurve(coords.x, coords.y);
      if (activePts.some(([px]) => px === x)) return;
      const newPts: [number, number][] = [...activePts, [x, y] as [number, number]].sort((a, b) => a[0] - b[0]);
      setCurve(channel, { ...curve, points: newPts });
      const newIdx = newPts.findIndex(([px]) => px === x);
      draggingRef.current = { ptIdx: newIdx, isAnchor: false };
      svgRef.current?.setPointerCapture(e.pointerId);
    }
  }, [curve, channel, getSvgCoords, setCurve]);

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current || curve.mode !== "point") return;
    const coords = getSvgCoords(e);
    if (!coords) return;

    const { ptIdx, isAnchor } = draggingRef.current;
    const activePts = curve.points;

    // Delete if dragged outside canvas (non-anchors only)
    const isOutside = coords.x < -20 || coords.x > 276 || coords.y < -20 || coords.y > 276;
    if (isOutside && !isAnchor && activePts.length > 2) {
      const newPts = activePts.filter((_, i) => i !== ptIdx);
      setCurve(channel, { ...curve, points: newPts });
      draggingRef.current = null;
      return;
    }

    const clamped = svgToCurve(
      Math.max(0, Math.min(255, coords.x)),
      Math.max(0, Math.min(255, coords.y))
    );

    const newPts: [number, number][] = [...activePts];
    if (isAnchor) {
      // Anchors: keep x fixed, only move y
      newPts[ptIdx] = [activePts[ptIdx][0], clamped.y];
    } else {
      newPts[ptIdx] = [clamped.x, clamped.y];
    }
    setCurve(channel, { ...curve, points: newPts });
  }, [curve, channel, getSvgCoords, setCurve]);

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current || curve.mode !== "point") { draggingRef.current = null; return; }
    // Sort points on release
    const sorted: [number, number][] = [...curve.points].sort((a, b) => a[0] - b[0]);
    setCurve(channel, { ...curve, points: sorted });
    draggingRef.current = null;
  }, [curve, channel, setCurve]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (curve.mode !== "point") return;
    const coords = getSvgCoords(e);
    if (!coords) return;
    const activePts = curve.points;
    const THRESHOLD = 10;
    let hitIdx = -1;
    let minDist = Infinity;
    for (let i = 0; i < activePts.length; i++) {
      const [px, py] = activePts[i];
      const d = Math.hypot(coords.x - px, coords.y - (255 - py));
      if (d < minDist && d < THRESHOLD) { minDist = d; hitIdx = i; }
    }
    // Anchors cannot be deleted; need at least 2 points
    if (hitIdx > 0 && hitIdx < activePts.length - 1 && activePts.length > 2) {
      setCurve(channel, { ...curve, points: activePts.filter((_, i) => i !== hitIdx) });
    }
  }, [curve, channel, getSvgCoords, setCurve]);

  // ── Preset apply ─────────────────────────────────────────────────────────────
  const applyPreset = (name: string) => {
    const preset = PRESETS[name];
    if (!preset) return;
    setCurve(channel, { ...curve, points: preset, mode: "point" });
  };

  // ── TAT indicator ────────────────────────────────────────────────────────────
  const tatX = tatActive && tatLuminance !== null ? tatLuminance : null;

  // Escape key deactivates TAT
  useEffect(() => {
    if (!tatActive) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setTatActive(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tatActive, setTatActive]);

  const channelColor = CHANNEL_COLOR[channel];

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-2">
      {/* Channel selector */}
      <div className="flex gap-0.5">
        {(["composite", "red", "green", "blue"] as CurveChannel[]).map((ch) => (
          <button
            key={ch}
            onClick={() => setCurveActiveChannel(ch)}
            className={clsx(
              "flex-1 py-1 text-[9px] uppercase tracking-wider rounded transition-colors",
              channel === ch
                ? CHANNEL_ACTIVE_CLASS[ch]
                : "text-zinc-600 hover:text-zinc-400"
            )}
          >
            {ch === "composite" ? "RGB" : ch[0].toUpperCase()}
          </button>
        ))}
      </div>

      {/* SVG curve canvas */}
      <svg
        ref={svgRef}
        viewBox="0 0 256 256"
        className="w-full aspect-square rounded bg-zinc-900 border border-zinc-800 select-none"
        style={{ cursor: curve.mode === "point" ? "crosshair" : "default", touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        {/* Grid lines */}
        {[64, 128, 192].map((v) => (
          <g key={v}>
            <line x1={v} y1={0} x2={v} y2={256} stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
            <line x1={0} y1={256 - v} x2={256} y2={256 - v} stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
          </g>
        ))}

        {/* Histogram */}
        {histPath && <path d={histPath} fill="rgba(255,255,255,0.06)" />}

        {/* Diagonal baseline */}
        <line x1={0} y1={256} x2={256} y2={0} stroke="rgba(255,255,255,0.12)" strokeWidth="0.75" strokeDasharray="4,4" />

        {/* Curve */}
        <path d={pathD} fill="none" stroke={channelColor} strokeWidth="1.5" />

        {/* Control points (point mode only) */}
        {curve.mode === "point" && curve.points.map(([px, py], i) => {
          const isAnchor = i === 0 || i === curve.points.length - 1;
          return (
            <circle
              key={`${i}-${px}-${py}`}
              cx={px}
              cy={255 - py}
              r={4}
              fill={channelColor}
              stroke="white"
              strokeWidth="1.5"
              opacity={isAnchor ? 0.6 : 1}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {/* TAT indicator line */}
        {tatX !== null && (
          <line
            x1={tatX} y1={0} x2={tatX} y2={256}
            stroke="rgba(251,191,36,0.7)" strokeWidth="1" strokeDasharray="3,3"
          />
        )}

        {/* Axis labels */}
        <text x={2} y={253} fill="rgba(255,255,255,0.18)" fontSize="7" fontFamily="monospace">
          Shadows
        </text>
        <text x={254} y={253} fill="rgba(255,255,255,0.18)" fontSize="7" fontFamily="monospace" textAnchor="end">
          Highlights
        </text>
      </svg>

      {/* Controls row */}
      <div className="flex items-center gap-1.5">
        {/* Mode toggle */}
        <div className="flex gap-0.5 flex-1">
          {(["point", "parametric"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setCurve(channel, { ...curve, mode })}
              className={clsx(
                "flex-1 text-[9px] py-1 rounded transition-colors",
                curve.mode === mode ? "bg-zinc-700 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
              )}
            >
              {mode === "point" ? "Point" : "Parametric"}
            </button>
          ))}
        </div>

        {/* TAT eyedropper */}
        <button
          onClick={() => setTatActive(!tatActive)}
          title="Targeted Adjustment Tool — hover over image to see luminance on curve; drag to adjust"
          className={clsx(
            "p-1.5 rounded transition-colors",
            tatActive
              ? "bg-yellow-500/20 text-yellow-400"
              : "text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800"
          )}
        >
          <Pipette className="w-3 h-3" />
        </button>

        {/* Presets */}
        <select
          value=""
          onChange={(e) => { applyPreset(e.target.value); e.currentTarget.value = ""; }}
          className="text-[9px] bg-zinc-800 border border-zinc-700 text-zinc-400 rounded px-1 py-1 cursor-pointer"
        >
          <option value="">Preset…</option>
          {Object.keys(PRESETS).map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {/* Parametric sliders */}
      {curve.mode === "parametric" && (
        <div className="flex flex-col gap-2 pt-1">
          {(["highlights", "lights", "darks", "shadows"] as const).map((field) => (
            <div key={field} className="flex items-center gap-2">
              <span className="text-[9px] text-zinc-500 w-16 capitalize shrink-0">{field}</span>
              <input
                type="range" min={-100} max={100} step={1}
                value={curve.parametric[field]}
                onChange={(e) =>
                  setCurve(channel, {
                    ...curve,
                    parametric: { ...curve.parametric, [field]: Number(e.target.value) },
                  })
                }
                className="flex-1"
              />
              <span className="text-[9px] font-mono text-zinc-500 w-8 text-right shrink-0">
                {curve.parametric[field] > 0 ? "+" : ""}{curve.parametric[field]}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Reset row */}
      <div className="flex gap-1.5">
        <button
          onClick={() => resetCurve(channel)}
          className="flex items-center gap-1 flex-1 justify-center text-[9px] text-zinc-600 hover:text-zinc-400 py-1 rounded hover:bg-zinc-800 transition-colors"
        >
          <RotateCcw className="w-2.5 h-2.5" />
          Reset {channel === "composite" ? "RGB" : channel[0].toUpperCase()}
        </button>
        <button
          onClick={resetAllCurves}
          className="flex items-center gap-1 flex-1 justify-center text-[9px] text-zinc-600 hover:text-zinc-400 py-1 rounded hover:bg-zinc-800 transition-colors"
        >
          <RotateCcw className="w-2.5 h-2.5" />
          Reset all
        </button>
      </div>
    </div>
  );
}
