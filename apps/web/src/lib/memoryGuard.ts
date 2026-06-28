import type { ImageRecord } from "@/types";

// PRD §5.5: memory usage must stay under 2 GB for a session with 50 images.
// Warn when the in-memory estimate exceeds 75% of that limit.
const WARNING_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Estimates the in-memory footprint of the image session.
 * JS strings are UTF-16 (2 bytes/char), but base64 data URLs are ASCII-only
 * so we treat each character as 1 byte — a slight underestimate that is fast
 * to compute and accurate enough for a threshold guard.
 */
export function estimateSessionBytes(images: ImageRecord[]): number {
  return images.reduce((sum, img) => {
    return (
      sum +
      (img.originalDataUrl?.length ?? 0) +
      (img.thumbnailDataUrl?.length ?? 0)
    );
  }, 0);
}

export function formatSessionSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** True when the session is approaching the 2 GB memory ceiling. */
export function isApproachingMemoryLimit(images: ImageRecord[]): boolean {
  return estimateSessionBytes(images) > WARNING_BYTES;
}
