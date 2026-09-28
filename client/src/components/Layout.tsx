import React from "react";
import styles from "./Layout.module.css";
import { cx } from "../lib/cx";

export interface PageHeaderProps {
  /** Page title (sentence case). */
  title: React.ReactNode;
  /** One line under the title. */
  description?: React.ReactNode;
  /** Buttons on the right (wrap below on narrow widths). */
  actions?: React.ReactNode;
}

/** Title block at the top of every view. */
export const PageHeader: React.FC<PageHeaderProps> = ({ title, description, actions }) => (
  <header className={styles.pageHeader}>
    <div className={styles.pageHeaderText}>
      <h1 className={styles.pageTitle}>{title}</h1>
      {description && <p className={styles.pageDescription}>{description}</p>}
    </div>
    {actions && <div className={styles.pageActions}>{actions}</div>}
  </header>
);

export interface CardProps {
  /** Card heading (sentence case). */
  title?: React.ReactNode;
  /** Secondary line under the title. */
  description?: React.ReactNode;
  /** Controls at the top right (a Toggle, a button...). */
  actions?: React.ReactNode;
  /** Bottom bar, typically Save/Cancel buttons (right-aligned). */
  footer?: React.ReactNode;
  /** false removes body padding (for edge-to-edge Tables). Default true. */
  padded?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/** Bordered panel; the basic building block of every screen. */
export const Card: React.FC<CardProps> = ({ title, description, actions, footer, padded = true, className, children }) => (
  <section className={cx(styles.card, className)}>
    {(title || actions) && (
      <div className={styles.cardHeader}>
        <div className={styles.cardHeaderText}>
          {title && <h2 className={styles.cardTitle}>{title}</h2>}
          {description && <p className={styles.cardDescription}>{description}</p>}
        </div>
        {actions && <div className={styles.cardActions}>{actions}</div>}
      </div>
    )}
    {children !== undefined && children !== null && children !== false && (
      <div className={cx(styles.cardBody, !padded && styles.cardBodyFlush, !(title || actions) && styles.cardBodyOnly)}>
        {children}
      </div>
    )}
    {footer && <div className={styles.cardFooter}>{footer}</div>}
  </section>
);

export interface SectionProps {
  /** ALL-CAPS sub-section label, e.g. "Roles". */
  title: React.ReactNode;
  /** Help text under the label. */
  description?: React.ReactNode;
  /** Controls to the right of the label. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
}

/** A labelled region inside a Card, separated from the previous one by a hairline. */
export const Section: React.FC<SectionProps> = ({ title, description, actions, children }) => (
  <div className={styles.section}>
    <div className={styles.sectionHeader}>
      <div>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {description && <p className={styles.sectionDescription}>{description}</p>}
      </div>
      {actions}
    </div>
    {children}
  </div>
);

/** Vertical stack. gap: px (default 16). */
export const Stack: React.FC<{ gap?: number; className?: string; children?: React.ReactNode }> = ({
  gap = 16,
  className,
  children,
}) => (
  <div className={cx(styles.stack, className)} style={{ gap }}>
    {children}
  </div>
);

/** Horizontal wrapping row. gap: px (default 8); align: cross-axis (default center); justify: main axis (default start). */
export const Row: React.FC<{
  gap?: number;
  align?: "start" | "center" | "end" | "baseline" | "stretch";
  justify?: "start" | "end" | "between" | "center";
  wrap?: boolean;
  className?: string;
  children?: React.ReactNode;
}> = ({ gap = 8, align = "center", justify = "start", wrap = true, className, children }) => (
  <div
    className={cx(styles.row, className)}
    style={{
      gap,
      alignItems: align === "start" || align === "end" ? `flex-${align}` : align,
      justifyContent: justify === "between" ? "space-between" : justify === "center" ? "center" : `flex-${justify}`,
      flexWrap: wrap ? "wrap" : "nowrap",
    }}
  >
    {children}
  </div>
);

/** Responsive grid of equal columns, each at least `min` px wide (default 200). gap default 12. */
export const Grid: React.FC<{ min?: number; gap?: number; className?: string; children?: React.ReactNode }> = ({
  min = 200,
  gap = 12,
  className,
  children,
}) => (
  <div
    className={cx(styles.grid, className)}
    style={{ gap, gridTemplateColumns: `repeat(auto-fill, minmax(min(${min}px, 100%), 1fr))` }}
  >
    {children}
  </div>
);
