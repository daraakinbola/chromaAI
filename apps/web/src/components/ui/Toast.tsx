"use client";

import { useEffect } from "react";
import { X, AlertCircle, CheckCircle, Info } from "lucide-react";
import { clsx } from "clsx";
import { useWorkspace } from "@/context/WorkspaceContext";
import type { ToastItem } from "@/types";

const ICONS = {
  error:   <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />,
  success: <CheckCircle className="w-3.5 h-3.5 shrink-0 text-emerald-400" />,
  info:    <Info className="w-3.5 h-3.5 shrink-0 text-blue-400" />,
};

const STYLES = {
  error:   "border-red-500/30 bg-red-500/10 text-red-300",
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  info:    "border-blue-500/30 bg-blue-500/10 text-blue-300",
};

function Toast({ toast }: { toast: ToastItem }) {
  const { dismissToast } = useWorkspace();

  useEffect(() => {
    const t = setTimeout(() => dismissToast(toast.id), 5000);
    return () => clearTimeout(t);
  }, [toast.id, dismissToast]);

  return (
    <div
      className={clsx(
        "flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-xs max-w-sm shadow-lg",
        STYLES[toast.type]
      )}
    >
      {ICONS[toast.type]}
      <span className="flex-1 leading-relaxed">{toast.message}</span>
      <button
        onClick={() => dismissToast(toast.id)}
        className="text-current opacity-50 hover:opacity-100 transition-opacity shrink-0 mt-0.5"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

export function ToastStack() {
  const { toasts } = useWorkspace();
  if (!toasts.length) return null;

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast toast={t} />
        </div>
      ))}
    </div>
  );
}
