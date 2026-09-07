"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { cn } from "cn";

type Toast = { id: number; message: string; tone: "info" | "error" };
type ToastApi = { notify: (message: string) => void; fail: (message: string) => void };

const ToastContext = createContext<ToastApi>({ notify: () => {}, fail: () => {} });

export const useToast = () => useContext(ToastContext);

/** Small enough not to warrant a dependency; every mutation reports through it. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast["tone"]) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({ notify: (m) => push(m, "info"), fail: (m) => push(m, "error") }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => setToasts((prev) => prev.filter((t) => t.id !== toast.id))}
            className={cn(
              "pointer-events-auto max-w-sm rounded-md border px-3 py-2 text-left text-xs shadow-sm",
              toast.tone === "error"
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "bg-background",
            )}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
