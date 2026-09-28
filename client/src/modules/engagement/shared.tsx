import React, { useEffect, useRef, useState } from "react";
import type { EngagementChangeEvent, EngagementCurrency, EngagementSettings } from "@taproot/gen-shared";
import { engagementServiceClient, EngagementServiceClientEvent } from "@taproot/gen-client";
import { Banner, Button, ErrorState, Spinner } from "../../components";
import { useAction, useBroadcast, useRpc } from "../../lib";
import settingsStyles from "../../views/settings/Settings.module.css";
import styles from "./engagement.module.css";

// Plumbing shared by the engagement screens: the change feed, money
// formatting, a progress bar and a draft form over one settings section.

export const AREA = {
  xp: "engagement:xp",
  money: "engagement:money",
  shop: "engagement:shop",
  config: "engagement:config",
};

/** Calls `onChange` when the server broadcasts a change in one of `areas`. */
export function useEngagementChanged(areas: string[], onChange: () => void): void {
  useBroadcast(engagementServiceClient, EngagementServiceClientEvent.EngagementChanged, () => onChange(), {
    filter: (event: EngagementChangeEvent) => !event?.area || areas.includes(event.area),
  });
}

/** "🪙 1,250 coins". */
export function formatMoney(currency: EngagementCurrency | undefined, amount: number): string {
  const n = amount.toLocaleString();
  if (!currency) return n;
  return `${currency.symbol ? `${currency.symbol} ` : ""}${n} ${currency.name}`;
}

export const ProgressBar: React.FC<{ value: number; max: number; label?: string }> = ({ value, max, label }) => {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div
      className={styles.progress}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <div className={styles.progressFill} style={{ width: `${pct}%` }} />
    </div>
  );
};

export const MEDALS = ["🥇", "🥈", "🥉"];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SettingsDraft<T> {
  draft: T | undefined;
  patch: (change: Partial<T>) => void;
  dirty: boolean;
  /** Newer settings were saved elsewhere while the draft was dirty. */
  stale: boolean;
  discard: () => void;
  save: () => Promise<boolean>;
  saving: boolean;
  saveError: string | undefined;
  loadError: string | undefined;
  reload: () => Promise<void>;
}

/**
 * Loads the engagement settings and keeps a draft of one section. Like the
 * core settings forms, a broadcast refreshes a clean form and marks a dirty
 * one stale instead of discarding edits.
 */
export function useSettingsDraft<K extends keyof EngagementSettings>(
  key: K,
  saveFn: (value: NonNullable<EngagementSettings[K]>) => Promise<EngagementSettings>,
): SettingsDraft<NonNullable<EngagementSettings[K]>> {
  type T = NonNullable<EngagementSettings[K]>;
  const settings = useRpc(() => engagementServiceClient.getSettings());
  useEngagementChanged([AREA.config], () => void settings.reload());
  const [base, setBase] = useState<T | undefined>(undefined);
  const [draft, setDraft] = useState<T | undefined>(undefined);
  const [remote, setRemote] = useState<T | undefined>(undefined);
  const dirty = !!draft && !!base && !same(draft, base);
  const state = useRef({ base, dirty });
  state.current = { base, dirty };

  const adopt = (value: T) => {
    setBase(value);
    setDraft(value);
    setRemote(undefined);
  };

  useEffect(() => {
    const fresh = settings.data?.[key] as T | undefined;
    if (!fresh) return;
    const { base: current, dirty: isDirty } = state.current;
    if (current && same(fresh, current)) setRemote(undefined);
    else if (!current || !isDirty) adopt(fresh);
    else setRemote(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data, key]);

  const action = useAction((value: T) => saveFn(value), { success: "Settings saved" });

  return {
    draft,
    patch: (change) => setDraft((d) => (d ? { ...d, ...change } : d)),
    dirty,
    stale: !!remote,
    discard: () => {
      const latest = remote ?? base;
      if (latest) adopt(latest);
      action.reset();
    },
    save: async () => {
      if (!draft) return false;
      const result = await action.run(draft);
      const saved = result?.[key] as T | undefined;
      if (!saved) return false;
      adopt(saved);
      return true;
    },
    saving: action.busy,
    saveError: action.error,
    loadError: settings.data ? undefined : settings.error,
    reload: settings.reload,
  };
}

/** Loading/error screen until the draft exists, then the form. */
export function DraftGate<T>({ form, children }: { form: SettingsDraft<T>; children: (draft: T) => React.ReactNode }) {
  if (form.draft) return <>{children(form.draft)}</>;
  if (form.loadError) return <ErrorState message={form.loadError} onRetry={() => void form.reload()} />;
  return <Spinner block label="Loading settings…" />;
}

/** "Changed elsewhere" and save-error banners. */
export function DraftNotices<T>({ form }: { form: SettingsDraft<T> }) {
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
          Someone else saved these settings while you were editing. Reload to see their version (your unsaved edits will be
          lost), or save to overwrite it.
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

/** Sticky Save/Discard bar; `invalid` blocks saving with a reason. */
export function DraftSaveBar<T>({ form, invalid }: { form: SettingsDraft<T>; invalid?: string }) {
  if (!form.dirty && !form.saving) return null;
  return (
    <div className={settingsStyles.saveBar} role="region" aria-label="Unsaved changes">
      <span className={settingsStyles.saveText}>{invalid ?? "You have unsaved changes."}</span>
      <div className={settingsStyles.saveActions}>
        <Button variant="quiet" onClick={form.discard} disabled={form.saving}>
          Discard
        </Button>
        <Button variant="primary" onClick={() => void form.save()} loading={form.saving} disabled={!!invalid}>
          Save changes
        </Button>
      </div>
    </div>
  );
}
