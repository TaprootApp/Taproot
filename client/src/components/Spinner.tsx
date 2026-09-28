import React from "react";
import styles from "./Spinner.module.css";

/** size: px (default 20); label: text beside it; inline: no centering wrapper; block: centered with padding for a whole panel. */
export const Spinner: React.FC<{ size?: number; label?: string; inline?: boolean; block?: boolean }> = ({
  size = 20,
  label,
  inline,
  block,
}) => {
  const ring = (
    <span
      className={styles.ring}
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 8)) }}
      role={label ? undefined : "status"}
      aria-label={label ? undefined : "Loading"}
    />
  );
  if (inline && !label) return ring;
  return (
    <span className={block ? styles.block : styles.wrap} role="status">
      {ring}
      {label && <span className={styles.label}>{label}</span>}
    </span>
  );
};
