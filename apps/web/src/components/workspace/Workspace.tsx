"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ImageBrowser } from "./ImageBrowser";
import { Canvas } from "./Canvas";
import { AdjustmentPanel } from "./AdjustmentPanel";
import { MoodboardPanel } from "./MoodboardPanel";
import { PromptBar } from "./PromptBar";
import { ReferenceStrip } from "./ReferenceStrip";
import { WorkspaceProvider } from "@/context/WorkspaceContext";
import { ToastStack } from "@/components/ui/Toast";
import { ExportModal } from "@/components/ui/ExportModal";
import { Layers, Settings, HelpCircle, Palette } from "lucide-react";

type RightPanel = "adjust" | "moodboard";

function Header({
  onExport,
  rightPanel,
  setRightPanel,
}: {
  onExport: () => void;
  rightPanel: RightPanel;
  setRightPanel: (p: RightPanel) => void;
}) {
  return (
    <header className="flex items-center justify-between px-4 h-11 border-b border-zinc-800 bg-zinc-950 shrink-0 z-10">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #7c3aed 0%, #4c1d95 100%)" }}
          >
            <span className="text-[9px] font-bold text-white tracking-tight">CA</span>
          </div>
          <span className="text-sm font-semibold text-zinc-200 tracking-tight">
            Chroma<span className="text-chroma-400">AI</span>
          </span>
        </div>

        <div className="h-4 w-px bg-zinc-800" />

        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Layers className="w-3 h-3" />
          <span>Portrait session</span>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-600">sRGB · Web</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Right-panel toggle */}
        <div className="flex items-center rounded border border-zinc-800 overflow-hidden text-[10px]">
          <button
            onClick={() => setRightPanel("adjust")}
            className={`px-2.5 py-1 transition-colors ${
              rightPanel === "adjust"
                ? "bg-zinc-800 text-zinc-200"
                : "text-zinc-600 hover:text-zinc-400"
            }`}
          >
            Adjust
          </button>
          <button
            onClick={() => setRightPanel("moodboard")}
            className={`flex items-center gap-1 px-2.5 py-1 transition-colors ${
              rightPanel === "moodboard"
                ? "bg-zinc-800 text-zinc-200"
                : "text-zinc-600 hover:text-zinc-400"
            }`}
          >
            <Palette className="w-3 h-3" />
            Moodboard
          </button>
        </div>

        <div className="h-4 w-px bg-zinc-800" />

        <button
          onClick={onExport}
          className="text-xs px-3 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
        >
          Export
        </button>
        <button className="p-1.5 rounded text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors">
          <HelpCircle className="w-4 h-4" />
        </button>
        <button className="p-1.5 rounded text-zinc-600 hover:text-zinc-400 hover:bg-zinc-800 transition-colors">
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}

function WorkspaceInner() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session") ?? "";
  const [showExport, setShowExport] = useState(false);
  const [rightPanel, setRightPanel] = useState<RightPanel>("adjust");

  return (
    <WorkspaceProvider sessionId={sessionId}>
      <div className="flex flex-col h-screen bg-zinc-950 text-zinc-200 overflow-hidden">
        <Header
          onExport={() => setShowExport(true)}
          rightPanel={rightPanel}
          setRightPanel={setRightPanel}
        />
        <div className="flex flex-1 min-h-0">
          <ImageBrowser />
          <Canvas />
          {rightPanel === "adjust" ? <AdjustmentPanel /> : <MoodboardPanel />}
        </div>
        <ReferenceStrip />
        <PromptBar />
        <ToastStack />
        {showExport && <ExportModal onClose={() => setShowExport(false)} />}
      </div>
    </WorkspaceProvider>
  );
}

export function Workspace() {
  return (
    <Suspense fallback={<div className="h-screen bg-zinc-950" />}>
      <WorkspaceInner />
    </Suspense>
  );
}
