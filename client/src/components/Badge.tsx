import React from "react";
import styles from "./Badge.module.css";
import { cx } from "../lib/cx";

export type BadgeTone = "neutral" | "brand" | "success" | "info" | "warning" | "danger";

/** Small pill label. tone: color family (default neutral); color: a hex (role color) shown as a leading dot. */
export const Badge: React.FC<{ tone?: BadgeTone; color?: string; title?: string; children: React.ReactNode }> = ({
  tone = "neutral",
  color,
  title,
  children,
}) => (
  <span className={cx(styles.badge, styles[tone])} title={title}>
    {color && <span className={styles.dot} style={{ background: normalizeHex(color) }} />}
    {children}
  </span>
);

/** Accepts "abc", "#abc", "aabbcc" or "#aabbcc"; anything else becomes a neutral token color. */
export function normalizeHex(hex: string): string {
  const h = hex.trim().replace(/^#/, "");
  return /^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h) ? `#${h}` : "var(--rootsdk-text-tertiary)";
}
