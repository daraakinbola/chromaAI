"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  AdjustmentState,
  HslAdjustments,
  ImageRecord,
  PromptEntry,
  ReferenceImage,
  SessionGenre,
  SessionRecord,
  ToastItem,
  ViewMode,
  defaultAdjustmentState,
  defaultHslAdjustments,
} from "@/types";
import { api } from "@/lib/api";
import { importFiles } from "@/lib/imageImport";
import { importReference as doImportReference } from "@/lib/referenceExtract";
import { deleteExpiredSessions, getSession, saveSession } from "@/lib/sessionDb";

const MAX_REFERENCES = 3;

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
  setReferenceAttribute: (id: string, attr: keyof ReferenceImage["activeAttributes"], value: boolean) => void;
  addToast: (toast: Omit<ToastItem, "id">) => void;
  dismissToast: (id: string) => void;
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
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);

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

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeImage = images.find((i) => i.id === activeImageId);
  const adjustments = activeImage?.adjustments ?? defaultAdjustmentState;

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
              ? { ...img, adjustments: { ...img.adjustments, ...response.suggested_adjustments } }
              : img
          )
        );
      }
    } catch (err) {
      setPromptError(err instanceof Error ? err.message : "Failed to process prompt");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const dismissInterpretation = () => setLastInterpretation(null);

  // ── References ────────────────────────────────────────────────────────────

  const importReference = async (file: File) => {
    if (references.length >= MAX_REFERENCES) {
      addToast({ type: "error", message: `Maximum ${MAX_REFERENCES} reference images allowed.` });
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
        r.id === id ? { ...r, activeAttributes: { ...r.activeAttributes, [attr]: value } } : r
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
