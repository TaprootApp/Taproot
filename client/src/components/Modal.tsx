import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./Modal.module.css";
import { cx } from "../lib/cx";
import { Button, IconButton } from "./Button";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Whether it's shown. */
  open: boolean;
  /** Called on Escape, the close button or a backdrop click. */
  onClose: () => void;
  /** Heading. */
  title: React.ReactNode;
  /** Buttons at the bottom (right-aligned). */
  footer?: React.ReactNode;
  /** sm 420px, md 560px (default), lg 720px; always fits narrow screens. */
  size?: "sm" | "md" | "lg";
  /** Block closing (e.g. while saving). */
  dismissible?: boolean;
  children?: React.ReactNode;
}

/** Centered dialog with focus trap, Escape to close and body scroll lock. */
export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  footer,
  size = "md",
  dismissible = true,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the first field (skipping the close button) or the dialog itself.
    const first = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (el) => !el.dataset.modalClose,
    );
    (first ?? container).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dismissRef.current) {
          e.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = container.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
    >
      <div
        ref={ref}
        className={cx(styles.dialog, styles[size])}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <IconButton icon="close" label="Close" onClick={onClose} disabled={!dismissible} data-modal-close="1" />
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

export interface ConfirmDialogProps {
  open: boolean;
  /** Question as a title, e.g. "Ban Alice?". */
  title: React.ReactNode;
  /** Consequence in a sentence. */
  message?: React.ReactNode;
  /** Confirm button text (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel button text (default "Cancel"). */
  cancelLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
  /** Spinner on confirm and block closing while the action runs. */
  busy?: boolean;
  /** Disable confirm (e.g. until a required reason is typed). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra content under the message (a reason box, a DurationInput...). */
  children?: React.ReactNode;
}

/** Yes/no dialog for decisive or destructive actions. Keep it open while busy; close it yourself when done. */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  busy,
  confirmDisabled,
  onConfirm,
  onCancel,
  children,
}) => (
  <Modal
    open={open}
    onClose={onCancel}
    title={title}
    size="sm"
    dismissible={!busy}
    footer={
      <>
        <Button onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          loading={busy}
          disabled={confirmDisabled}
        >
          {confirmLabel}
        </Button>
      </>
    }
  >
    {message && <p className={styles.message}>{message}</p>}
    {children && <div className={styles.extra}>{children}</div>}
  </Modal>
);
