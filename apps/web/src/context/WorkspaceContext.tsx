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
  HslAdjustments,
  ImageRecord,
  PromptEntry,
  ReferenceImage,
  SceneAnalysis,
  SessionGenre,
  SessionRecord,
  ToastItem,
  ViewMode,
  defaultAdjustmentState,
  defaultHslAdjustments,
} from "@/types";
import { api } from "@/lib/api";
import { importFiles } from "@/lib/imageImport";
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
  toasts: ToastItem[];
  batchConsistencyScore: number;
  isApplyingGrade: boolean;
  /** Base + all active reference contributions — what the canvas and export render. */
  effectiveAdjustments: AdjustmentState;
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
  setViewMode: (mode: ViewMode) => void;
  submitPrompt: (text: string) => Promise<void>;
  dismissInterpretation: () => void;
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
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [batchConsistencyScore, setBatchConsistencyScore] = useState(100);
  const [isApplyingGrade, setIsApplyingGrade] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeImage = images.find((i) => i.id === activeImageId);
  const adjustments = activeImage?.adjustments ?? defaultAdjustmentState;

  // Spec Section 4.5: base + all active reference contributions.
  // Reactive: recomputes whenever references or the active image's base adjustments change.
  const effectiveAdjustments = useMemo(
    () => applyReferencesToAdjustments(adjustments, references),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adjustments, references]
  );

  // ── Session restore on mount ───────────────────────────────────────────────

  useEffect(() => {
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
        thumbnailDataUrl: images[0]?.thumbnailDataUrl ?? null,
      };
      saveSession(record).catch(console.error);
    }, 500);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [
    images, activeImageId, references, promptHistory, hsl,
    sessionGenre, sessionBrief, sessionRestored, sessionId,
    sessionCreatedAt,
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
      setImages((prev) => {
        const updated = [...prev, ...records];
        if (!activeImageId) {
          setActiveImageId(records[0].id);
        }
        return updated;
      });
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
        applied: !response.requires_clarification,
      };

      setAiConfidence(response.confidence);
      setLastInterpretation(response.interpretation);
      setPromptHistory((prev) => [entry, ...prev]);

      if (response.requires_clarification) {
        setClarificationQuestion(response.clarification_question);
      } else if (activeImageId) {
        setImages((prev) =>
          prev.map((img) =>
            img.id === activeImageId
              ? {
                  ...img,
                  adjustments: { ...img.adjustments, ...response.suggested_adjustments },
                }
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
        toasts,
        batchConsistencyScore,
        isApplyingGrade,
        effectiveAdjustments,
        importImages,
        selectImage,
        setSessionGenre,
        setAdjustment,
        resetAdjustments,
        setHsl,
        setViewMode,
        submitPrompt,
        dismissInterpretation,
        importReference,
        removeReference,
        setReferenceWeight,
        setReferenceAttribute,
        addToast,
        dismissToast,
        applyGradeToAll,
        unflagImage,
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
