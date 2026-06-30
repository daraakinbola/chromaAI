"use client";

import { useCallback, useRef } from "react";
import { X, Upload, AlertTriangle, ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import { useState } from "react";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { MoodboardImage, VisionAnalystOutput, MoodboardConsensus } from "@/types";

// ─── Stage labels ─────────────────────────────────────────────────────────────

const STAGE_LABEL: Record<string, string> = {
  vision:      "Looking at your images...",
  synthesizer: "Finding the common thread...",
  creative:    "Writing your creative brief...",
};

// ─── Agreement bar (color-coded) ─────────────────────────────────────────────

function AgreementBar({ label, score }: { label: string; score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 75 ? "bg-emerald-500" :
    pct >= 50 ? "bg-amber-500"   :
                "bg-rose-500";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-zinc-500 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={clsx("h-full rounded-full transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-mono text-zinc-500 w-7 text-right">{pct}%</span>
    </div>
  );
}

// ─── Per-image vision row ─────────────────────────────────────────────────────

function VisionRow({
  image,
  analysis,
  index,
}: {
  image: MoodboardImage;
  analysis: VisionAnalystOutput;
  index: number;
}) {
  return (
    <div className="flex gap-2.5 py-2 border-b border-zinc-800/60 last:border-b-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image.thumbnailDataUrl}
        alt={image.filename}
        className="w-14 h-10 object-cover rounded shrink-0"
        draggable={false}
      />
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-zinc-600">#{index + 1}</span>
          <span className="text-[9px] text-zinc-600 truncate">{image.filename}</span>
          <span className="text-[9px] text-zinc-700 ml-auto shrink-0">
            {Math.round(analysis.confidence * 100)}% conf
          </span>
        </div>
        <p className="text-[10px] text-zinc-400 leading-relaxed line-clamp-2">
          {analysis.description}
        </p>
        <p className="text-[9px] text-zinc-600 truncate">{analysis.technicalCharacter}</p>
      </div>
    </div>
  );
}

// ─── Expandable "How we got here" section ────────────────────────────────────

function HowWeGotHere({
  images,
  visionAnalysis,
  consensus,
}: {
  images: MoodboardImage[];
  visionAnalysis: VisionAnalystOutput[];
  consensus: MoodboardConsensus;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between w-full px-3 py-2 hover:bg-zinc-800/40 transition-colors"
      >
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
          How we got here
        </span>
        <ChevronDown
          className={clsx(
            "w-3 h-3 text-zinc-600 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          {/* Per-image vision descriptions */}
          <div>
            <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1.5">
              Vision analysis — per image
            </p>
            <div>
              {images.map((img, i) => (
                <VisionRow
                  key={img.id}
                  image={img}
                  analysis={visionAnalysis[i]}
                  index={i}
                />
              ))}
            </div>
          </div>

          {/* Statistical agreement bars */}
          <div>
            <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-2">
              Statistical agreement
            </p>
            <div className="flex flex-col gap-1.5">
              <AgreementBar label="Overall"     score={consensus.overall_agreement_score} />
              <AgreementBar label="Temperature" score={consensus.averageTemperature.agreement_score} />
              <AgreementBar label="Saturation"  score={consensus.averageSaturation.agreement_score} />
              <AgreementBar label="Contrast"    score={consensus.contrastRatio.agreement_score} />
              <AgreementBar label="Tone curve"  score={consensus.toneCurveShapeAgreement} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Thumbnail grid with remove buttons ──────────────────────────────────────

function ThumbnailGrid({ images }: { images: MoodboardImage[] }) {
  const { removeMoodboardImage } = useWorkspace();

  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((img) => (
        <div key={img.id} className="relative group w-16 h-11 rounded overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.thumbnailDataUrl}
            alt={img.filename}
            className="absolute inset-0 w-full h-full object-cover"
            draggable={false}
          />
          <button
            onClick={() => removeMoodboardImage(img.id)}
            className="absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center rounded-full bg-black/75 text-zinc-300 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
            title="Remove"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Drop zone ───────────────────────────────────────────────────────────────

function DropZone({ imageCount }: { imageCount: number }) {
  const { addMoodboardImage, addToast } = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files) return;
      const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (!imageFiles.length) return;

      const remaining = 10 - imageCount;
      const toAdd = imageFiles.slice(0, remaining);

      await Promise.all(
        toAdd.map((f) =>
          addMoodboardImage(f).catch(() =>
            addToast({ type: "error", message: `Could not load moodboard image: ${f.name}` })
          )
        )
      );
    },
    [addMoodboardImage, addToast, imageCount]
  );

  if (imageCount >= 10) return null;

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={clsx(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed cursor-pointer transition-colors py-4",
        dragging
          ? "border-chroma-500 bg-chroma-500/5"
          : "border-zinc-700 hover:border-zinc-600 hover:bg-zinc-800/20"
      )}
    >
      <Upload className="w-4 h-4 text-zinc-600" />
      <p className="text-[10px] text-zinc-500">
        {imageCount === 0
          ? "Drop moodboard images here"
          : `Add more images (${imageCount}/10)`}
      </p>
      <p className="text-[9px] text-zinc-700">Minimum 2 · Maximum 10</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export function MoodboardPanel() {
  const {
    moodboardImages,
    moodboardResult,
    moodboardStage,
    moodboardError,
  } = useWorkspace();

  const isRunning = moodboardStage === "vision" || moodboardStage === "synthesizer" || moodboardStage === "creative";
  const result = moodboardResult;
  const t = result?.processingTimeMs;

  return (
    <div className="w-64 shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-zinc-800 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider font-semibold text-zinc-400">
            Moodboard
          </span>
          <span className="text-[9px] text-zinc-700">
            {moodboardImages.length}/10 images
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-3 p-3">
        {/* Thumbnail grid */}
        {moodboardImages.length > 0 && <ThumbnailGrid images={moodboardImages} />}

        {/* Drop zone */}
        <DropZone imageCount={moodboardImages.length} />

        {/* Need-more-images hint */}
        {moodboardImages.length === 1 && (
          <p className="text-[10px] text-zinc-600 text-center">
            Add one more image to start analysis
          </p>
        )}

        {/* Loading state */}
        {isRunning && (
          <div className="flex flex-col items-center gap-2 py-4">
            <div className="flex gap-1">
              {(["vision", "synthesizer", "creative"] as const).map((s) => (
                <div
                  key={s}
                  className={clsx(
                    "w-1.5 h-1.5 rounded-full transition-all duration-300",
                    moodboardStage === s
                      ? "bg-chroma-400 scale-125"
                      : "bg-zinc-700"
                  )}
                />
              ))}
            </div>
            <p className="text-[10px] text-zinc-500 text-center">
              {STAGE_LABEL[moodboardStage]}
            </p>
          </div>
        )}

        {/* Error state */}
        {moodboardStage === "error" && moodboardError && (
          <div className="rounded-lg border border-rose-800/50 bg-rose-950/30 px-3 py-2">
            <p className="text-[10px] text-rose-400">{moodboardError}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="flex flex-col gap-3">
            {/* Creative brief — headline */}
            <div className="rounded-lg bg-zinc-900/60 border border-zinc-800 p-3">
              <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1.5">
                Creative brief
              </p>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                {result.creativeDirection.creativeBrief}
              </p>
              <p className="text-[10px] text-zinc-600 mt-1.5 leading-relaxed">
                {result.creativeDirection.confidenceAssessment}
              </p>
            </div>

            {/* Recommended weight chip */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-zinc-600">Recommended weight</span>
              <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-chroma-500 rounded-full"
                  style={{ width: `${Math.round(result.creativeDirection.recommendedWeight * 100)}%` }}
                />
              </div>
              <span className="text-[9px] font-mono text-zinc-500">
                {Math.round(result.creativeDirection.recommendedWeight * 100)}%
              </span>
            </div>

            {/* Flagged tensions callout — only when non-empty */}
            {result.creativeDirection.flaggedTensions.length > 0 && (
              <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-3 flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
                  <span className="text-[9px] uppercase tracking-wider text-amber-600 font-semibold">
                    Worth knowing
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  {result.creativeDirection.flaggedTensions.map((t, i) => (
                    <li key={i} className="text-[10px] text-amber-400/80 leading-relaxed">
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Expandable "How we got here" */}
            <HowWeGotHere
              images={moodboardImages}
              visionAnalysis={result.visionAnalysis}
              consensus={result.statisticalConsensus}
            />

            {/* Processing time debug footer */}
            {t && (
              <div className="text-[9px] font-mono text-zinc-700 leading-relaxed border-t border-zinc-800/60 pt-2">
                <p>Vision analyst: {Math.round(t.visionAnalyst)}ms</p>
                <p>Stat synthesizer: {Math.round(t.statisticalSynthesizer)}ms (concurrent)</p>
                <p>Creative director: {Math.round(t.creativeDirector)}ms</p>
                <p>Total: {Math.round(t.visionAnalyst + t.creativeDirector)}ms</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
