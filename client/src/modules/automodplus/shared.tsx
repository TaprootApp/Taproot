import React, { useEffect, useRef, useState } from "react";
import { AutomodplusServiceClientEvent, automodplusServiceClient } from "@taproot/gen-client";
import { Banner, Button } from "../../components";
import { useAction, useBroadcast, useRpc } from "../../lib";
import styles from "./automodplus.module.css";

// Draft/baseline form over one of this module's settings objects, like
// useConfigForm in views/settings/shared.tsx: broadcasts for the page's area
// refresh a clean form, and a dirty one is marked stale instead of losing edits.

export type PlusArea = "automodplus:automod" | "automodplus:channels" | "automodplus:join";

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface DraftForm<T> {
  draft: T | undefined;
  patch: (change: Partial<T>) => void;
  set: (update: (draft: T) => T) => void;
  dirty: boolean;
  stale: boolean;
  discard: () => void;
  /** Sends the draft; the returned value becomes the new baseline. */
  save: (update: (draft: T) => Promise<T>, success?: string) => Promise<boolean>;
  /** Replaces the baseline with a server result (e.g. after a separate action), keeping edits if dirty. */
  accept: (fresh: T) => void;
  saving: boolean;
  saveError: string | undefined;
  loading: boolean;
  loadError: string | undefined;
  reload: () => Promise<void>;
  version: number;
}

export function useDraftForm<T>(load: () => Promise<T>, area: PlusArea): DraftForm<T> {
  const data = useRpc(load);
  const [base, setBase] = useState<T | undefined>(undefined);
  const [draft, setDraft] = useState<T | undefined>(undefined);
  const [remote, setRemote] = useState<T | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const dirty = !!draft && !!base && !same(draft, base);
  const state = useRef({ base, dirty });
  state.current = { base, dirty };

  const accept = (fresh: T) => {
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
  };

  useEffect(() => {
    if (data.data) accept(data.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data]);

  useBroadcast(automodplusServiceClient, AutomodplusServiceClientEvent.AutomodplusChanged, () => void data.reload(), {
    filter: (event) => event.area === area,
  });

  const successText = useRef("Settings saved");
  const action = useAction((update: (d: T) => Promise<T>, d: T) => update(d), { success: () => successText.current });

  const save = async (update: (d: T) => Promise<T>, success = "Settings saved"): Promise<boolean> => {
    if (!draft) return false;
    successText.current = success;
    const result = await action.run(update, draft);
    if (!result) return false;
    setBase(result);
    setDraft(result);
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
    set: (update) => setDraft((d) => (d ? update(d) : d)),
    dirty,
    stale: !!remote,
    discard,
    save,
    accept,
    saving: action.busy,
    saveError: action.error,
    loading: data.loading && !data.data,
    loadError: data.data ? undefined : data.error,
    reload: data.reload,
    version,
  };
}

/** "Changed elsewhere" + save error banners. */
export function DraftNotices<T>({ form }: { form: DraftForm<T> }): React.ReactElement | null {
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
          Someone saved these settings while you were editing. Reload to see their version, or save to overwrite it.
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

/** Sticky Save/Discard bar for one or more forms saved together. */
export const UnsavedBar: React.FC<{
  dirty: boolean;
  saving: boolean;
  invalid?: string;
  onSave: () => void;
  onDiscard: () => void;
}> = ({ dirty, saving, invalid, onSave, onDiscard }) => {
  if (!dirty && !saving) return null;
  return (
    <div className={styles.saveBar} role="region" aria-label="Unsaved changes">
      <span className={styles.saveText}>{invalid ?? "You have unsaved changes."}</span>
      <div className={styles.saveActions}>
        <Button variant="quiet" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={onSave} loading={saving} disabled={!!invalid}>
          Save changes
        </Button>
      </div>
    </div>
  );
};

/** A whole number in range, or an error message. Mirrors checkInt on the server. */
export function rangeError(value: number, min: number, max: number, name: string): string | undefined {
  return Number.isInteger(value) && value >= min && value <= max ? undefined : `${name} must be a whole number from ${min} to ${max}.`;
}

export function firstError(errors: Record<string, string | undefined>): string | undefined {
  return Object.values(errors).find(Boolean);
}
