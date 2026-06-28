"use client";

import { useState } from "react";
import {
  ChevronDown, Eye, EyeOff, Trash2, Plus, User, Cloud, Layers, Sunset,
  Palette, Brush,
} from "lucide-react";
import { clsx } from "clsx";
import { Slider } from "@/components/ui/Slider";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { AdjustmentState, LocalAdjustmentLayer, MaskType, LuminanceMaskParams, ColorMaskParams } from "@/types";

// ─── Icon map ────────────────────────────────────────────────────────────────

const MASK_ICONS: Record<MaskType, React.ReactNode> = {
  subject:    <User className="w-3 h-3" />,
  sky:        <Cloud className="w-3 h-3" />,
  background: <Layers className="w-3 h-3" />,
  luminance:  <Sunset className="w-3 h-3" />,
  color:      <Palette className="w-3 h-3" />,
  brush:      <Brush className="w-3 h-3" />,
};

// ─── Layer adjustment sliders ─────────────────────────────────────────────────

function LayerAdjSliders({ layer }: { layer: LocalAdjustmentLayer }) {
  const { setLayerAdjustment } = useWorkspace();
  const a = (key: keyof AdjustmentState) => ({
    value: layer.adjustments[key],
    onChange: (v: number) => setLayerAdjustment(layer.id, key, v),
  });
  return (
    <div className="flex flex-col gap-2 pt-2">
      <Slider label="Exposure"    {...a("exposure")}    min={-5}    max={5}    step={0.01} />
      <Slider label="Contrast"    {...a("contrast")}    min={-100}  max={100} />
      <Slider label="Highlights"  {...a("highlights")}  min={-100}  max={100} />
      <Slider label="Shadows"     {...a("shadows")}     min={-100}  max={100} />
      <Slider label="Whites"      {...a("whites")}      min={-100}  max={100} />
      <Slider label="Blacks"      {...a("blacks")}      min={-100}  max={100} />
      <div className="border-t border-zinc-800/60 my-0.5" />
      <Slider label="Temperature" {...a("temperature")} min={2000}  max={50000} step={100} unit="K" />
      <Slider label="Tint"        {...a("tint")}        min={-150}  max={150} />
      <Slider label="Saturation"  {...a("saturation")}  min={-100}  max={100} />
      <Slider label="Vibrance"    {...a("vibrance")}    min={-100}  max={100} />
    </div>
  );
}

// ─── Luminance range controls ─────────────────────────────────────────────────

function LuminanceRangeControls({ layer }: { layer: LocalAdjustmentLayer }) {
  const { updateLayerLuminanceParams, images, activeImageId } = useWorkspace();
  const params = layer.mask?.luminanceParams ?? { min: 128, max: 255 };
  const activeImage = images.find((i) => i.id === activeImageId);

  const update = async (next: LuminanceMaskParams) => {
    if (!activeImage) return;
    await updateLayerLuminanceParams(layer.id, next);
  };

  return (
    <div className="flex flex-col gap-2 py-2 border-t border-zinc-800/40">
      <p className="text-[10px] text-zinc-500">Luminance Range (0–255)</p>
      <Slider
        label="Min"
        value={params.min}
        min={0}
        max={params.max - 1}
        onChange={(v) => update({ ...params, min: v })}
      />
      <Slider
        label="Max"
        value={params.max}
        min={params.min + 1}
        max={255}
        onChange={(v) => update({ ...params, max: v })}
      />
      <div className="h-2 rounded-sm" style={{
        background: `linear-gradient(to right, #09090b 0%, #09090b ${(params.min/255)*100}%, white ${(params.min/255)*100}%, white ${(params.max/255)*100}%, #09090b ${(params.max/255)*100}%, #09090b 100%)`
      }} />
    </div>
  );
}

// ─── Color range controls ─────────────────────────────────────────────────────

function ColorRangeControls({ layer }: { layer: LocalAdjustmentLayer }) {
  const { updateLayerColorParams, images, activeImageId } = useWorkspace();
  const params = layer.mask?.colorParams ?? { hue: 0, hueRange: 30, satMin: 0.15 };
  const activeImage = images.find((i) => i.id === activeImageId);

  const update = async (next: ColorMaskParams) => {
    if (!activeImage) return;
    await updateLayerColorParams(layer.id, next);
  };

  const hueGrad = `hsl(${params.hue},100%,50%)`;

  return (
    <div className="flex flex-col gap-2 py-2 border-t border-zinc-800/40">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-500">Color Range</span>
        <div className="w-4 h-4 rounded-full border border-zinc-600 ml-auto shrink-0"
          style={{ background: hueGrad }} />
      </div>
      <Slider label="Hue" value={params.hue} min={0} max={359}
        onChange={(v) => update({ ...params, hue: v })} />
      <Slider label="Hue Range ±°" value={params.hueRange} min={5} max={90}
        onChange={(v) => update({ ...params, hueRange: v })} />
      <Slider label="Sat. Min" value={Math.round(params.satMin * 100)} min={0} max={100}
        onChange={(v) => update({ ...params, satMin: v / 100 })} unit="%" />
    </div>
  );
}

// ─── Brush controls ───────────────────────────────────────────────────────────

function BrushControls({ layer }: { layer: LocalAdjustmentLayer }) {
  const { brushSize, brushHardness, setBrushSize, setBrushHardness, activeBrushLayerId, setActiveBrushLayer } = useWorkspace();
  const isActive = activeBrushLayerId === layer.id;
  return (
    <div className="flex flex-col gap-2 py-2 border-t border-zinc-800/40">
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-zinc-500">Brush Tool</span>
        <button
          onClick={() => setActiveBrushLayer(isActive ? null : layer.id)}
          className={clsx(
            "ml-auto text-[10px] px-2 py-0.5 rounded border transition-colors",
            isActive
              ? "border-chroma-500 text-chroma-400 bg-chroma-500/10"
              : "border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
          )}
        >
          {isActive ? "Painting…" : "Activate"}
        </button>
      </div>
      {isActive && (
        <>
          <p className="text-[10px] text-zinc-600">Paint on canvas · Hold Alt to erase</p>
          <Slider label="Size" value={brushSize} min={1} max={500} onChange={setBrushSize} unit="px" />
          <Slider label="Hardness" value={Math.round(brushHardness * 100)} min={0} max={100}
            onChange={(v) => setBrushHardness(v / 100)} unit="%" />
        </>
      )}
    </div>
  );
}

// ─── Individual layer card ────────────────────────────────────────────────────

function LayerCard({ layer }: { layer: LocalAdjustmentLayer }) {
  const [expanded, setExpanded] = useState(true);
  const { toggleLayerVisibility, removeLocalLayer, setLayerOpacity, setLayerFeather, setLayerInverted } = useWorkspace();

  return (
    <div className="border border-zinc-800/60 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900/40">
        <span className="text-zinc-500">{MASK_ICONS[layer.type]}</span>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex-1 text-left text-[11px] font-medium text-zinc-300 hover:text-zinc-100 transition-colors truncate flex items-center gap-1"
        >
          {layer.name}
          {layer.mask?.isLoading && (
            <span className="text-[9px] text-zinc-600 animate-pulse">Generating…</span>
          )}
          <ChevronDown className={clsx("w-3 h-3 text-zinc-600 ml-auto transition-transform", expanded && "rotate-180")} />
        </button>
        <button
          onClick={() => toggleLayerVisibility(layer.id)}
          className="text-zinc-600 hover:text-zinc-300 transition-colors shrink-0"
          title={layer.visible ? "Hide layer" : "Show layer"}
        >
          {layer.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
        </button>
        <button
          onClick={() => removeLocalLayer(layer.id)}
          className="text-zinc-700 hover:text-red-400 transition-colors shrink-0"
          title="Delete layer"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {/* Body */}
      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          {/* Mask-type-specific controls */}
          {layer.type === "luminance" && <LuminanceRangeControls layer={layer} />}
          {layer.type === "color"     && <ColorRangeControls layer={layer} />}
          {layer.type === "brush"     && <BrushControls layer={layer} />}

          {/* Common controls */}
          <div className="flex flex-col gap-2 border-t border-zinc-800/40 pt-2">
            <Slider label="Opacity" value={Math.round(layer.opacity * 100)} min={0} max={100}
              onChange={(v) => setLayerOpacity(layer.id, v / 100)} unit="%" />
            <Slider label="Feather" value={layer.mask?.featherRadius ?? 0} min={0} max={100}
              onChange={(v) => setLayerFeather(layer.id, v)} unit="px" />
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={layer.mask?.inverted ?? false}
                onChange={(e) => setLayerInverted(layer.id, e.target.checked)}
                className="w-3 h-3 accent-chroma-500"
              />
              <span className="text-[10px] text-zinc-500">Invert mask</span>
            </label>
          </div>

          {/* Adjustment sliders */}
          <LayerAdjSliders layer={layer} />
        </div>
      )}
    </div>
  );
}

// ─── Add-mask dropdown ────────────────────────────────────────────────────────

const ADD_OPTIONS: { type: MaskType; label: string; icon: React.ReactNode }[] = [
  { type: "subject",   label: "Select Subject",       icon: <User className="w-3 h-3" /> },
  { type: "sky",       label: "Select Sky",           icon: <Cloud className="w-3 h-3" /> },
  { type: "background",label: "Select Background",    icon: <Layers className="w-3 h-3" /> },
  { type: "luminance", label: "Luminance Range",      icon: <Sunset className="w-3 h-3" /> },
  { type: "color",     label: "Color Range",          icon: <Palette className="w-3 h-3" /> },
  { type: "brush",     label: "Brush Mask",           icon: <Brush className="w-3 h-3" /> },
];

function AddMaskButton() {
  const [open, setOpen] = useState(false);
  const { addLocalLayer, images, activeImageId } = useWorkspace();
  const activeImage = images.find((i) => i.id === activeImageId);

  const handleAdd = async (type: MaskType) => {
    setOpen(false);
    if (!activeImage) return;
    await addLocalLayer(type, activeImage.originalDataUrl, activeImage.width, activeImage.height);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={!activeImage}
        className={clsx(
          "flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded border transition-colors",
          activeImage
            ? "border-zinc-700 text-zinc-400 hover:border-chroma-600 hover:text-chroma-400 hover:bg-chroma-500/5"
            : "border-zinc-800 text-zinc-700 cursor-not-allowed"
        )}
      >
        <Plus className="w-3 h-3" />
        Add Mask
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-20 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden min-w-[180px]">
            {ADD_OPTIONS.map(({ type, label, icon }) => (
              <button
                key={type}
                onClick={() => handleAdd(type)}
                className="flex items-center gap-2 w-full px-3 py-2 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors text-left"
              >
                <span className="text-zinc-500">{icon}</span>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function LocalAdjustmentsPanel() {
  const { localLayers } = useWorkspace();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500">
          {localLayers.length === 0
            ? "No masks — add one to target regions of the image"
            : `${localLayers.length} mask${localLayers.length !== 1 ? "s" : ""} active`}
        </span>
      </div>

      <AddMaskButton />

      {localLayers.length > 0 && (
        <div className="flex flex-col gap-2">
          {[...localLayers].reverse().map((layer) => (
            <LayerCard key={layer.id} layer={layer} />
          ))}
        </div>
      )}
    </div>
  );
}
