"use client";

import { useState, useRef, KeyboardEvent, DragEvent } from "react";
import { Send, Loader2, History, ImagePlus, X, Sparkles, AlertCircle, HelpCircle } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";

function ConfidenceDot({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 80 ? "bg-emerald-400" : pct >= 60 ? "bg-amber-400" : "bg-red-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className={clsx("w-1.5 h-1.5 rounded-full", color)} />
      <span className="text-[10px] font-mono text-zinc-500">{pct}% confidence</span>
    </div>
  );
}

const ACCEPTED_REF_TYPES = "image/jpeg,image/png,image/webp,image/tiff,.jpg,.jpeg,.png,.webp,.tif,.tiff";

export function PromptBar() {
  const {
    submitPrompt,
    promptHistory,
    isAnalyzing,
    aiConfidence,
    references,
    importReference,
    lastInterpretation,
    clarificationQuestion,
    promptError,
    dismissInterpretation,
  } = useWorkspace();
  const [text, setText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || isAnalyzing) return;
    setText("");
    await submitPrompt(trimmed);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const applyHistoryEntry = (t: string) => {
    setText(t);
    setShowHistory(false);
    inputRef.current?.focus();
  };

  const handleDragOver = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("image/")
    );
    files.forEach((f) => importReference(f));
  };

  const handleRefFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach((f) => importReference(f));
    e.target.value = "";
  };

  return (
    <footer
      className={clsx(
        "border-t border-zinc-800 bg-zinc-950 shrink-0 transition-colors",
        isDragOver && "bg-chroma-500/5 border-chroma-500/40"
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input for reference images */}
      <input
        ref={refFileInputRef}
        type="file"
        accept={ACCEPTED_REF_TYPES}
        multiple
        className="hidden"
        onChange={handleRefFileChange}
      />
      {/* History dropdown */}
      {showHistory && promptHistory.length > 0 && (
        <div className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm px-4 py-2 max-h-40 overflow-y-auto">
          <p className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">Prompt history</p>
          <div className="flex flex-col gap-1">
            {promptHistory.map((entry) => (
              <button
                key={entry.id}
                onClick={() => applyHistoryEntry(entry.text)}
                className="flex items-start justify-between gap-3 text-left px-2 py-1.5 rounded hover:bg-zinc-800 transition-colors group"
              >
                <span className="text-xs text-zinc-400 group-hover:text-zinc-200 flex-1 truncate">
                  {entry.text}
                </span>
                <ConfidenceDot confidence={entry.confidence} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* AI interpretation banner */}
      {lastInterpretation && !isAnalyzing && (
        <div className="flex items-start gap-2 mx-4 mt-2.5 px-3 py-2 rounded-lg bg-chroma-500/8 border border-chroma-500/20">
          <Sparkles className="w-3.5 h-3.5 text-chroma-400 shrink-0 mt-0.5" />
          <p className="flex-1 text-[11px] text-zinc-400 leading-relaxed">
            <span className="text-chroma-400 font-medium">Interpreted as: </span>
            {lastInterpretation}
          </p>
          <button
            onClick={dismissInterpretation}
            className="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Clarification question — inline below input */}
      {clarificationQuestion && !isAnalyzing && (
        <div className="flex items-start gap-2 mx-4 mt-2.5 px-3 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20">
          <HelpCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[11px] text-amber-300 leading-relaxed">
            {clarificationQuestion}
          </p>
        </div>
      )}

      {/* Error banner */}
      {promptError && (
        <div className="flex items-start gap-2 mx-4 mt-2.5 px-3 py-2 rounded-lg bg-red-500/8 border border-red-500/20">
          <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
          <p className="flex-1 text-[11px] text-red-400 leading-relaxed">{promptError}</p>
        </div>
      )}

      {/* Drag-over hint */}
      {isDragOver && (
        <div className="mx-4 mt-2 px-3 py-2 rounded-lg border border-dashed border-chroma-500/50 text-center">
          <p className="text-xs text-chroma-400">Drop to add reference image</p>
        </div>
      )}

      {/* Main prompt row */}
      <div className="flex items-end gap-3 px-4 py-3">
        {/* Prompt input */}
        <div className="flex-1 relative">
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKey}
            placeholder={
              clarificationQuestion
                ? "Answer the question above…"
                : "Describe your creative intent… \"warm golden hour, slightly overexposed, like early Wong Kar-wai\""
            }
            rows={1}
            disabled={isAnalyzing}
            className={clsx(
              "w-full resize-none bg-zinc-900 border rounded-lg px-3 py-2.5",
              "text-sm text-zinc-200 placeholder:text-zinc-600",
              "focus:outline-none focus:ring-1 transition-colors leading-5 min-h-[40px] max-h-24",
              clarificationQuestion
                ? "border-amber-500/40 focus:border-amber-500/60 focus:ring-amber-500/20"
                : "border-zinc-700 focus:border-chroma-500/60 focus:ring-chroma-500/20",
              isAnalyzing && "opacity-60"
            )}
            style={{ overflowY: "auto", scrollbarWidth: "none" }}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0 pb-0.5">
          <button
            title={references.length >= 3 ? "Maximum 3 references" : "Add reference image"}
            disabled={references.length >= 3}
            onClick={() => refFileInputRef.current?.click()}
            className={clsx(
              "p-2 rounded-lg transition-colors relative",
              references.length >= 3
                ? "text-zinc-700 cursor-not-allowed"
                : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
            )}
          >
            <ImagePlus className="w-4 h-4" />
            {references.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-chroma-600 text-[8px] text-white font-bold">
                {references.length}
              </span>
            )}
          </button>
          <button
            title="Prompt history"
            onClick={() => setShowHistory((s) => !s)}
            className={clsx(
              "p-2 rounded-lg transition-colors",
              showHistory
                ? "text-chroma-400 bg-chroma-500/10"
                : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800"
            )}
          >
            <History className="w-4 h-4" />
          </button>
          <button
            onClick={handleSubmit}
            disabled={!text.trim() || isAnalyzing}
            className={clsx(
              "flex items-center justify-center w-9 h-9 rounded-lg transition-colors",
              text.trim() && !isAnalyzing
                ? "bg-chroma-600 hover:bg-chroma-500 text-white"
                : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
            )}
          >
            {isAnalyzing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 pb-2 text-[10px] text-zinc-600">
        <span>⏎ send · ⇧⏎ newline</span>
        <div className="flex items-center gap-3">
          {aiConfidence > 0 && !isAnalyzing && <ConfidenceDot confidence={aiConfidence} />}
          {isAnalyzing && (
            <span className="text-chroma-400 animate-pulse">Analyzing scene…</span>
          )}
        </div>
      </div>
    </footer>
  );
}
