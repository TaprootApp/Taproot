import React from "react";
import styles from "./Tabs.module.css";

export interface TabDef<K extends string> {
  key: K;
  label: React.ReactNode;
  /** Optional count shown after the label. */
  count?: number;
}

/** Underlined tab bar. tabs: definitions; value: active key; onChange: new key. Renders only the bar; show the panel yourself. */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: TabDef<K>[];
  value: K;
  onChange: (key: K) => void;
}): React.ReactElement {
  return (
    <div className={styles.bar} role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === value}
          className={styles.tab}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className={styles.count}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
