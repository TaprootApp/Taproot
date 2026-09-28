import React from "react";
import styles from "./Table.module.css";
import { cx } from "../lib/cx";
import { Spinner } from "./Spinner";

export interface Column<T> {
  /** Unique key for the column. */
  key: string;
  /** Header text. */
  header: React.ReactNode;
  /** Cell content for a row. */
  render: (row: T) => React.ReactNode;
  /** CSS width, e.g. "80px" or "30%". */
  width?: string;
  /** Default left. Use right for numbers and row actions. */
  align?: "left" | "right" | "center";
  /** Hide below 640px to keep narrow layouts readable. */
  hideOnMobile?: boolean;
  /** Let long text wrap instead of truncating with an ellipsis. */
  wrap?: boolean;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Stable key per row. */
  rowKey: (row: T) => string | number;
  /** Makes rows clickable (hover highlight, Enter key). Buttons inside cells should stopPropagation. */
  onRowClick?: (row: T) => void;
  /** Row to highlight as selected. */
  selectedKey?: string | number;
  /** Shown instead of rows when rows is empty (e.g. an EmptyState). */
  empty?: React.ReactNode;
  /** Spinner in place of rows when there are none yet; a thin dimming when refreshing existing rows. */
  loading?: boolean;
}

/** Dense data table; scrolls horizontally when too wide. Put it in a Card with padded={false} for edge-to-edge. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  empty,
  loading,
}: TableProps<T>): React.ReactElement {
  if (rows.length === 0) {
    if (loading) return <Spinner block />;
    return <>{empty ?? <p className={styles.noRows}>Nothing here yet.</p>}</>;
  }
  return (
    <div className={cx(styles.scroller, loading && styles.refreshing)}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width, textAlign: c.align }}
                className={cx(c.hideOnMobile && styles.hideOnMobile)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={cx(onRowClick && styles.clickable, selectedKey === key && styles.selected)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row);
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{ textAlign: c.align }}
                    className={cx(c.hideOnMobile && styles.hideOnMobile, c.wrap ? styles.wrap : styles.nowrap)}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
