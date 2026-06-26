import type { AdjustmentState, ImageRecord } from "@/types";

// Scale each adjustment field to a comparable -100..100 range before computing L2 norm
function normalizedValues(adj: AdjustmentState): number[] {
  return [
    adj.exposure * 20,          // -5..5 → -100..100
    adj.contrast,
    adj.highlights,
    adj.shadows,
    adj.whites,
    adj.blacks,
    adj.clarity,
    adj.vibrance,
    adj.saturation,
    (adj.temperature - 5500) / 150,  // centered at default, practical range ≈ ±20
    adj.tint * (2 / 3),              // -150..150 → -100..100
  ];
}

export function computeFingerprint(adj: AdjustmentState): number {
  const vals = normalizedValues(adj);
  return Math.sqrt(vals.reduce((sum, v) => sum + v * v, 0));
}

export interface ConsistencyResult {
  batchScore: number;
  perImageScores: Record<string, number>;
  autoFlagged: Set<string>;
}

const FLAG_STDDEV_THRESHOLD = 2;

export function computeBatchConsistency(images: ImageRecord[]): ConsistencyResult {
  if (images.length === 0) {
    return { batchScore: 100, perImageScores: {}, autoFlagged: new Set() };
  }
  if (images.length === 1) {
    return {
      batchScore: 100,
      perImageScores: { [images[0].id]: 100 },
      autoFlagged: new Set(),
    };
  }

  const entries = images.map((img) => ({ id: img.id, fp: computeFingerprint(img.adjustments) }));
  const fps = entries.map((e) => e.fp);
  const mean = fps.reduce((s, v) => s + v, 0) / fps.length;

  // All images at near-default settings — perfectly consistent
  if (mean < 0.01) {
    const perImageScores: Record<string, number> = {};
    for (const e of entries) perImageScores[e.id] = 100;
    return { batchScore: 100, perImageScores, autoFlagged: new Set() };
  }

  const variance = fps.reduce((s, v) => s + (v - mean) ** 2, 0) / fps.length;
  const stddev = Math.sqrt(variance);

  const batchScore = Math.max(0, Math.round(100 - (stddev / mean) * 100));

  const perImageScores: Record<string, number> = {};
  const autoFlagged = new Set<string>();

  for (const { id, fp } of entries) {
    const deviation = Math.abs(fp - mean) / mean;
    perImageScores[id] = Math.max(0, Math.round(100 - deviation * 100));
    if (stddev > 0 && Math.abs(fp - mean) > FLAG_STDDEV_THRESHOLD * stddev) {
      autoFlagged.add(id);
    }
  }

  return { batchScore, perImageScores, autoFlagged };
}
