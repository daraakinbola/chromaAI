"use client";

import { X } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { ReferenceImage } from "@/types";

const ATTRIBUTE_LABELS: Record<keyof ReferenceImage["activeAttributes"], string> = {
  toneCurve:        "Tone",
  colorTemperature: "Temp",
  saturation:       "Sat",
  contrast:         "Contrast",
  shadowColor:      "Shadows",
  highlightColor:   "Highlights",
};

// `reference` instead of `ref` — React reserves `ref` as a special prop and
// strips it before the component receives its props, which would leave the card
// empty.
function ReferenceCard({ reference: r }: { reference: ReferenceImage }) {
  const { removeReference, setReferenceWeight, setReferenceAttribute } = useWorkspace();

  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-lg border border-zinc-800 bg-zinc-900/60 shrink-0">
      {/* Thumbnail + remove */}
      <div className="relative w-[120px] h-[80px] rounded overflow-hidden group">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={r.thumbnailDataUrl}
          alt={r.filename}
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
        />
        <button
          onClick={() => removeReference(r.id)}
          title="Remove reference"
          className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-full bg-black/70 border border-zinc-600 text-zinc-300 hover:text-white hover:bg-black transition-colors opacity-0 group-hover:opacity-100"
        >
          <X className="w-3 h-3" />
        </button>
        <div className="absolute bottom-0 inset-x-0 bg-black/60 px-1.5 py-0.5">
          <p className="text-[9px] text-zinc-400 truncate">{r.filename}</p>
        </div>
      </div>

      {/* Weight slider */}
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-[9px] text-zinc-600 shrink-0">Weight</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={r.weight}
          onChange={(e) => setReferenceWeight(r.id, parseFloat(e.target.value))}
          className="flex-1 h-1 accent-chroma-500"
        />
        <span className="text-[9px] font-mono text-zinc-500 w-7 text-right">
          {Math.round(r.weight * 100)}%
        </span>
      </div>

      {/* Attribute toggles */}
      <div className="flex flex-wrap gap-1 px-0.5">
        {(Object.keys(r.activeAttributes) as (keyof ReferenceImage["activeAttributes"])[]).map((attr) => (
          <button
            key={attr}
            onClick={() => setReferenceAttribute(r.id, attr, !r.activeAttributes[attr])}
            className={clsx(
              "text-[9px] px-1.5 py-0.5 rounded border transition-colors",
              r.activeAttributes[attr]
                ? "bg-chroma-500/15 border-chroma-500/40 text-chroma-400"
                : "border-zinc-700 text-zinc-600 hover:border-zinc-600"
            )}
          >
            {ATTRIBUTE_LABELS[attr]}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReferenceStrip() {
  const { references } = useWorkspace();

  if (!references.length) return null;

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-2 shrink-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
          Reference images
        </span>
        <span className="text-[9px] text-zinc-700">{references.length}/3</span>
      </div>
      <div className="flex items-start gap-2 overflow-x-auto pb-0.5">
        {references.map((r) => (
          <ReferenceCard key={r.id} reference={r} />
        ))}
      </div>
    </div>
  );
}
