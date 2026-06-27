"use client";

import { useRef } from "react";
import { RotateCcw } from "lucide-react";
import { clsx } from "clsx";
import type { WheelState } from "@/types";

// ─── Geometry — spec section 2.2: each wheel 120px diameter ─────────────────

const W  = 120;      // container / SVG size (px) — spec: "120px diameter"
const CX = W / 2;   // centre x = 60
const CY = W / 2;   // centre y = 60
const R  = 50;       // wheel radius (60 − 10px border margin)

// Hue convention: 0° = top (12 o'clock) = CSS hsl(0deg) = red, clockwise.
// Matches conic-gradient(from 0deg, hsl(0deg)…) which also starts red at top.

function polarToXY(hue: number, sat: number): { x: number; y: number } {
  const rad = (hue * Math.PI) / 180;
  return {
    x: CX + R * Math.sin(rad) * sat,
    y: CY - R * Math.cos(rad) * sat,
  };
}

function xyToPolar(x: number, y: number): { hue: number; saturation: number } {
  const dx = x - CX;
  const dy = y - CY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const saturation = Math.min(1, dist / R);
  const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return { hue, saturation };
}

// 24-stop conic gradient every 15° for a smooth colour wheel.
// from 0deg → red at top, increasing clockwise.
const CONIC_STOPS = Array.from({ length: 25 }, (_, i) => {
  const h = i * 15;
  const pct = ((i / 24) * 100).toFixed(2);
  return `hsl(${h}deg,100%,50%) ${pct}%`;
}).join(",");
const CONIC_BG  = `conic-gradient(from 0deg,${CONIC_STOPS})`;
const RADIAL_BG = "radial-gradient(circle,rgba(255,255,255,0.98) 0%,rgba(255,255,255,0.6) 35%,rgba(255,255,255,0) 70%)";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ColorWheelProps {
  label: string;
  value: WheelState;
  onChange: (v: WheelState) => void;
  onReset: () => void;
  disabled?: boolean;
}

const DEFAULT_WHEEL: WheelState = { hue: 0, saturation: 0, luminance: 0 };

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorWheel({ label, value, onChange, onReset, disabled }: ColorWheelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const { x: dotX, y: dotY } = polarToXY(value.hue, value.saturation);
  const dotFill = value.saturation < 0.02
    ? "rgba(255,255,255,0.85)"
    : `hsl(${value.hue.toFixed(1)}deg,100%,50%)`;

  const getCoords = (e: React.PointerEvent | PointerEvent) => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const applyCoords = (e: React.PointerEvent) => {
    const c = getCoords(e);
    if (!c) return;
    const { hue, saturation } = xyToPolar(c.x, c.y);
    onChange({ ...value, hue, saturation });
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    applyCoords(e);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.preventDefault();
    applyCoords(e);
  };

  const handlePointerUp = () => { dragging.current = false; };

  // Spec section 2.2: "double-click indicator to reset"
  const handleDoubleClick = () => {
    if (!disabled) onReset();
  };

  const isDefault =
    value.hue === 0 && value.saturation === 0 && value.luminance === 0;

  const lumPct = ((value.luminance + 1) / 2) * 100;

  // Numeric readout helpers (spec: "numeric readout below each slider")
  const fmtDeg = value.saturation < 0.005
    ? "—"
    : `${value.hue.toFixed(0)}°`;
  const fmtSat = `${(value.saturation * 100).toFixed(0)}%`;
  const fmtLum = `${value.luminance >= 0 ? "+" : ""}${(value.luminance * 100).toFixed(0)}`;

  return (
    <div className="flex flex-col items-center gap-1.5">
      {/* Zone label */}
      <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">
        {label}
      </span>

      {/* Colour wheel — spec: 120px diameter */}
      <div
        ref={containerRef}
        style={{ width: W, height: W, position: "relative", cursor: disabled ? "default" : "crosshair" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        className={clsx(disabled && "opacity-40 pointer-events-none")}
      >
        {/* Hue conic ring */}
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: CONIC_BG }} />
        {/* Desaturation mask (white centre) */}
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: RADIAL_BG }} />
        {/* Border */}
        <div style={{
          position: "absolute", inset: 0, borderRadius: "50%",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.5)",
        }} />

        {/* SVG indicator — pointer-events:none so the div handles all hits */}
        <svg
          width={W} height={W} viewBox={`0 0 ${W} ${W}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {/* Subtle crosshairs */}
          <line x1={CX} y1={5}   x2={CX} y2={W-5} stroke="rgba(0,0,0,0.15)" strokeWidth="0.75" />
          <line x1={5}  y1={CY}  x2={W-5} y2={CY} stroke="rgba(0,0,0,0.15)" strokeWidth="0.75" />
          {/* Indicator dot — spec: "draggable indicator dot" */}
          <circle cx={dotX} cy={dotY} r={5.5}
            fill={dotFill} stroke="white" strokeWidth="2"
            style={{ filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.55))" }}
          />
          <circle cx={dotX} cy={dotY} r={5.5}
            fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth="0.75"
          />
        </svg>
      </div>

      {/* Numeric readout — spec: "numeric readout below each slider" */}
      <div className={clsx("w-full", disabled && "opacity-40 pointer-events-none")}>
        <div className="flex justify-between text-[8px] font-mono text-zinc-600 mb-0.5 px-0.5">
          <span title="Hue">{fmtDeg}</span>
          <span title="Saturation">{fmtSat}</span>
          <span title="Luminance">{fmtLum}</span>
        </div>

        {/* Luminance slider — spec: "luminance slider (−1.0 to +1.0) labeled with the zone name" */}
        <div className="flex items-center gap-1.5">
          <span className="text-[8px] text-zinc-600 uppercase tracking-wide shrink-0">Lum</span>
          <input
            type="range" min={-1} max={1} step={0.01}
            value={value.luminance}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, luminance: parseFloat(e.target.value) })}
            className="flex-1"
            style={{
              background: `linear-gradient(to right,#8b5cf6 0%,#8b5cf6 ${lumPct}%,#3f3f46 ${lumPct}%,#3f3f46 100%)`,
            }}
          />
        </div>
      </div>

      {/* Per-wheel reset — spec: "reset button per wheel, double-click indicator to reset" */}
      <button
        onClick={onReset}
        disabled={disabled || isDefault}
        title="Reset wheel (or double-click the indicator)"
        className="flex items-center gap-0.5 text-[8px] text-zinc-700 hover:text-zinc-400 disabled:opacity-30 disabled:pointer-events-none transition-colors"
      >
        <RotateCcw className="w-2 h-2" />
        Reset
      </button>
    </div>
  );
}
