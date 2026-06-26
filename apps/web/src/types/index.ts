// ─── Spec-canonical interfaces (Section 2.3 of Phase 2 TechSpec) ────────────

export interface AdjustmentState {
  exposure: number;     // -5.0 to +5.0, default 0
  contrast: number;     // -100 to +100, default 0
  highlights: number;   // -100 to +100, default 0
  shadows: number;      // -100 to +100, default 0
  whites: number;       // -100 to +100, default 0
  blacks: number;       // -100 to +100, default 0
  clarity: number;      // -100 to +100, default 0
  vibrance: number;     // -100 to +100, default 0
  saturation: number;   // -100 to +100, default 0
  temperature: number;  // 2000 to 50000 Kelvin, default 5500
  tint: number;         // -150 to +150, default 0
}

export interface ImageRecord {
  id: string;              // uuid generated on import
  filename: string;        // original filename
  mimeType: string;        // detected mime type
  originalDataUrl: string; // base64 data URL of unmodified original — never mutated
  thumbnailDataUrl: string; // 200x133px thumbnail data URL
  width: number;           // original pixel width
  height: number;          // original pixel height
  importedAt: number;      // timestamp
  adjustments: AdjustmentState; // current adjustment values
  consistencyScore: number; // 0-100, defaults to 100 on import
  flagged: boolean;        // manually flagged by user
}

// Backward-compat alias — existing code can keep using Adjustments
export type Adjustments = AdjustmentState;

export const defaultAdjustmentState: AdjustmentState = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  clarity: 0,
  vibrance: 0,
  saturation: 0,
  temperature: 5500,
  tint: 0,
};

export const defaultAdjustments = defaultAdjustmentState;

// ─── HSL (not in spec AdjustmentState — kept as separate workspace state) ───

export interface HslChannel {
  hue: number;        // -100 to +100
  saturation: number; // -100 to +100
  luminance: number;  // -100 to +100
}

export type HslColor = "red" | "orange" | "yellow" | "green" | "aqua" | "blue" | "purple" | "magenta";

export type HslAdjustments = Record<HslColor, HslChannel>;

export const defaultHslAdjustments: HslAdjustments = {
  red:     { hue: 0, saturation: 0, luminance: 0 },
  orange:  { hue: 0, saturation: 0, luminance: 0 },
  yellow:  { hue: 0, saturation: 0, luminance: 0 },
  green:   { hue: 0, saturation: 0, luminance: 0 },
  aqua:    { hue: 0, saturation: 0, luminance: 0 },
  blue:    { hue: 0, saturation: 0, luminance: 0 },
  purple:  { hue: 0, saturation: 0, luminance: 0 },
  magenta: { hue: 0, saturation: 0, luminance: 0 },
};

// ─── Prompt ─────────────────────────────────────────────────────────────────

export interface PromptEntry {
  id: string;
  text: string;
  timestamp: number;
  confidence: number; // 0-1
  applied: boolean;
}

// Mirrors PromptSubmitRequest in apps/api/models/schemas.py
export interface PromptSubmitRequest {
  image_id: string;
  text: string;
  session_genre?: SessionGenre | null;
  session_brief?: string | null;
  current_adjustments?: AdjustmentState | null;
}

// Mirrors PromptSubmitResponse in apps/api/models/schemas.py
export interface PromptSubmitResponse {
  interpretation: string;
  suggested_adjustments: AdjustmentState;
  confidence: number;
  flagged_ambiguity: string | null;
  requires_clarification: boolean;
  clarification_question: string | null;
}

// ─── Reference images (Section 4.3 of Phase 2 TechSpec) ─────────────────────

export interface ColorProfile {
  averageTemperature: number;                      // estimated Kelvin
  averageSaturation: number;                       // 0.0 to 1.0
  contrastRatio: number;                           // shadow/highlight luminance ratio
  shadowHue: [number, number, number];             // avg RGB of bottom 20% luminance
  highlightHue: [number, number, number];          // avg RGB of top 20% luminance
  midtoneHue: [number, number, number];            // avg RGB of middle 60% luminance
  exposureBias: number;                            // estimated EV relative to neutral
  toneCurveShape: "flat" | "lifted_blacks" | "crushed_blacks" | "high_contrast" | "low_contrast";
}

export interface ReferenceImage {
  id: string;
  filename: string;
  thumbnailDataUrl: string;                        // 120x80px display thumbnail
  extractedProfile: ColorProfile;
  weight: number;                                  // 0.0 to 1.0, default 1.0
  activeAttributes: {
    toneCurve: boolean;
    colorTemperature: boolean;
    saturation: boolean;
    contrast: boolean;
    shadowColor: boolean;
    highlightColor: boolean;
  };
}

// ─── Misc ────────────────────────────────────────────────────────────────────

export type ViewMode = "single" | "before-after" | "split";

export type SessionGenre =
  | "portrait"
  | "landscape"
  | "documentary"
  | "fashion"
  | "narrative-film"
  | "product"
  | "wedding"
  | "social";

export interface ToastItem {
  id: string;
  type: "error" | "info" | "success";
  message: string;
}

// ─── Batch processing (Section 6 of Phase 2 TechSpec) ────────────────────────

export interface ImageStats {
  luminance: number;
  colorTemperature: number;
}

export interface BatchAdaptTarget {
  image_id: string;
  luminance: number;
  colorTemperature: number;
}

export interface BatchAdaptRequest {
  source_adjustments: AdjustmentState;
  source_stats: ImageStats;
  targets: BatchAdaptTarget[];
}

export interface AdjustmentDelta {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  clarity: number;
  vibrance: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export interface ImageAdjustmentResult {
  image_id: string;
  delta: AdjustmentDelta;
}

export interface BatchAdaptResponse {
  adjustments: ImageAdjustmentResult[];
}

// ─── Session persistence (Section 7 of Phase 2 TechSpec) ─────────────────────

export interface SessionRecord {
  id: string;
  genre: SessionGenre | null;
  brief: string;
  createdAt: number;
  updatedAt: number;
  images: ImageRecord[];
  activeImageId: string | null;
  references: ReferenceImage[];
  promptHistory: PromptEntry[];
  hsl: HslAdjustments;
  thumbnailDataUrl: string | null;
}
