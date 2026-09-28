import React, { useEffect, useRef, useState } from "react";
import type { Config, RoleInfo } from "@taproot/gen-shared";
import { ConfigServiceClientEvent, configServiceClient } from "@taproot/gen-client";
import styles from "./Settings.module.css";
import { Banner, Button, Chip, ErrorState, Select, Spinner, TextInput, normalizeHex } from "../../components";
import { useAction, useBroadcast, useRoles, useRpc } from "../../lib";

// Shared plumbing for the admin settings screens: a draft/baseline form over
// one section of the Config, the Save/Discard bar, and a couple of list
// editors that the kit doesn't provide.

export type ConfigSection = "general" | "welcome" | "automod";
type SectionOf<S extends ConfigSection> = NonNullable<Config[S]>;

/** Field-wise equality; the generated messages are plain JSON-able objects. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ConfigForm<T> {
  /** The edited copy, undefined until the first load. */
  draft: T | undefined;
  /** Replaces fields of the draft. */
  patch: (change: Partial<T>) => void;
  /** Draft differs from what's saved. */
  dirty: boolean;
  /** Newer settings arrived (another admin, a text command) while the draft was dirty. */
  stale: boolean;
  /** Throws the draft away and shows the latest saved settings. */
  discard: () => void;
  /** Sends the draft; on success the returned Config becomes the new baseline. */
  save: (update: (draft: T) => Promise<Config>) => Promise<boolean>;
  saving: boolean;
  /** Bumped whenever the draft is reset from the server (load, save, discard). */
  version: number;
  /** Server's message from the last failed save. */
  saveError: string | undefined;
  loading: boolean;
  loadError: string | undefined;
  reload: () => Promise<void>;
}

/**
 * Loads one Config section and keeps a draft of it. ConfigChanged broadcasts
 * for this section refresh the form when it's clean; when it's dirty the
 * newer version is held back and `stale` is set, so edits are never lost.
 */
export function useConfigForm<S extends ConfigSection>(section: S): ConfigForm<SectionOf<S>> {
  type T = SectionOf<S>;
  const config = useRpc(() => configServiceClient.getConfig());
  const [base, setBase] = useState<T | undefined>(undefined);
  const [draft, setDraft] = useState<T | undefined>(undefined);
  const [remote, setRemote] = useState<T | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const dirty = !!draft && !!base && !same(draft, base);

  // Refs let the load effect see the current draft without re-running on edits.
  const state = useRef({ base, dirty });
  state.current = { base, dirty };

  useEffect(() => {
    const fresh = config.data?.[section] as T | undefined;
    if (!fresh) return;
    const { base: current, dirty: isDirty } = state.current;
    if (current && same(fresh, current)) {
      setRemote(undefined);
      return;
    }
    if (!current || !isDirty) {
      setBase(fresh);
      setDraft(fresh);
      setRemote(undefined);
      setVersion((v) => v + 1);
    } else {
      setRemote(fresh);
    }
  }, [config.data, section]);

  useBroadcast(configServiceClient, ConfigServiceClientEvent.ConfigChanged, () => void config.reload(), {
    filter: (event) => !event.area || event.area === section,
  });

  const action = useAction((update: (d: T) => Promise<Config>, d: T) => update(d), { success: "Settings saved" });

  const save = async (update: (d: T) => Promise<Config>): Promise<boolean> => {
    if (!draft) return false;
    const result = await action.run(update, draft);
    const saved = result?.[section] as T | undefined;
    if (!saved) return false;
    setBase(saved);
    setDraft(saved);
    setRemote(undefined);
    setVersion((v) => v + 1);
    return true;
  };

  const discard = () => {
    const latest = remote ?? base;
    setBase(latest);
    setDraft(latest);
    setRemote(undefined);
    setVersion((v) => v + 1);
    action.reset();
  };

  return {
    draft,
    patch: (change) => setDraft((d) => (d ? { ...d, ...change } : d)),
    dirty,
    stale: !!remote,
    discard,
    save,
    version,
    saving: action.busy,
    saveError: action.error,
    loading: config.loading && !config.data,
    loadError: config.data ? undefined : config.error,
    reload: config.reload,
  };
}

/** Loading/error screen while the form has no data; renders children once it does. */
export function FormGate<T>({
  form,
  children,
}: {
  form: ConfigForm<T>;
  children: (draft: T) => React.ReactNode;
}): React.ReactElement {
  if (form.draft) return <>{children(form.draft)}</>;
  if (form.loadError) return <ErrorState message={form.loadError} onRetry={() => void form.reload()} />;
  return <Spinner block label="Loading settings…" />;
}

/** "Changed elsewhere" notice plus the server's save error, shown above the form. */
export function FormNotices<T>({ form }: { form: ConfigForm<T> }): React.ReactElement | null {
  if (!form.stale && !form.saveError) return null;
  return (
    <>
      {form.stale && (
        <Banner
          tone="warning"
          title="Changed elsewhere"
          action={
            <Button size="sm" onClick={form.discard}>
              Reload
            </Button>
          }
        >
          Someone else saved these settings while you were editing. Reload to see their version (your unsaved edits
          will be lost), or save to overwrite it.
        </Banner>
      )}
      {form.saveError && (
        <Banner tone="error" title="Couldn't save">
          {form.saveError}
        </Banner>
      )}
    </>
  );
}

/** Sticky Save/Discard bar. `invalid` blocks saving with a reason. */
export function SaveBar<T>({
  form,
  onSave,
  invalid,
}: {
  form: ConfigForm<T>;
  onSave: () => void;
  invalid?: string;
}): React.ReactElement | null {
  if (!form.dirty && !form.saving) return null;
  return (
    <div className={styles.saveBar} role="region" aria-label="Unsaved changes">
      <span className={styles.saveText}>{invalid ?? "You have unsaved changes."}</span>
      <div className={styles.saveActions}>
        <Button variant="quiet" onClick={form.discard} disabled={form.saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} loading={form.saving} disabled={!!invalid}>
          Save changes
        </Button>
      </div>
    </div>
  );
}

/** First non-empty message among a form's field errors. */
export function firstError(errors: Record<string, string | undefined>): string | undefined {
  return Object.values(errors).find(Boolean);
}

export interface TagListProps {
  value: string[];
  onChange: (value: string[]) => void;
  /** Turns typed text into entries, or an error message. */
  parse: (text: string) => string[] | string;
  placeholder?: string;
  emptyText?: string;
  /** Show entries in a monospace font. */
  mono?: boolean;
}

/** Chips for a list of strings plus a box to add more (Enter or the Add button). */
export const TagList: React.FC<TagListProps> = ({ value, onChange, parse, placeholder, emptyText, mono }) => {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const add = () => {
    if (!text.trim()) return;
    const parsed = parse(text);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    onChange([...value, ...parsed.filter((p, i) => !value.includes(p) && parsed.indexOf(p) === i)]);
    setText("");
    setError(undefined);
  };
  return (
    <div className={styles.tagList}>
      <div className={styles.chips}>
        {value.length === 0 && <span className={styles.empty}>{emptyText ?? "Nothing added yet"}</span>}
        {value.map((entry) => (
          <Chip
            key={entry}
            label={mono ? <span className="tp-mono">{entry}</span> : entry}
            onRemove={() => onChange(value.filter((v) => v !== entry))}
          />
        ))}
      </div>
      <div className={styles.adderRow}>
        <TextInput
          value={text}
          onChange={(t) => {
            setText(t);
            setError(undefined);
          }}
          onEnter={add}
          onBlur={() => text.trim() && add()}
          placeholder={placeholder}
          invalid={!!error}
          spellCheck={false}
          autoComplete="off"
        />
        <Button icon="plus" onClick={add} disabled={!text.trim()}>
          Add
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {value.length > 0 && (
        <button type="button" className={`tp-link ${styles.clearAll}`} onClick={() => onChange([])}>
          Remove all
        </button>
      )}
    </div>
  );
};

/**
 * Role chips plus an "Add role" dropdown where staff roles are listed but
 * disabled, so admins can see why a role is missing. The kit's
 * RoleMultiSelect hides them instead.
 */
export const SelfRolePicker: React.FC<{ value: string[]; onChange: (ids: string[]) => void }> = ({
  value,
  onChange,
}) => {
  const roles = useRoles();
  const privileged = value.map((id) => roles.byId.get(id)).filter((r): r is RoleInfo => !!r?.privileged);
  const options = roles.items.map((r) => ({
    value: r.id,
    label: r.privileged ? `${r.name} — staff role, can't be self-assigned` : r.name,
    disabled: r.privileged || value.includes(r.id),
  }));
  return (
    <div className={styles.tagList}>
      <div className={styles.chips}>
        {value.length === 0 && <span className={styles.empty}>No self-assignable roles</span>}
        {value.map((id) => {
          const role = roles.byId.get(id);
          return (
            <Chip
              key={id}
              label={role ? role.name : roles.loading ? "…" : "Unknown role (deleted)"}
              muted={!role}
              color={role?.colorHex ? normalizeHex(role.colorHex) : undefined}
              onRemove={() => onChange(value.filter((v) => v !== id))}
            />
          );
        })}
      </div>
      <Select
        value={undefined}
        onChange={(id: string) => onChange([...value, id])}
        options={options}
        placeholder={roles.loading ? "Loading roles…" : "Add a role…"}
        disabled={roles.loading && roles.items.length === 0}
        className={styles.adder}
      />
      {privileged.length > 0 && (
        <p className={styles.error}>
          {privileged.map((r) => r.name).join(", ")} now {privileged.length === 1 ? "has" : "have"} staff permissions, so
          Taproot refuses to hand {privileged.length === 1 ? "it" : "them"} out. Remove{" "}
          {privileged.length === 1 ? "it" : "them"} from this list.
        </p>
      )}
      {roles.error && (
        <p className={styles.error}>
          {roles.error}{" "}
          <button type="button" className="tp-link" onClick={roles.reload}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
};
