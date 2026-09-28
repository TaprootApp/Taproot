import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import styles from "./Toast.module.css";
import { cx } from "../lib/cx";
import { errorMessage } from "../lib/errors";
import { Icon } from "./Icon";

// Transient notifications, bottom-right (bottom-center on narrow screens).
// useToast().error() accepts a caught error directly and words it.

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface ToastApi {
  /** Green confirmation, e.g. "Settings saved". */
  success: (message: string) => void;
  /** Red error; pass a caught error or a string. */
  error: (errorOrMessage: unknown) => void;
  /** Neutral note. */
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

const DURATION: Record<ToastTone, number> = { success: 3500, info: 4500, error: 7000 };

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      // Keep the stack short; the oldest goes first.
      setToasts((list) => [...list.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), DURATION[tone]);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push("success", message),
      error: (err) => push("error", typeof err === "string" ? err : errorMessage(err)),
      info: (message) => push("info", message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx(styles.toast, styles[t.tone])} role={t.tone === "error" ? "alert" : "status"}>
            <span className={styles.icon}>
              <Icon name={t.tone === "success" ? "check" : t.tone === "error" ? "alert" : "info"} size={16} />
            </span>
            <span className={styles.message}>{t.message}</span>
            <button type="button" className={styles.close} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

/** Show toasts from anywhere under ToastProvider. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside ToastProvider");
  return api;
}
