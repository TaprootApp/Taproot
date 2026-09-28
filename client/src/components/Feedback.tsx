import React from "react";
import styles from "./Feedback.module.css";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { Icon } from "./Icon";

export interface EmptyStateProps {
  /** An emoji or icon element shown large above the title. */
  icon?: React.ReactNode;
  /** Short headline, e.g. "No cases yet". */
  title: React.ReactNode;
  /** One or two sentences of guidance. */
  description?: React.ReactNode;
  /** A Button to get started. */
  action?: React.ReactNode;
  /** Less padding, for use inside a Card or Table. */
  compact?: boolean;
}

/** Friendly placeholder when a list is empty. */
export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action, compact }) => (
  <div className={cx(styles.empty, compact && styles.compact)}>
    {icon && <div className={styles.emptyIcon}>{icon}</div>}
    <p className={styles.emptyTitle}>{title}</p>
    {description && <p className={styles.emptyDescription}>{description}</p>}
    {action && <div className={styles.emptyAction}>{action}</div>}
  </div>
);

/** Load failure with a retry button. message: from useRpc().error; onRetry: usually reload. */
export const ErrorState: React.FC<{ message: string; onRetry?: () => void; title?: string; compact?: boolean }> = ({
  message,
  onRetry,
  title = "Couldn't load this",
  compact,
}) => (
  <div className={cx(styles.empty, compact && styles.compact)} role="alert">
    <div className={cx(styles.emptyIcon, styles.errorIcon)}>
      <Icon name="alert" size={22} />
    </div>
    <p className={styles.emptyTitle}>{title}</p>
    <p className={styles.emptyDescription}>{message}</p>
    {onRetry && (
      <div className={styles.emptyAction}>
        <Button icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      </div>
    )}
  </div>
);

export type BannerTone = "info" | "warning" | "error" | "success";

/** Inline status banner. tone: color (default info); title: ALL-CAPS heading; action: a button on the right. */
export const Banner: React.FC<{
  tone?: BannerTone;
  title?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ tone = "info", title, action, children }) => (
  <div className={cx(styles.banner, styles[tone])} role={tone === "error" ? "alert" : "status"}>
    <div className={styles.bannerText}>
      {title && <div className={styles.bannerTitle}>{title}</div>}
      {children && <div className={styles.bannerBody}>{children}</div>}
    </div>
    {action && <div className={styles.bannerAction}>{action}</div>}
  </div>
);
