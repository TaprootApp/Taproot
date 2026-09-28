import React, { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import styles from "./Forms.module.css";
import { cx } from "../lib/cx";
import { durationToInput, formatDuration, parseDuration } from "../lib/format";

// Form controls. All are controlled and call onChange with the new value
// (not the DOM event). Put a control inside a Field and it picks up the
// Field's id and error state automatically.

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | undefined>(undefined);

/** id/aria wiring for a control: explicit props win over the enclosing Field. */
function useFieldProps(id?: string, invalid?: boolean) {
  const field = useContext(FieldContext);
  return {
    id: id ?? field?.id,
    "aria-describedby": field?.describedBy,
    "aria-invalid": invalid || field?.invalid || undefined,
  };
}

export interface FieldProps {
  /** Label text. */
  label: React.ReactNode;
  /** Help text under the control. */
  help?: React.ReactNode;
  /** Error text under the control (replaces help, turns the control red). */
  error?: React.ReactNode;
  /** Small note to the right of the label, e.g. "Optional". */
  hint?: React.ReactNode;
  /** The control. */
  children: React.ReactNode;
  className?: string;
}

/** Label + control + help/error. */
export const Field: React.FC<FieldProps> = ({ label, help, error, hint, children, className }) => {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || help;
  return (
    <FieldContext.Provider value={{ id, describedBy: note ? noteId : undefined, invalid: !!error }}>
      <div className={cx(styles.field, className)}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={id}>
            {label}
          </label>
          {hint && <span className={styles.labelHint}>{hint}</span>}
        </div>
        {children}
        {note && (
          <p id={noteId} className={cx(styles.note, !!error && styles.noteError)} role={error ? "alert" : undefined}>
            {note}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
};

export interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "prefix" | "size"> {
  /** Current text. */
  value: string;
  /** Called with the new text. */
  onChange: (value: string) => void;
  /** Red border. (Automatic inside a Field with an error.) */
  invalid?: boolean;
  /** Called when Enter is pressed (e.g. run a search). */
  onEnter?: () => void;
  /** Fixed text inside the box before the value, e.g. "!" for command names. */
  prefix?: React.ReactNode;
}

/** Single-line text box. Any other <input> prop (placeholder, maxLength, type, autoFocus...) passes through. */
export const TextInput: React.FC<TextInputProps> = ({
  value,
  onChange,
  invalid,
  onEnter,
  prefix,
  id,
  className,
  onKeyDown,
  ...rest
}) => {
  const fieldProps = useFieldProps(id, invalid);
  const input = (
    <input
      {...fieldProps}
      {...rest}
      className={cx(styles.input, !!prefix && styles.inputWithPrefix, !prefix && className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
        onKeyDown?.(e);
      }}
    />
  );
  if (!prefix) return input;
  return (
    <div className={cx(styles.prefixWrap, className)}>
      <span className={styles.prefix}>{prefix}</span>
      {input}
    </div>
  );
};

export interface TextAreaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  /** Current text. */
  value: string;
  /** Called with the new text. */
  onChange: (value: string) => void;
  /** Hard limit; also enables the counter. */
  maxLength?: number;
  /** Show "12 / 2000" under the box (default: on when maxLength is set). */
  showCount?: boolean;
  /** Red border. */
  invalid?: boolean;
  /** Grow with content up to ~16 lines (default true). */
  autoGrow?: boolean;
}

/** Multi-line text box with an optional character counter. */
export const TextArea: React.FC<TextAreaProps> = ({
  value,
  onChange,
  maxLength,
  showCount,
  invalid,
  autoGrow = true,
  rows = 4,
  id,
  className,
  ...rest
}) => {
  const fieldProps = useFieldProps(id, invalid);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !autoGrow) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 16 * 20 + 20)}px`;
  }, [value, autoGrow]);
  const counter = showCount ?? maxLength !== undefined;
  const near = maxLength !== undefined && value.length > maxLength * 0.9;
  return (
    <div className={cx(styles.textareaWrap, className)}>
      <textarea
        ref={ref}
        {...fieldProps}
        {...rest}
        rows={rows}
        maxLength={maxLength}
        className={styles.textarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {counter && (
        <span className={cx(styles.counter, near && styles.counterNear)}>
          {value.length.toLocaleString()}
          {maxLength !== undefined && ` / ${maxLength.toLocaleString()}`}
        </span>
      )}
    </div>
  );
};

export interface NumberInputProps {
  /** Current number. */
  value: number;
  /** Called with a valid in-range number (clamped on blur). */
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  /** Default 1; non-integers allowed if step is fractional. */
  step?: number;
  /** Unit text after the box, e.g. "messages" or "%". */
  suffix?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  /** Box width in px (default 88). */
  width?: number;
}

/** Numeric box that tolerates in-progress typing and clamps to min/max on blur. */
export const NumberInput: React.FC<NumberInputProps> = ({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  id,
  width = 88,
}) => {
  const fieldProps = useFieldProps(id);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const clamp = (n: number) => {
    let out = step % 1 === 0 ? Math.round(n) : n;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return out;
  };
  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);

  return (
    <div className={styles.numberWrap}>
      <input
        {...fieldProps}
        type="number"
        inputMode="numeric"
        className={cx(styles.input, styles.number)}
        style={{ width }}
        value={draft}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(n) && inRange(n)) onChange(n);
        }}
        onBlur={() => {
          const n = Number(draft);
          const next = draft.trim() === "" || !Number.isFinite(n) ? clamp(value) : clamp(n);
          setDraft(String(next));
          if (next !== value) onChange(next);
        }}
      />
      {suffix && <span className={styles.suffix}>{suffix}</span>}
    </div>
  );
};

export interface ToggleProps {
  /** On/off. */
  checked: boolean;
  /** Called with the new state. */
  onChange: (checked: boolean) => void;
  /** Row title; without it only the switch renders (then pass ariaLabel). */
  label?: React.ReactNode;
  /** Secondary line under the label. */
  description?: React.ReactNode;
  disabled?: boolean;
  /** Accessible name when there's no visible label. */
  ariaLabel?: string;
}

/** Switch; with a label it becomes a full-width setting row (text left, switch right). */
export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label, description, disabled, ariaLabel }) => {
  const id = useId();
  const sw = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? `${id}-label` : undefined}
      disabled={disabled}
      className={styles.switch}
      data-state={checked ? "checked" : "unchecked"}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.thumb} />
    </button>
  );
  if (!label) return sw;
  return (
    <div className={cx(styles.toggleRow, disabled && styles.disabled)}>
      <div className={styles.toggleText} onClick={() => !disabled && onChange(!checked)}>
        <span id={`${id}-label`} className={styles.toggleLabel}>
          {label}
        </span>
        {description && <span className={styles.toggleDescription}>{description}</span>}
      </div>
      {sw}
    </div>
  );
};

export interface SelectOption<V extends string | number> {
  value: V;
  label: string;
  disabled?: boolean;
  /** Options with the same group render under one heading. */
  group?: string;
}

export interface SelectProps<V extends string | number> {
  /** Selected value (may be absent from options; then the placeholder shows). */
  value: V | undefined;
  /** Called with the chosen option's value. */
  onChange: (value: V) => void;
  options: SelectOption<V>[];
  /** Shown when nothing (or an unknown value) is selected. */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Native dropdown styled like Root's inputs (works well on mobile). */
export function Select<V extends string | number>({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  disabled,
  id,
  className,
}: SelectProps<V>): React.ReactElement {
  const fieldProps = useFieldProps(id);
  const index = options.findIndex((o) => o.value === value);
  const groups: { name: string | undefined; items: { option: SelectOption<V>; index: number }[] }[] = [];
  options.forEach((option, i) => {
    const last = groups[groups.length - 1];
    if (last && last.name === option.group) last.items.push({ option, index: i });
    else groups.push({ name: option.group, items: [{ option, index: i }] });
  });
  const render = (items: { option: SelectOption<V>; index: number }[]) =>
    items.map(({ option, index: i }) => (
      <option key={i} value={i} disabled={option.disabled}>
        {option.label}
      </option>
    ));
  return (
    <div className={cx(styles.selectWrap, className)}>
      <select
        {...fieldProps}
        className={cx(styles.input, styles.select)}
        value={index >= 0 ? String(index) : ""}
        disabled={disabled}
        onChange={(e) => {
          const option = options[Number(e.target.value)];
          if (option) onChange(option.value);
        }}
      >
        {index < 0 && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {groups.map((g, gi) =>
          g.name ? (
            <optgroup key={gi} label={g.name}>
              {render(g.items)}
            </optgroup>
          ) : (
            <React.Fragment key={gi}>{render(g.items)}</React.Fragment>
          ),
        )}
      </select>
      <svg className={styles.selectChevron} width="14" height="14" viewBox="0 0 24 24" aria-hidden>
        <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export interface DurationInputProps {
  /** Milliseconds; 0 = empty/none; undefined = the typed text is invalid. */
  value: number | undefined;
  /** Called with ms (0 when cleared, if allowEmpty) or undefined while the text is invalid. */
  onChange: (ms: number | undefined) => void;
  /** Placeholder / meaning of empty, e.g. "Permanent" or "Indefinite". Default "e.g. 10m, 2h, 1d". */
  emptyLabel?: string;
  /** Whether an empty box is valid (value 0). Default true. */
  allowEmpty?: boolean;
  /** Quick-pick chips, in ms, e.g. [600000, 3600000, 86400000]. */
  presets?: number[];
  /** Upper bound in ms; larger values are invalid. */
  max?: number;
  disabled?: boolean;
  id?: string;
}

/** Duration box accepting "10m", "2h", "1d12h", "1w" (same syntax as the text commands). */
export const DurationInput: React.FC<DurationInputProps> = ({
  value,
  onChange,
  emptyLabel,
  allowEmpty = true,
  presets,
  max,
  disabled,
  id,
}) => {
  const fieldProps = useFieldProps(id);
  const [draft, setDraft] = useState(value ? durationToInput(value) : "");
  useEffect(() => {
    // Sync from outside (form reset, preset) unless the draft already means it.
    if (value === undefined) return;
    const current = draft.trim() === "" ? 0 : parseDuration(draft);
    if (current !== value) setDraft(value ? durationToInput(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const interpret = (text: string): number | undefined => {
    if (text.trim() === "") return allowEmpty ? 0 : undefined;
    const ms = parseDuration(text);
    if (ms === undefined || (max !== undefined && ms > max)) return undefined;
    return ms;
  };

  const parsed = interpret(draft);
  const invalid = parsed === undefined && (draft.trim() !== "" || !allowEmpty);
  return (
    <div className={styles.durationWrap}>
      <div className={styles.durationRow}>
        <input
          {...fieldProps}
          aria-invalid={invalid || fieldProps["aria-invalid"]}
          className={cx(styles.input, styles.duration)}
          value={draft}
          placeholder={emptyLabel ?? "e.g. 10m, 2h, 1d"}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(interpret(e.target.value));
          }}
        />
        {parsed !== undefined && parsed > 0 && <span className={styles.durationEcho}>= {formatDuration(parsed, 3)}</span>}
        {invalid && draft.trim() !== "" && (
          <span className={styles.durationError}>
            {max !== undefined && parseDuration(draft) ? `Max ${formatDuration(max)}` : "Use e.g. 30m, 2h, 1d"}
          </span>
        )}
      </div>
      {presets && presets.length > 0 && (
        <div className={styles.presets}>
          {presets.map((ms) => (
            <button
              key={ms}
              type="button"
              disabled={disabled}
              className={cx(styles.preset, value === ms && styles.presetActive)}
              onClick={() => {
                setDraft(durationToInput(ms));
                onChange(ms);
              }}
            >
              {formatDuration(ms)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** Chip with a remove button, used by the multi-selects. color: hex dot. */
export const Chip: React.FC<{ label: React.ReactNode; color?: string; onRemove?: () => void; muted?: boolean }> = ({
  label,
  color,
  onRemove,
  muted,
}) => (
  <span className={cx(styles.chip, muted && styles.chipMuted)}>
    {color && <span className={styles.chipDot} style={{ background: color }} />}
    <span className={styles.chipLabel}>{label}</span>
    {onRemove && (
      <button type="button" className={styles.chipRemove} onClick={onRemove} aria-label="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </button>
    )}
  </span>
);
