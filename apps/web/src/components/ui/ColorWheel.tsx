"use client";

import { useRef } from "react";
import { RotateCcw } from "lucide-react";
import { clsx } from "clsx";
import type { WheelState } from "@/types";

// ─── Geometry constants ───────────────────────────────────────────────────────

const W  = 88;       // SVG/container size (px)
const CX = W / 2;   // centre x
const CY = W / 2;   // centre y
const R  = 36;       // wheel radius (px, leaving 8px border)

// Hue 0° = top (12 o'clock) = red, increases clockwise.
// This matches CSS conic-gradient(from 0deg, hsl(0), …) which also starts red
// at the top and progresses clockwise.

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
  // atan2(sin, cos) where sin component = dx, cos component = -dy
  // (top = 0°, clockwise in screen space)
  const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  return { hue, saturation };
}

// Conic gradient: 24 HSL stops every 15° for smooth wheel appearance.
// `from 0deg` in CSS starts at 12 o'clock, matching hue 0° = top.
const CONIC_STOPS = Array.from({ length: 25 }, (_, i) => {
  const h = i * 15;
  const pct = ((i / 24) * 100).toFixed(2);
  return `hsl(${h}deg,100%,50%) ${pct}%`;
}).join(",");
const CONIC_BG = `conic-gradient(from 0deg,${CONIC_STOPS})`;

// Radial gradient: white at centre (desaturated) fading to transparent.
const RADIAL_BG =
  "radial-gradient(circle,rgba(255,255,255,0.98) 0%,rgba(255,255,255,0.6) 35%,rgba(255,255,255,0) 70%)";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ColorWheelProps {
  label: string;
  value: WheelState;
  onChange: (v: WheelState) => void;
  onReset: () => void;
  disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ColorWheel({ label, value, onChange, onReset, disabled }: ColorWheelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const { x: dotX, y: dotY } = polarToXY(value.hue, value.saturation);

  // Indicator fill: the current hue at full saturation so it's always visible
  const dotFill = value.saturation < 0.02
    ? "rgba(255,255,255,0.8)"
    : `hsl(${value.hue.toFixed(1)}deg,100%,50%)`;

  const getWheelCoords = (e: PointerEvent | React.PointerEvent): { x: number; y: number } | null => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const coords = getWheelCoords(e);
    if (!coords) return;
    const { hue, saturation } = xyToPolar(coords.x, coords.y);
    onChange({ ...value, hue, saturation });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    e.preventDefault();
    const coords = getWheelCoords(e);
    if (!coords) return;
    const { hue, saturation } = xyToPolar(coords.x, coords.y);
    onChange({ ...value, hue, saturation });
  };

  const handlePointerUp = () => { dragging.current = false; };

  const isDefault =
    value.hue === 0 && value.saturation === 0 && value.luminance === 0;

  const lumPct = ((value.luminance + 1) / 2) * 100;

  return (
    <div className="flex flex-col items-center gap-1.5">
      {/* Zone label */}
      <span className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">
        {label}
      </span>

      {/* Colour wheel */}
      <div
        ref={containerRef}
        style={{ width: W, height: W, position: "relative", cursor: disabled ? "default" : "crosshair" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className={clsx(disabled && "opacity-40 pointer-events-none")}
      >
        {/* Hue conic ring */}
        <div
          style={{
            position: "absolute", inset: 0,
            borderRadius: "50%",
            background: CONIC_BG,
          }}
        />
        {/* Desaturation mask (white centre) */}
        <div
          style={{
            position: "absolute", inset: 0,
            borderRadius: "50%",
            background: RADIAL_BG,
          }}
        />
        {/* Wheel border */}
        <div
          style={{
            position: "absolute", inset: 0,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.5)",
          }}
        />

        {/* SVG indicator overlay — pointer-events: none so the div handles hits */}
        <svg
          width={W}
          height={W}
          viewBox={`0 0 ${W} ${W}`}
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          {/* Subtle crosshairs */}
          <line x1={CX} y1={4}   x2={CX} y2={W - 4} stroke="rgba(0,0,0,0.18)" strokeWidth="0.75" />
          <line x1={4}  y1={CY}  x2={W - 4} y2={CY} stroke="rgba(0,0,0,0.18)" strokeWidth="0.75" />

          {/* Indicator dot */}
          <circle
            cx={dotX}
            cy={dotY}
            r={4.5}
            fill={dotFill}
            stroke="white"
            strokeWidth="1.5"
            style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))" }}
          />
          {/* Black outline ring for contrast */}
          <circle
            cx={dotX}
            cy={dotY}
            r={4.5}
            fill="none"
            stroke="rgba(0,0,0,0.4)"
            strokeWidth="0.75"
          />
        </svg>
      </div>

      {/* Luminance slider */}
      <div className={clsx("w-full flex flex-col gap-0.5", disabled && "opacity-40 pointer-events-none")}>
        <div className="flex items-center justify-between">
          <span className="text-[9px] text-zinc-600">Lum</span>
          <span className="text-[9px] font-mono text-zinc-600 tabular-nums">
            {value.luminance >= 0 ? "+" : ""}
            {(value.luminance * 100).toFixed(0)}
          </span>
        </div>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.01}
          value={value.luminance}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, luminance: parseFloat(e.target.value) })}
          className="w-full"
          style={{
            background: `linear-gradient(to right,#8b5cf6 0%,#8b5cf6 ${lumPct}%,#3f3f46 ${lumPct}%,#3f3f46 100%)`,
          }}
        />
      </div>

      {/* Per-wheel reset */}
      <button
        onClick={onReset}
        disabled={disabled || isDefault}
        className="flex items-center gap-0.5 text-[9px] text-zinc-700 hover:text-zinc-400 disabled:opacity-30 disabled:pointer-events-none transition-colors"
      >
        <RotateCcw className="w-2 h-2" />
        Reset
      </button>
    </div>
  );
}
