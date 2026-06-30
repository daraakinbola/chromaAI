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

// Mirrors SceneAnalysis in apps/api/models/schemas.py
export interface SceneAnalysis {
  subject: string;
  lighting_condition: string;
  has_skin_tones: boolean;
  mood_baseline: string;
  color_temperature_estimate: number;
  confidence: number;
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
  /** undefined = not yet triggered; null = in-flight; SceneAnalysis = complete */
  sceneAnalysis?: SceneAnalysis | null;
  // ── RAW file fields (Phase 3 Section 3) ──────────────────────────────
  isRaw?: boolean;
  rawMetadata?: { cameraTemperature: number };
  highlightRecovery: number; // 0-100, RAW highlight rolloff recovery
  shadowRecovery: number;    // 0-100, RAW shadow lift
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

// ─── Tone Curve (Phase 3 PRD Section 1) ─────────────────────────────────────

export interface ParametricCurve {
  highlights: number; // -100 to +100
  lights:     number;
  darks:      number;
  shadows:    number;
}

export type CurveChannel = "composite" | "red" | "green" | "blue";

export interface ToneCurve {
  channel:    CurveChannel;
  points:     Array<[number, number]>; // [input, output] pairs 0-255
  mode:       "point" | "parametric";
  parametric: ParametricCurve;
}

export interface CurveState {
  composite:     ToneCurve;
  red:           ToneCurve;
  green:         ToneCurve;
  blue:          ToneCurve;
  activeChannel: CurveChannel;
}

function _identityCurve(channel: CurveChannel): ToneCurve {
  return {
    channel,
    points:     [[0, 0], [255, 255]],
    mode:       "point",
    parametric: { highlights: 0, lights: 0, darks: 0, shadows: 0 },
  };
}

/** Returns a fresh identity ToneCurve for the given channel. */
export function identityToneCurve(channel: CurveChannel): ToneCurve {
  return _identityCurve(channel);
}

export const defaultCurveState: CurveState = {
  composite: _identityCurve("composite"),
  red:       _identityCurve("red"),
  green:     _identityCurve("green"),
  blue:      _identityCurve("blue"),
  activeChannel: "composite",
};

// ─── Color Wheels — Lift / Gamma / Gain ─────────────────────────────────────

export interface WheelState {
  hue: number;        // 0–360 ° (0 = top/12-o'clock = red, clockwise)
  saturation: number; // 0–1  (0 = centre = no colour shift)
  luminance: number;  // −1 … +1 (zone luminance offset)
}

export interface ColorWheelState {
  lift:   WheelState;  // shadows zone
  gamma:  WheelState;  // midtones zone
  gain:   WheelState;  // highlights zone
  offset: WheelState;  // global (all zones equally) — spec section 2.1
}

export const defaultColorWheelState: ColorWheelState = {
  lift:   { hue: 0, saturation: 0, luminance: 0 },
  gamma:  { hue: 0, saturation: 0, luminance: 0 },
  gain:   { hue: 0, saturation: 0, luminance: 0 },
  offset: { hue: 0, saturation: 0, luminance: 0 },
};

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

export interface PromptVariation {
  label: string;
  interpretation: string;
  adjustments: AdjustmentState;
}

// Mirrors PromptSubmitResponse in apps/api/models/schemas.py
export interface PromptSubmitResponse {
  interpretation: string;
  suggested_adjustments: AdjustmentState;
  confidence: number;
  flagged_ambiguity: string | null;
  requires_clarification: boolean;
  clarification_question: string | null;
  variations: PromptVariation[] | null;
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

// ─── Masks / Local Adjustments (Phase 3 PRD Section 4) ──────────────────────

export type MaskType = "subject" | "sky" | "background" | "luminance" | "color" | "brush";

export interface LuminanceMaskParams {
  min: number; // 0-255
  max: number; // 0-255
}

export interface ColorMaskParams {
  hue: number;      // 0-360 center hue
  hueRange: number; // ±degrees around center hue
  satMin: number;   // 0.0-1.0 minimum saturation threshold
}

export interface Mask {
  id: string;
  type: MaskType;
  /** Grayscale PNG as data URL. Null while API mask is loading. */
  maskPng: string | null;
  maskWidth: number;
  maskHeight: number;
  inverted: boolean;
  featherRadius: number;
  adjustments: AdjustmentState;
  visible: boolean;
  luminanceParams?: LuminanceMaskParams;
  colorParams?: ColorMaskParams;
  isLoading: boolean;
}

export interface LocalAdjustmentLayer {
  id: string;
  name: string;
  type: MaskType;
  mask: Mask | null;
  adjustments: AdjustmentState;
  opacity: number;  // 0.0 to 1.0
  visible: boolean;
}

// ─── Moodboard pipeline (Phase 4) ────────────────────────────────────────────

export interface VisionAnalystOutput {
  description: string;
  technicalCharacter: string;
  styleReferences: string[];
  confidence: number;
}

export interface DimensionConsensus {
  value: number;
  agreement_score: number;
  outlier_image_indices: number[];
}

export interface MoodboardConsensus {
  averageTemperature: DimensionConsensus;
  averageSaturation: DimensionConsensus;
  contrastRatio: DimensionConsensus;
  exposureBias: DimensionConsensus;
  shadowHue: [DimensionConsensus, DimensionConsensus, DimensionConsensus];
  midtoneHue: [DimensionConsensus, DimensionConsensus, DimensionConsensus];
  highlightHue: [DimensionConsensus, DimensionConsensus, DimensionConsensus];
  toneCurveShape: string;
  toneCurveShapeAgreement: number;
  overall_agreement_score: number;
  outlier_image_indices: number[];
}

export interface CreativeDirectorOutput {
  creativeBrief: string;
  confidenceAssessment: string;
  recommendedWeight: number;
  flaggedTensions: string[];
}

export interface MoodboardProcessingTimes {
  visionAnalyst: number;
  statisticalSynthesizer: number;
  creativeDirector: number;
}

export interface MoodboardPipelineResult {
  visionAnalysis: VisionAnalystOutput[];
  statisticalConsensus: MoodboardConsensus;
  creativeDirection: CreativeDirectorOutput;
  processingTimeMs: MoodboardProcessingTimes;
}

export interface MoodboardImage {
  id: string;
  filename: string;
  thumbnailDataUrl: string;
  originalDataUrl: string;
  colorProfile: ColorProfile;
}

export type MoodboardStage = "idle" | "vision" | "synthesizer" | "creative" | "done" | "error";

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
  colorWheels: ColorWheelState;
  curves: CurveState;
  localLayers: LocalAdjustmentLayer[];
  thumbnailDataUrl: string | null;
}
