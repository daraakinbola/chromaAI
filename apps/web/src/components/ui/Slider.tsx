"use client";

import { clsx } from "clsx";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  showValue?: boolean;
  unit?: string;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  showValue = true,
  unit = "",
  disabled = false,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  const displayValue = Number.isInteger(value) ? value : value.toFixed(2);

  return (
    <div className={clsx("group flex flex-col gap-1", disabled && "opacity-40 pointer-events-none")}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400 group-hover:text-zinc-300 transition-colors">
          {label}
        </span>
        {showValue && (
          <span className="text-xs font-mono text-zinc-500 group-hover:text-zinc-400 tabular-nums min-w-[36px] text-right">
            {displayValue}{unit}
          </span>
        )}
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full"
          style={{
            background: `linear-gradient(to right, #8b5cf6 0%, #8b5cf6 ${pct}%, #3f3f46 ${pct}%, #3f3f46 100%)`,
          }}
        />
      </div>
    </div>
  );
}
