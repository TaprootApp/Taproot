import React from "react";
import styles from "./Stat.module.css";
import { cx } from "../lib/cx";
import type { BadgeTone } from "./Badge";

/** Stat tile for dashboards. label: caption; value: the number; hint: small line under it; tone colors the value; onClick makes it a button. */
export const Stat: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: BadgeTone;
  onClick?: () => void;
}> = ({ label, value, hint, tone = "neutral", onClick }) => {
  const body = (
    <>
      <span className={styles.label}>{label}</span>
      <span className={cx(styles.value, styles[tone])}>{value}</span>
      {hint && <span className={styles.hint}>{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cx(styles.stat, styles.clickable)} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={styles.stat}>{body}</div>
  );
};
