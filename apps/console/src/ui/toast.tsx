"use client";

import { CheckCircle2, AlertTriangle, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/cn";

type Toast = { id: number; message: React.ReactNode; tone: "ok" | "err" };
type ToastApi = { show: (message: React.ReactNode, tone?: Toast["tone"]) => void };

const ToastContext = createContext<ToastApi | null>(null);

/** Short confirmations after an action. Errors that need reading stay inline. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const show = useCallback<ToastApi["show"]>(
    (message, tone = "ok") => {
      const id = nextId.current++;
      setToasts((items) => [...items.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === "err" ? 7000 : 3500);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => {
          const Icon = toast.tone === "ok" ? CheckCircle2 : AlertTriangle;
          return (
            <div
              className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border border-line bg-surface px-3.5 py-3 text-sm text-ink shadow-pop"
              key={toast.id}
              role={toast.tone === "err" ? "alert" : "status"}
            >
              <Icon aria-hidden className={cn("mt-0.5 shrink-0", toast.tone === "ok" ? "text-ok" : "text-err")} size={16} />
              <div className="min-w-0 flex-1">{toast.message}</div>
              <button aria-label="Dismiss" className="text-ink-3 hover:text-ink" onClick={() => dismiss(toast.id)} type="button">
                <X aria-hidden size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { show: () => {} };
}
