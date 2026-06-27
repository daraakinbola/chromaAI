"use client";

import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { clsx } from "clsx";
import { Slider } from "@/components/ui/Slider";
import { ColorWheel } from "@/components/ui/ColorWheel";
import { useWorkspace } from "@/context/WorkspaceContext";
import { AdjustmentState, HslColor } from "@/types";

const HSL_COLORS: { key: HslColor; label: string; dot: string }[] = [
  { key: "red",     label: "Red",     dot: "#ef4444" },
  { key: "orange",  label: "Orange",  dot: "#f97316" },
  { key: "yellow",  label: "Yellow",  dot: "#eab308" },
  { key: "green",   label: "Green",   dot: "#22c55e" },
  { key: "aqua",    label: "Aqua",    dot: "#06b6d4" },
  { key: "blue",    label: "Blue",    dot: "#3b82f6" },
  { key: "purple",  label: "Purple",  dot: "#a855f7" },
  { key: "magenta", label: "Magenta", dot: "#ec4899" },
];

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-zinc-800/60 last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between w-full px-4 py-2.5 hover:bg-zinc-800/30 transition-colors"
      >
        <span className="text-[11px] uppercase tracking-wider font-semibold text-zinc-400">
          {title}
        </span>
        <ChevronDown
          className={clsx(
            "w-3.5 h-3.5 text-zinc-600 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>
      {open && <div className="px-4 pb-4 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function HslSection() {
  const { hsl, setHsl } = useWorkspace();
  const [activeColor, setActiveColor] = useState<HslColor>("red");
  const channel = hsl[activeColor];

  return (
    <Section title="HSL / Color" defaultOpen={false}>
      {/* Color selector pills */}
      <div className="flex flex-wrap gap-1">
        {HSL_COLORS.map(({ key, label, dot }) => (
          <button
            key={key}
            onClick={() => setActiveColor(key)}
            className={clsx(
              "flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border transition-colors",
              activeColor === key
                ? "border-transparent text-white"
                : "border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
            )}
            style={
              activeColor === key
                ? { backgroundColor: dot + "33", borderColor: dot + "66", color: dot }
                : {}
            }
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: dot }} />
            {label}
          </button>
        ))}
      </div>

      <Slider label="Hue" value={channel.hue} min={-100} max={100} onChange={(v) => setHsl(activeColor, "hue", v)} />
      <Slider label="Saturation" value={channel.saturation} min={-100} max={100} onChange={(v) => setHsl(activeColor, "saturation", v)} />
      <Slider label="Luminance" value={channel.luminance} min={-100} max={100} onChange={(v) => setHsl(activeColor, "luminance", v)} />
    </Section>
  );
}

function ToneCurvePlaceholder() {
  return (
    <div className="w-full h-32 bg-zinc-900 rounded border border-zinc-800 flex items-center justify-center">
      <span className="text-[10px] text-zinc-600">Tone curve editor</span>
    </div>
  );
}

function ColorWheelSection({ disabled }: { disabled: boolean }) {
  const { colorWheels, setColorWheel, resetColorWheel } = useWorkspace();
  // Spec section 2.2: "four wheels in a 2×2 grid: Lift (top-left), Gamma (top-right),
  // Gain (bottom-left), Offset (bottom-right)"
  const zones = [
    ["lift",   "Lift"]   as const,
    ["gamma",  "Gamma"]  as const,
    ["gain",   "Gain"]   as const,
    ["offset", "Offset"] as const,
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {zones.map(([zone, label]) => (
        <ColorWheel
          key={zone}
          label={label}
          value={colorWheels[zone]}
          onChange={(v) => setColorWheel(zone, v)}
          onReset={() => resetColorWheel(zone)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

export function AdjustmentPanel() {
  const { adjustments, setAdjustment, resetAdjustments, activeImageId, references } = useWorkspace();
  const disabled = !activeImageId;
  const activeRefs = references.filter((r) => r.weight > 0);

  const adj = (key: keyof AdjustmentState) => ({
    value: adjustments[key],
    onChange: (v: number) => setAdjustment(key, v),
    disabled,
  });

  return (
    <aside className="flex flex-col h-full w-80 shrink-0 border-l border-zinc-800 bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 shrink-0">
        <span className="text-xs font-semibold text-zinc-300">Adjustments</span>
        <button
          onClick={resetAdjustments}
          className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          <RotateCcw className="w-2.5 h-2.5" />
          Reset all
        </button>
      </div>

      {/* Reference-active notice — sliders show base values; canvas adds ref contribution */}
      {activeRefs.length > 0 && (
        <div className="px-4 py-1.5 border-b border-zinc-800/60 bg-chroma-500/5">
          <p className="text-[10px] text-chroma-400/80">
            {activeRefs.length} reference{activeRefs.length !== 1 ? "s" : ""} active
            {" "}· sliders show base values
          </p>
        </div>
      )}

      {/* Scrollable sections */}
      <div className="flex-1 overflow-y-auto">
        <Section title="Basic">
          <Slider label="Exposure"   {...adj("exposure")}   min={-5}   max={5}   step={0.01} />
          <Slider label="Contrast"   {...adj("contrast")}   min={-100} max={100} />
          <Slider label="Highlights" {...adj("highlights")} min={-100} max={100} />
          <Slider label="Shadows"    {...adj("shadows")}    min={-100} max={100} />
          <Slider label="Whites"     {...adj("whites")}     min={-100} max={100} />
          <Slider label="Blacks"     {...adj("blacks")}     min={-100} max={100} />
          <div className="my-1 border-t border-zinc-800/60" />
          <Slider label="Clarity"    {...adj("clarity")}    min={-100} max={100} />
          <Slider label="Vibrance"   {...adj("vibrance")}   min={-100} max={100} />
          <Slider label="Saturation" {...adj("saturation")} min={-100} max={100} />
        </Section>

        <Section title="Color">
          <Slider label="Temperature" {...adj("temperature")} min={2000} max={50000} step={100} unit="K" />
          <Slider label="Tint"        {...adj("tint")}        min={-150} max={150} />
        </Section>

        <Section title="Tone Curve" defaultOpen={false}>
          <ToneCurvePlaceholder />
        </Section>

        <HslSection />

        <Section title="Color Wheels" defaultOpen={false}>
          <ColorWheelSection disabled={disabled} />
        </Section>

        {/* AI override disclosure */}
        <div className="px-4 py-3 border-t border-zinc-800/60">
          <p className="text-[10px] text-zinc-600 leading-relaxed">
            Manual adjustments carry higher authority than AI suggestions.
            Any manual change is treated as a correction signal.
          </p>
        </div>
      </div>
    </aside>
  );
}
