import React from "react";
import styles from "./Button.module.css";
import { cx } from "../lib/cx";
import { Icon, IconName } from "./Icon";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary (filled), secondary (outline), danger (filled red), quiet (flat tint). Default secondary. */
  variant?: ButtonVariant;
  /** sm for table rows and toolbars; md default. */
  size?: "sm" | "md";
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Leading icon. */
  icon?: IconName;
}

/** Pill button in Root's style. type defaults to "button" so it never submits a form by accident. */
export const Button: React.FC<ButtonProps> = ({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}) => (
  <button
    type={type}
    className={cx(styles.button, styles[variant], size === "sm" && styles.sm, className)}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...rest}
  >
    {loading ? <Spinner size={size === "sm" ? 12 : 14} inline /> : icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
    {children}
  </button>
);

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Icon to show. */
  icon: IconName;
  /** Accessible label, also the tooltip. */
  label: string;
  /** Red at rest for destructive actions (pair with a confirm). */
  danger?: boolean;
  /** Shows a spinner instead of the icon. */
  loading?: boolean;
}

/** Square icon-only button (edit, delete, close...). */
export const IconButton: React.FC<IconButtonProps> = ({
  icon,
  label,
  danger,
  loading,
  className,
  disabled,
  type = "button",
  ...rest
}) => (
  <button
    type={type}
    className={cx(styles.iconButton, danger && styles.iconDanger, className)}
    aria-label={label}
    title={label}
    disabled={disabled || loading}
    {...rest}
  >
    {loading ? <Spinner size={14} inline /> : <Icon name={icon} size={16} />}
  </button>
);
