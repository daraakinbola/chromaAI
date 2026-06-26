import type { AdjustmentState } from "@/types";

// Spec Section 3.2 Option A — maps AdjustmentState to CSS filter string.
// Limitations (documented in spec): no highlights/shadows/whites/blacks/clarity/tint.
// Temperature: sepia approximation for warming only; cooling has no clean CSS equivalent.

export function buildCssFilter(adj: AdjustmentState): string {
  const parts: string[] = [];

  // Exposure: brightness = 2^exposure (spec exact formula)
  const brightness = Math.pow(2, adj.exposure);
  if (Math.abs(brightness - 1) > 0.001) {
    parts.push(`brightness(${brightness.toFixed(4)})`);
  }

  // Contrast: linear mapping around neutral
  const contrast = Math.max(0, (adj.contrast + 100) / 100);
  if (Math.abs(contrast - 1) > 0.001) {
    parts.push(`contrast(${contrast.toFixed(4)})`);
  }

  // Saturation: linear mapping
  const saturate = Math.max(0, (adj.saturation + 100) / 100);
  if (Math.abs(saturate - 1) > 0.001) {
    parts.push(`saturate(${saturate.toFixed(4)})`);
  }

  // Temperature: sepia approximates warmth for temp < 5500K (default neutral).
  // Above 5500K (cooling) has no CSS equivalent — V1 limitation.
  if (adj.temperature < 5500) {
    const warmth = (5500 - adj.temperature) / 3500; // 0–1 as temp goes 5500→2000
    const sepia = Math.min(0.5, warmth * 0.5);
    if (sepia > 0.01) parts.push(`sepia(${sepia.toFixed(3)})`);
  }

  return parts.length > 0 ? parts.join(" ") : "none";
}
