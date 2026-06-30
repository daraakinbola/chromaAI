"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AdjustmentState,
  ColorWheelState,
  CurveChannel,
  CurveState,
  HslAdjustments,
  ImageRecord,
  LocalAdjustmentLayer,
  LuminanceMaskParams,
  ColorMaskParams,
  Mask,
  MaskType,
  MoodboardImage,
  MoodboardPipelineResult,
  MoodboardStage,
  PromptEntry,
  ReferenceImage,
  SceneAnalysis,
  SessionGenre,
  SessionRecord,
  ToastItem,
  ToneCurve,
  ViewMode,
  WheelState,
  defaultAdjustmentState,
  defaultColorWheelState,
  defaultCurveState,
  defaultHslAdjustments,
  identityToneCurve,
} from "@/types";
import { api } from "@/lib/api";
import { importFiles } from "@/lib/imageImport";
import {
  getMaskResolution,
  getImagePixelData,
  generateLuminanceMask,
  generateColorRangeMask,
  maskToPng,
  pngToMask,
  gaussianBlurMask,
  invertMask,
  createEmptyMaskPng,
} from "@/lib/maskUtils";
import { getMaskWorker, getImageWorker } from "@/lib/workerBridge";
import { detectWebGPU } from "@/lib/webglRenderer";
import { estimateSessionBytes, formatSessionSize, isApproachingMemoryLimit } from "@/lib/memoryGuard";
import { applyReferencesToAdjustments, importReference as doImportReference } from "@/lib/referenceExtract";
import { deleteExpiredSessions, getSession, saveSession } from "@/lib/sessionDb";
import { computeBatchConsistency } from "@/lib/consistencyEngine";
import { analyzeImageStats } from "@/lib/imageAnalysis";

const MAX_REFERENCES = 3;

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}

interface WorkspaceState {
  images: ImageRecord[];
  activeImageId: string | null;
  isImporting: boolean;
  importProgress: { current: number; total: number } | null;
  adjustments: AdjustmentState;
  hsl: HslAdjustments;
  colorWheels: ColorWheelState;
  curveState: CurveState;
  sessionGenre: SessionGenre | null;
  sessionBrief: string;
  sessionRestored: boolean;
  viewMode: ViewMode;
  promptHistory: PromptEntry[];
  references: ReferenceImage[];
  aiConfidence: number;
  isAnalyzing: boolean;
  lastInterpretation: string | null;
  clarificationQuestion: string | null;
  promptError: string | null;
  pendingVariations: import("@/types").PromptVariation[] | null;
  toasts: ToastItem[];
  batchConsistencyScore: number;
  isApplyingGrade: boolean;
  /** Base + all active reference contributions — what the canvas and export render. */
  effectiveAdjustments: AdjustmentState;
  /** Targeted Adjustment Tool */
  tatActive: boolean;
  tatLuminance: number | null;
  /** RAW recovery — per active image, 0-100 */
  highlightRecovery: number;
  shadowRecovery: number;
  activeImageIsRaw: boolean;
  /** Local adjustment layers (Phase 3 PRD Section 4) */
  localLayers: LocalAdjustmentLayer[];
  activeBrushLayerId: string | null;
  brushSize: number;
  brushHardness: number;
  /** Moodboard pipeline (Phase 4) */
  moodboardImages: MoodboardImage[];
  moodboardResult: MoodboardPipelineResult | null;
  moodboardStage: MoodboardStage;
  moodboardError: string | null;
}

interface WorkspaceActions {
  importImages: (files: File[]) => Promise<void>;
  selectImage: (id: string) => void;
  setSessionGenre: (genre: SessionGenre) => void;
  setAdjustment: (key: keyof AdjustmentState, value: number) => void;
  resetAdjustments: () => void;
  setHsl: (
    color: keyof HslAdjustments,
    channel: keyof HslAdjustments[keyof HslAdjustments],
    value: number
  ) => void;
  setColorWheel: (zone: keyof ColorWheelState, value: WheelState) => void;
  resetColorWheel: (zone: keyof ColorWheelState) => void;
  setCurve: (channel: CurveChannel, curve: ToneCurve) => void;
  setCurveActiveChannel: (channel: CurveChannel) => void;
  resetCurve: (channel: CurveChannel) => void;
  resetAllCurves: () => void;
  setTatActive: (v: boolean) => void;
  setTatLuminance: (v: number | null) => void;
  setHighlightRecovery: (v: number) => void;
  setShadowRecovery: (v: number) => void;
  setViewMode: (mode: ViewMode) => void;
  submitPrompt: (text: string) => Promise<void>;
  dismissInterpretation: () => void;
  selectVariation: (variation: import("@/types").PromptVariation) => void;
  dismissVariations: () => void;
  importReference: (file: File) => Promise<void>;
  removeReference: (id: string) => void;
  setReferenceWeight: (id: string, weight: number) => void;
  setReferenceAttribute: (
    id: string,
    attr: keyof ReferenceImage["activeAttributes"],
    value: boolean
  ) => void;
  addToast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: string) => void;
  applyGradeToAll: (sourceImageId: string) => Promise<void>;
  unflagImage: (id: string) => void;
  addLocalLayer: (type: MaskType, imageDataUrl: string, imageWidth: number, imageHeight: number) => Promise<void>;
  removeLocalLayer: (id: string) => void;
  setLayerAdjustment: (layerId: string, key: keyof AdjustmentState, value: number) => void;
  setLayerOpacity: (layerId: string, opacity: number) => void;
  toggleLayerVisibility: (layerId: string) => void;
  setLayerInverted: (layerId: string, inverted: boolean) => void;
  setLayerFeather: (layerId: string, radius: number) => void;
  updateLayerLuminanceParams: (layerId: string, params: LuminanceMaskParams) => Promise<void>;
  updateLayerColorParams: (layerId: string, params: ColorMaskParams) => Promise<void>;
  commitBrushMask: (layerId: string, maskPng: string) => void;
  setActiveBrushLayer: (layerId: string | null) => void;
  setBrushSize: (size: number) => void;
  setBrushHardness: (hardness: number) => void;
  sampleColorFromImage: (imageDataUrl: string, x: number, y: number, imageWidth: number, imageHeight: number) => Promise<number>;
  addMoodboardImage: (file: File) => Promise<void>;
  removeMoodboardImage: (id: string) => void;
  applyMoodboard: () => Promise<void>;
}

const WorkspaceContext = createContext<(WorkspaceState & WorkspaceActions) | null>(null);

interface WorkspaceProviderProps {
  children: React.ReactNode;
  sessionId: string;
}

export function WorkspaceProvider({ children, sessionId }: WorkspaceProviderProps) {
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const [hsl, setHslState] = useState<HslAdjustments>(defaultHslAdjustments);
  const [colorWheels, setColorWheelsState] = useState<ColorWheelState>(defaultColorWheelState);
  const [curveState, setCurveState] = useState<CurveState>(defaultCurveState);
  const [localLayers, setLocalLayers] = useState<LocalAdjustmentLayer[]>([]);
  const [activeBrushLayerId, setActiveBrushLayerId] = useState<string | null>(null);
  const [brushSize, setBrushSizeState] = useState(40);
  const [brushHardness, setBrushHardnessState] = useState(0.5);
  const [tatActive, setTatActiveState] = useState(false);
  const [tatLuminance, setTatLuminanceState] = useState<number | null>(null);
  const [sessionGenre, setSessionGenreState] = useState<SessionGenre | null>(null);
  const [sessionBrief, setSessionBrief] = useState("");
  const [sessionCreatedAt, setSessionCreatedAt] = useState(Date.now());
  const [sessionRestored, setSessionRestored] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [promptHistory, setPromptHistory] = useState<PromptEntry[]>([]);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [aiConfidence, setAiConfidence] = useState<number>(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastInterpretation, setLastInterpretation] = useState<string | null>(null);
  const [clarificationQuestion, setClarificationQuestion] = useState<string | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [pendingVariations, setPendingVariations] = useState<import("@/types").PromptVariation[] | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [batchConsistencyScore, setBatchConsistencyScore] = useState(100);
  const [isApplyingGrade, setIsApplyingGrade] = useState(false);

  const [moodboardImages, setMoodboardImages] = useState<MoodboardImage[]>([]);
  const [moodboardResult, setMoodboardResult] = useState<MoodboardPipelineResult | null>(null);
  const [moodboardStage, setMoodboardStage] = useState<MoodboardStage>("idle");
  const [moodboardError, setMoodboardError] = useState<string | null>(null);
  const moodboardStageTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const moodboardRunIdRef = useRef(0);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeImage = images.find((i) => i.id === activeImageId);
  const adjustments = activeImage?.adjustments ?? defaultAdjustmentState;
  const highlightRecovery = activeImage?.highlightRecovery ?? 0;
  const shadowRecovery = activeImage?.shadowRecovery ?? 0;
  const activeImageIsRaw = activeImage?.isRaw ?? false;

  // Spec Section 4.5: base + all active reference contributions.
  // Reactive: recomputes whenever references or the active image's base adjustments change.
  const effectiveAdjustments = useMemo(
    () => applyReferencesToAdjustments(adjustments, references),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adjustments, references]
  );

  // ── Session restore on mount ───────────────────────────────────────────────

  useEffect(() => {
    // PRD §5.5: log a console.warn if WebGPU is available so developers know
    // we're using WebGL instead. No user-visible error (acceptance criterion).
    detectWebGPU();

    if (!sessionId) {
      setSessionRestored(true);
      return;
    }

    deleteExpiredSessions().catch(console.error);

    getSession(sessionId)
      .then((record) => {
        if (record) {
          setImages(record.images);
          setActiveImageId(record.activeImageId);
          setHslState(record.hsl);
          if (record.colorWheels) setColorWheelsState(record.colorWheels);
          if (record.curves) setCurveState(record.curves);
          if (record.localLayers) setLocalLayers(record.localLayers);
          setSessionGenreState(record.genre);
          setSessionBrief(record.brief);
          setReferences(record.references);
          setPromptHistory(record.promptHistory);
          setSessionCreatedAt(record.createdAt);
        }
      })
      .catch(console.error)
      .finally(() => setSessionRestored(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Batch consistency engine (Section 6.2 + 6.4) ─────────────────────────
  // Recompute only when adjustment fingerprints actually change, not when
  // consistencyScore/flagged are updated, to avoid an infinite loop.

  const adjustmentHash = useMemo(
    () => images.map((img) => {
      const a = img.adjustments;
      return [a.exposure, a.contrast, a.highlights, a.shadows, a.whites,
              a.blacks, a.clarity, a.vibrance, a.saturation, a.temperature, a.tint]
        .map((v) => v.toFixed(2)).join(",");
    }).join("|"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [images]
  );

  useEffect(() => {
    if (!sessionRestored) return;

    if (images.length < 2) {
      setBatchConsistencyScore(100);
      if (images.length === 1) {
        setImages((prev) =>
          prev.map((img) => ({ ...img, consistencyScore: 100, flagged: false }))
        );
      }
      return;
    }

    const { batchScore, perImageScores, autoFlagged } = computeBatchConsistency(images);
    setBatchConsistencyScore(batchScore);

    setImages((prev) =>
      prev.map((img) => ({
        ...img,
        consistencyScore: perImageScores[img.id] ?? img.consistencyScore,
        flagged: autoFlagged.has(img.id),
      }))
    );
  // adjustmentHash drives recalculation; sessionRestored gates it
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjustmentHash, sessionRestored]);

  // ── Scene analysis — trigger on image select (Gap 2) ─────────────────────
  // Fires when activeImageId changes (and session has been restored).
  // undefined = not yet triggered, null = in-flight, SceneAnalysis = done.
  // Silently ignored when the API is unavailable.

  useEffect(() => {
    if (!activeImageId || !sessionRestored) return;
    const img = images.find((i) => i.id === activeImageId);
    // Skip if analysis already triggered (null) or complete (object)
    if (!img || img.sceneAnalysis !== undefined) return;

    // Mark as in-flight
    setImages((prev) =>
      prev.map((i) => (i.id === activeImageId ? { ...i, sceneAnalysis: null } : i))
    );

    api.grade.analyzeData(img.thumbnailDataUrl, sessionGenre)
      .then((analysis: SceneAnalysis) => {
        setImages((prev) =>
          prev.map((i) => (i.id === activeImageId ? { ...i, sceneAnalysis: analysis } : i))
        );
      })
      .catch(() => {
        // Reset to undefined so next selection can retry
        setImages((prev) =>
          prev.map((i) => (i.id === activeImageId ? { ...i, sceneAnalysis: undefined } : i))
        );
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImageId, sessionRestored]);

  // ── Auto-save: debounced 500ms after any state change ─────────────────────

  useEffect(() => {
    if (!sessionRestored || !sessionId) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);

    saveTimerRef.current = setTimeout(() => {
      const record: SessionRecord = {
        id: sessionId,
        genre: sessionGenre,
        brief: sessionBrief,
        createdAt: sessionCreatedAt,
        updatedAt: Date.now(),
        images,
        activeImageId,
        references,
        promptHistory,
        hsl,
        colorWheels,
        curves: curveState,
        localLayers,
        thumbnailDataUrl: images[0]?.thumbnailDataUrl ?? null,
      };
      saveSession(record).catch(console.error);
    }, 500);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [
    images, activeImageId, references, promptHistory, hsl, colorWheels, curveState,
    localLayers, sessionGenre, sessionBrief, sessionRestored, sessionId, sessionCreatedAt,
  ]);

  // ── Toast helpers ─────────────────────────────────────────────────────────

  const addToast = (toast: Omit<ToastItem, "id">) => {
    setToasts((prev) => [...prev, { ...toast, id: crypto.randomUUID() }]);
  };

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // ── Image import ──────────────────────────────────────────────────────────

  const importImages = async (files: File[]) => {
    if (!files.length) return;
    setIsImporting(true);
    setImportProgress({ current: 0, total: files.length });

    const records = await importFiles(
      files,
      (current, total) => setImportProgress({ current, total }),
      (filename, message) =>
        addToast({ type: "error", message: `${filename}: ${message}` })
    );

    if (records.length) {
      // Snapshot current images so we can estimate post-import memory size
      // before the React state flush (images captured from the enclosing closure).
      const projectedImages = [...images, ...records];

      setImages((prev) => {
        const updated = [...prev, ...records];
        if (!activeImageId) {
          setActiveImageId(records[0].id);
        }
        return updated;
      });

      // PRD §5.5: warn when approaching the 2 GB in-memory limit.
      if (isApproachingMemoryLimit(projectedImages)) {
        addToast({
          type: "info",
          message: `Session size is ~${formatSessionSize(estimateSessionBytes(projectedImages))}. Consider removing unused images to stay under the 2 GB limit.`,
        });
      }

      // Fire-and-forget: regenerate thumbnails in parallel via imageWorker (PRD Section 5.2).
      // The sync thumbnail from importFiles is already visible; the worker version overwrites
      // it in the background without blocking the import completion.
      const imageWorker = getImageWorker();
      if (imageWorker) {
        Promise.all(
          records.map(async (rec) => {
            try {
              const thumb = await imageWorker.generateThumbnail(rec.originalDataUrl);
              setImages((prev) =>
                prev.map((img) => img.id === rec.id ? { ...img, thumbnailDataUrl: thumb } : img)
              );
            } catch {
              // keep the sync thumbnail on worker failure
            }
          })
        );
      }
    }

    setIsImporting(false);
    setImportProgress(null);
  };

  // ── Image / adjustment actions ────────────────────────────────────────────

  const selectImage = (id: string) => setActiveImageId(id);
  const setSessionGenre = (genre: SessionGenre) => setSessionGenreState(genre);

  const setAdjustment = (key: keyof AdjustmentState, value: number) => {
    if (!activeImageId) return;
    setImages((prev) =>
      prev.map((img) =>
        img.id === activeImageId
          ? { ...img, adjustments: { ...img.adjustments, [key]: value } }
          : img
      )
    );
  };

  const resetAdjustments = () => {
    if (!activeImageId) return;
    setImages((prev) =>
      prev.map((img) =>
        img.id === activeImageId
          ? { ...img, adjustments: { ...defaultAdjustmentState } }
          : img
      )
    );
  };

  const setHsl = (
    color: keyof HslAdjustments,
    channel: keyof HslAdjustments[keyof HslAdjustments],
    value: number
  ) => {
    setHslState((prev) => ({
      ...prev,
      [color]: { ...prev[color], [channel]: value },
    }));
  };

  const setColorWheel = (zone: keyof ColorWheelState, value: WheelState) => {
    setColorWheelsState((prev) => ({ ...prev, [zone]: value }));
  };

  const resetColorWheel = (zone: keyof ColorWheelState) => {
    setColorWheelsState((prev) => ({
      ...prev,
      [zone]: { hue: 0, saturation: 0, luminance: 0 },
    }));
  };

  // ── Tone curve actions ────────────────────────────────────────────────────

  const setCurve = (channel: CurveChannel, curve: ToneCurve) => {
    setCurveState((prev) => ({ ...prev, [channel]: curve }));
  };

  const setCurveActiveChannel = (channel: CurveChannel) => {
    setCurveState((prev) => ({ ...prev, activeChannel: channel }));
  };

  const resetCurve = (channel: CurveChannel) => {
    setCurveState((prev) => ({ ...prev, [channel]: identityToneCurve(channel) }));
  };

  const resetAllCurves = () => {
    setCurveState(defaultCurveState);
  };

  const setTatActive = (v: boolean) => setTatActiveState(v);
  const setTatLuminance = (v: number | null) => setTatLuminanceState(v);

  const setHighlightRecovery = (v: number) => {
    if (!activeImageId) return;
    setImages((prev) =>
      prev.map((img) => img.id === activeImageId ? { ...img, highlightRecovery: v } : img)
    );
  };

  const setShadowRecovery = (v: number) => {
    if (!activeImageId) return;
    setImages((prev) =>
      prev.map((img) => img.id === activeImageId ? { ...img, shadowRecovery: v } : img)
    );
  };

  // ── Local adjustment layer actions (Phase 3 PRD Section 4) ───────────────

  const _defaultLayerAdj: AdjustmentState = { ...defaultAdjustmentState };

  async function _buildMask(
    type: MaskType,
    imageDataUrl: string,
    imageWidth: number,
    imageHeight: number,
    lumParams?: LuminanceMaskParams,
    colorParams?: ColorMaskParams,
  ): Promise<{ maskPng: string; maskWidth: number; maskHeight: number }> {
    const { w, h } = getMaskResolution(imageWidth, imageHeight);
    if (type === "luminance") {
      const params = lumParams ?? { min: 0, max: 255 };
      const worker = getMaskWorker();
      if (worker) {
        const maskPng = await worker.generateLuminanceMaskPng(imageDataUrl, w, h, params, 0, false);
        return { maskPng, maskWidth: w, maskHeight: h };
      }
      // Fallback: main-thread generation
      const pixels = await getImagePixelData(imageDataUrl, w, h);
      const mask = generateLuminanceMask(pixels, params.min, params.max);
      return { maskPng: maskToPng(mask, w, h), maskWidth: w, maskHeight: h };
    }
    if (type === "color") {
      const params = colorParams ?? { hue: 0, hueRange: 30, satMin: 0.15 };
      const worker = getMaskWorker();
      if (worker) {
        const maskPng = await worker.generateColorRangeMaskPng(imageDataUrl, w, h, params, 0, false);
        return { maskPng, maskWidth: w, maskHeight: h };
      }
      // Fallback: main-thread generation
      const pixels = await getImagePixelData(imageDataUrl, w, h);
      const mask = generateColorRangeMask(pixels, params.hue, params.hueRange, params.satMin);
      return { maskPng: maskToPng(mask, w, h), maskWidth: w, maskHeight: h };
    }
    if (type === "brush") {
      return { maskPng: createEmptyMaskPng(w, h), maskWidth: w, maskHeight: h };
    }
    // subject / sky / background — try @xenova/transformers in maskWorker first
    // (client-side, no network latency after first model download, PRD §7).
    // Fall back to the FastAPI segmentation endpoint if the worker is unavailable
    // or the model fails to load.
    const segWorker = getMaskWorker();
    if (segWorker) {
      try {
        const maskPng = await segWorker.generateSegmentationMaskPng(
          imageDataUrl, w, h, type as "subject" | "sky" | "background", 0, false,
        );
        return { maskPng, maskWidth: w, maskHeight: h };
      } catch (workerErr) {
        console.warn("[ChromaAI] Worker segmentation failed, falling back to API:", workerErr);
      }
    }
    const apiMethod = type === "subject" ? api.masks.subject
      : type === "sky" ? api.masks.sky
      : api.masks.background;
    const res = await apiMethod(imageDataUrl);
    return { maskPng: res.mask_png, maskWidth: res.width, maskHeight: res.height };
  }

  const addLocalLayer = async (
    type: MaskType,
    imageDataUrl: string,
    imageWidth: number,
    imageHeight: number,
  ) => {
    const id = crypto.randomUUID();
    const name = type === "subject" ? "Subject" : type === "sky" ? "Sky"
      : type === "background" ? "Background" : type === "luminance" ? "Luminance Range"
      : type === "color" ? "Color Range" : "Brush";

    const { w, h } = getMaskResolution(imageWidth, imageHeight);
    const defaultLumParams: LuminanceMaskParams = { min: 128, max: 255 };
    const defaultColorParams: ColorMaskParams = { hue: 0, hueRange: 30, satMin: 0.15 };

    // Insert layer immediately with isLoading=true for API types
    const maskBase: Mask = {
      id: crypto.randomUUID(),
      type,
      maskPng: type === "brush" ? createEmptyMaskPng(w, h) : null,
      maskWidth: w,
      maskHeight: h,
      inverted: false,
      featherRadius: 0,
      adjustments: { ..._defaultLayerAdj },
      visible: true,
      isLoading: type !== "brush" && type !== "luminance" && type !== "color",
      luminanceParams: defaultLumParams,
      colorParams: defaultColorParams,
    };
    const newLayer: LocalAdjustmentLayer = {
      id, name, type, mask: maskBase,
      adjustments: { ..._defaultLayerAdj },
      opacity: 1,
      visible: true,
    };
    setLocalLayers((prev) => [...prev, newLayer]);
    if (type === "brush") {
      setActiveBrushLayerId(id);
      return;
    }

    // Generate / fetch mask
    try {
      const { maskPng, maskWidth, maskHeight } = await _buildMask(
        type, imageDataUrl, imageWidth, imageHeight, defaultLumParams, defaultColorParams,
      );
      setLocalLayers((prev) => prev.map((l) =>
        l.id !== id ? l : {
          ...l,
          mask: l.mask ? {
            ...l.mask,
            maskPng,
            maskWidth,
            maskHeight,
            isLoading: false,
          } : null,
        }
      ));
    } catch (err) {
      addToast({ type: "error", message: `Mask generation failed: ${err instanceof Error ? err.message : String(err)}` });
      setLocalLayers((prev) => prev.map((l) =>
        l.id !== id ? l : { ...l, mask: l.mask ? { ...l.mask, isLoading: false } : null }
      ));
    }
  };

  const removeLocalLayer = (id: string) => {
    setLocalLayers((prev) => prev.filter((l) => l.id !== id));
    if (activeBrushLayerId === id) setActiveBrushLayerId(null);
  };

  const setLayerAdjustment = (layerId: string, key: keyof AdjustmentState, value: number) => {
    setLocalLayers((prev) =>
      prev.map((l) => l.id === layerId ? { ...l, adjustments: { ...l.adjustments, [key]: value } } : l)
    );
  };

  const setLayerOpacity = (layerId: string, opacity: number) => {
    setLocalLayers((prev) => prev.map((l) => l.id === layerId ? { ...l, opacity } : l));
  };

  const toggleLayerVisibility = (layerId: string) => {
    setLocalLayers((prev) =>
      prev.map((l) => l.id === layerId ? { ...l, visible: !l.visible } : l)
    );
  };

  const setLayerInverted = (layerId: string, inverted: boolean) => {
    setLocalLayers((prev) =>
      prev.map((l) => {
        if (l.id !== layerId || !l.mask) return l;
        return { ...l, mask: { ...l.mask, inverted } };
      })
    );
  };

  const setLayerFeather = (layerId: string, radius: number) => {
    setLocalLayers((prev) =>
      prev.map((l) => {
        if (l.id !== layerId || !l.mask) return l;
        return { ...l, mask: { ...l.mask, featherRadius: radius } };
      })
    );
  };

  const updateLayerLuminanceParams = async (layerId: string, params: LuminanceMaskParams) => {
    const layer = localLayers.find((l) => l.id === layerId);
    if (!layer?.mask || !activeImage) return;
    const { w, h } = getMaskResolution(activeImage.width, activeImage.height);
    const { featherRadius, inverted } = layer.mask;

    const worker = getMaskWorker();
    let maskPng: string;
    if (worker) {
      maskPng = await worker.generateLuminanceMaskPng(
        activeImage.originalDataUrl, w, h, params, featherRadius, inverted,
      );
    } else {
      const pixels = await getImagePixelData(activeImage.originalDataUrl, w, h);
      let mask = generateLuminanceMask(pixels, params.min, params.max);
      if (featherRadius > 0) mask = gaussianBlurMask(mask, w, h, featherRadius);
      if (inverted) mask = invertMask(mask);
      maskPng = maskToPng(mask, w, h);
    }

    setLocalLayers((prev) =>
      prev.map((l) =>
        l.id !== layerId || !l.mask ? l
          : { ...l, mask: { ...l.mask, maskPng, maskWidth: w, maskHeight: h, luminanceParams: params } }
      )
    );
  };

  const updateLayerColorParams = async (layerId: string, params: ColorMaskParams) => {
    const layer = localLayers.find((l) => l.id === layerId);
    if (!layer?.mask || !activeImage) return;
    const { w, h } = getMaskResolution(activeImage.width, activeImage.height);
    const { featherRadius, inverted } = layer.mask;

    const worker = getMaskWorker();
    let maskPng: string;
    if (worker) {
      maskPng = await worker.generateColorRangeMaskPng(
        activeImage.originalDataUrl, w, h, params, featherRadius, inverted,
      );
    } else {
      const pixels = await getImagePixelData(activeImage.originalDataUrl, w, h);
      let mask = generateColorRangeMask(pixels, params.hue, params.hueRange, params.satMin);
      if (featherRadius > 0) mask = gaussianBlurMask(mask, w, h, featherRadius);
      if (inverted) mask = invertMask(mask);
      maskPng = maskToPng(mask, w, h);
    }

    setLocalLayers((prev) =>
      prev.map((l) =>
        l.id !== layerId || !l.mask ? l
          : { ...l, mask: { ...l.mask, maskPng, maskWidth: w, maskHeight: h, colorParams: params } }
      )
    );
  };

  const commitBrushMask = (layerId: string, maskPng: string) => {
    setLocalLayers((prev) =>
      prev.map((l) =>
        l.id !== layerId || !l.mask ? l : { ...l, mask: { ...l.mask, maskPng } }
      )
    );
  };

  const setActiveBrushLayer = (layerId: string | null) => setActiveBrushLayerId(layerId);
  const setBrushSize = (size: number) => setBrushSizeState(size);
  const setBrushHardness = (hardness: number) => setBrushHardnessState(hardness);

  const sampleColorFromImage = async (
    imageDataUrl: string, x: number, y: number, imageWidth: number, imageHeight: number,
  ): Promise<number> => {
    const { w, h } = getMaskResolution(imageWidth, imageHeight);
    const sx = (x / imageWidth) * w, sy = (y / imageHeight) * h;
    const pixels = await getImagePixelData(imageDataUrl, w, h);
    const { sampleHue } = await import("@/lib/maskUtils");
    return sampleHue(pixels, sx, sy);
  };

  // ── Batch: apply grade to all (Section 6.3) ───────────────────────────────

  const applyGradeToAll = async (sourceImageId: string) => {
    const sourceImage = images.find((img) => img.id === sourceImageId);
    if (!sourceImage) return;

    const targets = images.filter((img) => img.id !== sourceImageId);
    if (!targets.length) return;

    setIsApplyingGrade(true);
    try {
      // Client-side analysis: get luminance + color temp for source and each target
      const sourceStats = await analyzeImageStats(sourceImage.originalDataUrl);
      const targetStats = await Promise.all(
        targets.map(async (img) => ({
          image_id: img.id,
          ...(await analyzeImageStats(img.originalDataUrl)),
        }))
      );

      // Call adaptation API
      const result = await api.batch.adaptGrade({
        source_adjustments: sourceImage.adjustments,
        source_stats: sourceStats,
        targets: targetStats,
      });

      const deltaMap = new Map(result.adjustments.map((a) => [a.image_id, a.delta]));

      setImages((prev) =>
        prev.map((img) => {
          if (img.id === sourceImageId) return img;
          const d = deltaMap.get(img.id);
          const src = sourceImage.adjustments;
          const dExp = d?.exposure ?? 0;
          const dTemp = d?.temperature ?? 0;
          return {
            ...img,
            adjustments: {
              exposure: clamp(src.exposure + dExp, -5, 5),
              contrast: clamp(src.contrast + (d?.contrast ?? 0), -100, 100),
              highlights: clamp(src.highlights + (d?.highlights ?? 0), -100, 100),
              shadows: clamp(src.shadows + (d?.shadows ?? 0), -100, 100),
              whites: clamp(src.whites + (d?.whites ?? 0), -100, 100),
              blacks: clamp(src.blacks + (d?.blacks ?? 0), -100, 100),
              clarity: clamp(src.clarity + (d?.clarity ?? 0), -100, 100),
              vibrance: clamp(src.vibrance + (d?.vibrance ?? 0), -100, 100),
              saturation: clamp(src.saturation + (d?.saturation ?? 0), -100, 100),
              temperature: clamp(src.temperature + dTemp, 2000, 50000),
              tint: clamp(src.tint + (d?.tint ?? 0), -150, 150),
            },
          };
        })
      );

      addToast({
        type: "success",
        message: `Grade applied to ${targets.length} image${targets.length !== 1 ? "s" : ""}`,
      });
    } catch (err) {
      addToast({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to apply grade",
      });
    } finally {
      setIsApplyingGrade(false);
    }
  };

  // ── Batch: unflag (Section 6.4) ───────────────────────────────────────────

  const unflagImage = (id: string) => {
    setImages((prev) =>
      prev.map((img) => (img.id === id ? { ...img, flagged: false } : img))
    );
  };

  // ── Prompt ────────────────────────────────────────────────────────────────

  const submitPrompt = async (text: string) => {
    setIsAnalyzing(true);
    setPromptError(null);
    setClarificationQuestion(null);
    setPendingVariations(null);

    try {
      const response = await api.prompt.submit({
        image_id: activeImageId ?? "none",
        text,
        session_genre: sessionGenre,
        session_brief: sessionBrief || null,
        current_adjustments: adjustments,
      });

      const entry: PromptEntry = {
        id: crypto.randomUUID(),
        text,
        timestamp: Date.now(),
        confidence: response.confidence,
        applied: !response.requires_clarification && !response.variations?.length,
      };

      setAiConfidence(response.confidence);
      setLastInterpretation(response.interpretation);
      setPromptHistory((prev) => [entry, ...prev]);

      if (response.variations?.length) {
        setPendingVariations(response.variations);
      } else if (response.requires_clarification) {
        setClarificationQuestion(response.clarification_question);
      } else if (activeImageId) {
        setImages((prev) =>
          prev.map((img) =>
            img.id === activeImageId
              ? { ...img, adjustments: { ...img.adjustments, ...response.suggested_adjustments } }
              : img
          )
        );
      }
    } catch (err) {
      setPromptError(
        err instanceof Error ? err.message : "Failed to process prompt"
      );
    } finally {
      setIsAnalyzing(false);
    }
  };

  const dismissInterpretation = () => setLastInterpretation(null);

  const selectVariation = (variation: import("@/types").PromptVariation) => {
    if (!activeImageId) return;
    setImages((prev) =>
      prev.map((img) =>
        img.id === activeImageId
          ? { ...img, adjustments: { ...img.adjustments, ...variation.adjustments } }
          : img
      )
    );
    setLastInterpretation(variation.interpretation);
    setPendingVariations(null);
  };

  const dismissVariations = () => setPendingVariations(null);

  // ── Moodboard pipeline (Phase 4) ─────────────────────────────────────────

  const moodboardImageHash = moodboardImages.map((i) => i.id).join(",");

  useEffect(() => {
    if (moodboardImages.length < 2) {
      setMoodboardResult(null);
      setMoodboardStage("idle");
      setMoodboardError(null);
      return;
    }

    const runId = ++moodboardRunIdRef.current;

    // Clear any pending stage-transition timers from a prior run
    moodboardStageTimersRef.current.forEach(clearTimeout);
    moodboardStageTimersRef.current = [];

    setMoodboardError(null);
    setMoodboardResult(null);
    setMoodboardStage("vision");

    // Staged loading animation: simulate the three-stage architecture visually
    // even though the API call is a single round-trip.
    const t1 = setTimeout(() => setMoodboardStage("synthesizer"), 1800);
    const t2 = setTimeout(() => setMoodboardStage("creative"), 3200);
    moodboardStageTimersRef.current = [t1, t2];

    api.moodboard
      .analyze(
        moodboardImages.map((i) => i.originalDataUrl),
        moodboardImages.map((i) => i.colorProfile),
      )
      .then((result) => {
        if (runId !== moodboardRunIdRef.current) return;
        moodboardStageTimersRef.current.forEach(clearTimeout);
        setMoodboardResult(result);
        setMoodboardStage("done");
      })
      .catch((err) => {
        if (runId !== moodboardRunIdRef.current) return;
        moodboardStageTimersRef.current.forEach(clearTimeout);
        setMoodboardError(err instanceof Error ? err.message : "Pipeline failed");
        setMoodboardStage("error");
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moodboardImageHash]);

  const addMoodboardImage = async (file: File) => {
    const { importReference: doImportRef } = await import("@/lib/referenceExtract");

    const [originalDataUrl, ref] = await Promise.all([
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      }),
      doImportRef(file),
    ]);

    const newImage: MoodboardImage = {
      id: crypto.randomUUID(),
      filename: file.name,
      thumbnailDataUrl: ref.thumbnailDataUrl,
      originalDataUrl,
      colorProfile: ref.extractedProfile,
    };

    setMoodboardImages((prev) => {
      if (prev.length >= 10) return prev;
      return [...prev, newImage];
    });
  };

  const removeMoodboardImage = (id: string) => {
    setMoodboardImages((prev) => prev.filter((img) => img.id !== id));
  };

  const applyMoodboard = async () => {
    if (!moodboardResult || !activeImageId) return;
    const currentAdj = images.find((i) => i.id === activeImageId)?.adjustments ?? defaultAdjustmentState;
    try {
      const newAdj = await api.moodboard.apply({
        consensus: moodboardResult.statisticalConsensus,
        recommended_weight: moodboardResult.creativeDirection.recommendedWeight,
        current_adjustments: currentAdj,
      });
      setImages((prev) =>
        prev.map((img) =>
          img.id === activeImageId ? { ...img, adjustments: { ...img.adjustments, ...newAdj } } : img
        )
      );
      const pct = Math.round(moodboardResult.creativeDirection.recommendedWeight * 100);
      addToast({
        type: "success",
        message: `Applied at ${pct}% strength based on board agreement`,
      });
    } catch (err) {
      addToast({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to apply moodboard",
      });
    }
  };

  // ── References ────────────────────────────────────────────────────────────

  const importReference = async (file: File) => {
    if (references.length >= MAX_REFERENCES) {
      addToast({
        type: "error",
        message: `Maximum ${MAX_REFERENCES} reference images allowed.`,
      });
      return;
    }
    try {
      const ref = await doImportReference(file);
      setReferences((prev) => {
        if (prev.length >= MAX_REFERENCES) return prev;
        return [...prev, ref];
      });
    } catch {
      addToast({ type: "error", message: `Could not load reference: ${file.name}` });
    }
  };

  const removeReference = (id: string) =>
    setReferences((prev) => prev.filter((r) => r.id !== id));

  const setReferenceWeight = (id: string, weight: number) =>
    setReferences((prev) =>
      prev.map((r) => (r.id === id ? { ...r, weight } : r))
    );

  const setReferenceAttribute = (
    id: string,
    attr: keyof ReferenceImage["activeAttributes"],
    value: boolean
  ) =>
    setReferences((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, activeAttributes: { ...r.activeAttributes, [attr]: value } }
          : r
      )
    );

  return (
    <WorkspaceContext.Provider
      value={{
        images,
        activeImageId,
        isImporting,
        importProgress,
        adjustments,
        hsl,
        colorWheels,
        curveState,
        sessionGenre,
        sessionBrief,
        sessionRestored,
        viewMode,
        promptHistory,
        references,
        aiConfidence,
        isAnalyzing,
        lastInterpretation,
        clarificationQuestion,
        promptError,
        pendingVariations,
        toasts,
        batchConsistencyScore,
        isApplyingGrade,
        effectiveAdjustments,
        tatActive,
        tatLuminance,
        highlightRecovery,
        shadowRecovery,
        activeImageIsRaw,
        localLayers,
        activeBrushLayerId,
        brushSize,
        brushHardness,
        importImages,
        selectImage,
        setSessionGenre,
        setAdjustment,
        resetAdjustments,
        setHsl,
        setColorWheel,
        resetColorWheel,
        setCurve,
        setCurveActiveChannel,
        resetCurve,
        resetAllCurves,
        setTatActive,
        setTatLuminance,
        setHighlightRecovery,
        setShadowRecovery,
        setViewMode,
        submitPrompt,
        dismissInterpretation,
        selectVariation,
        dismissVariations,
        importReference,
        removeReference,
        setReferenceWeight,
        setReferenceAttribute,
        addToast,
        dismissToast,
        applyGradeToAll,
        unflagImage,
        addLocalLayer,
        removeLocalLayer,
        setLayerAdjustment,
        setLayerOpacity,
        toggleLayerVisibility,
        setLayerInverted,
        setLayerFeather,
        updateLayerLuminanceParams,
        updateLayerColorParams,
        commitBrushMask,
        setActiveBrushLayer,
        setBrushSize,
        setBrushHardness,
        sampleColorFromImage,
        moodboardImages,
        moodboardResult,
        moodboardStage,
        moodboardError,
        addMoodboardImage,
        removeMoodboardImage,
        applyMoodboard,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return ctx;
}
