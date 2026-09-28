import React, { useEffect, useRef, useState } from "react";
import type { LogsAnnouncements, LogsConfig, LogsEventSetting } from "@taproot/gen-shared";
import { LogsServiceClientEvent, logsServiceClient } from "@taproot/gen-client";
import settingsStyles from "../../views/settings/Settings.module.css";
import styles from "./ActionLog.module.css";
import {
  Banner,
  Button,
  Card,
  ChannelMultiSelect,
  ChannelSelect,
  ErrorState,
  Field,
  MessagePreview,
  PageHeader,
  Spinner,
  Stack,
  TextArea,
  Toggle,
} from "../../components";
import { useAction, useBroadcast, useRpc, useSession } from "../../lib";

// Dyno-style action log and ban/kick announcements (!logs). Validation
// mirrors updateLogsConfig in server/src/modules/logs/service.ts.

// TEMPLATE_MAX in server/src/modules/logs/events.ts.
const TEMPLATE_MAX = 1000;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function templateError(text: string, name: string): string | undefined {
  if (!text.trim()) return `The ${name} template can't be empty.`;
  if (text.length > TEMPLATE_MAX) return `The ${name} template is too long (${TEMPLATE_MAX} characters max).`;
  return undefined;
}

/** Same placeholders as renderAnnouncement in server/src/modules/logs/format.ts, with sample values. */
function sample(template: string, name: string, server: string): string {
  const vars: Record<string, string> = {
    "user.name": name,
    "user.id": "0000000000000000000000",
    reason: "Spamming invite links",
    server,
  };
  return template.replace(/\{([a-z.]+)\}/gi, (whole, key: string) => vars[key.toLowerCase()] ?? whole);
}

/**
 * Draft over the saved config. Broadcasts refresh it when clean; when dirty
 * the newer version is held back and `stale` is set, so edits are never lost.
 */
function useLogsForm() {
  const config = useRpc(() => logsServiceClient.getLogsConfig());
  const [base, setBase] = useState<LogsConfig | undefined>(undefined);
  const [draft, setDraft] = useState<LogsConfig | undefined>(undefined);
  const [remote, setRemote] = useState<LogsConfig | undefined>(undefined);
  const dirty = !!draft && !!base && !same(draft, base);
  const state = useRef({ base, dirty });
  state.current = { base, dirty };

  useEffect(() => {
    const fresh = config.data;
    if (!fresh) return;
    const { base: current, dirty: isDirty } = state.current;
    if (current && same(fresh, current)) return setRemote(undefined);
    if (!current || !isDirty) {
      setBase(fresh);
      setDraft(fresh);
      setRemote(undefined);
    } else {
      setRemote(fresh);
    }
  }, [config.data]);

  useBroadcast(logsServiceClient, LogsServiceClientEvent.LogsChanged, () => void config.reload());

  const action = useAction((d: LogsConfig) => logsServiceClient.updateLogsConfig(d), { success: "Action log saved" });
  const reset = (value: LogsConfig | undefined) => {
    setBase(value);
    setDraft(value);
    setRemote(undefined);
  };

  return {
    draft,
    dirty,
    stale: !!remote,
    patch: (change: Partial<LogsConfig>) => setDraft((d) => (d ? { ...d, ...change } : d)),
    save: async () => {
      if (!draft) return;
      const saved = await action.run(draft);
      if (saved) reset(saved);
    },
    discard: () => {
      reset(remote ?? base);
      action.reset();
    },
    saving: action.busy,
    saveError: action.error,
    loadError: config.data ? undefined : config.error,
    reload: config.reload,
  };
}

const EventRow: React.FC<{ event: LogsEventSetting; onChange: (e: LogsEventSetting) => void }> = ({ event, onChange }) => (
  <div className={styles.eventRow}>
    <Toggle checked={event.enabled} onChange={(enabled) => onChange({ ...event, enabled })} label={event.label} />
    <div className={event.enabled ? styles.override : `${styles.override} ${settingsStyles.dimmed}`}>
      <ChannelSelect
        value={event.channelId}
        onChange={(channelId) => onChange({ ...event, channelId })}
        noneLabel="Default channel"
        disabled={!event.enabled}
      />
    </div>
  </div>
);

const AnnouncementsCard: React.FC<{
  value: LogsAnnouncements;
  onChange: (value: LogsAnnouncements) => void;
  errors: { ban?: string; kick?: string };
}> = ({ value, onChange, errors }) => {
  const { session } = useSession();
  const name = session.nickname || "Example member";
  const server = session.communityName || "your community";
  const patch = (change: Partial<LogsAnnouncements>) => onChange({ ...value, ...change });
  const on = !!value.channelId;
  return (
    <Card
      title="Ban and kick announcements"
      description="Post a public message when someone is banned or kicked, like Dyno's announcements. Join and leave messages are on the Welcome page."
    >
      <Stack>
        <Field label="Channel" help="Usually a public channel. Leave it off to skip announcements.">
          <ChannelSelect value={value.channelId} onChange={(channelId) => patch({ channelId })} noneLabel="Off" />
        </Field>
        <div className={on ? undefined : settingsStyles.dimmed}>
          <Stack>
            <Toggle checked={value.bans} onChange={(bans) => patch({ bans })} label="Announce bans" disabled={!on} />
            <Field label="Ban message" error={errors.ban}>
              <TextArea value={value.banTemplate} onChange={(banTemplate) => patch({ banTemplate })} maxLength={TEMPLATE_MAX} rows={2} />
            </Field>
            <MessagePreview content={sample(value.banTemplate, name, server)} author="Taproot" />
            <Toggle checked={value.kicks} onChange={(kicks) => patch({ kicks })} label="Announce kicks" disabled={!on} />
            <Field label="Kick message" error={errors.kick}>
              <TextArea value={value.kickTemplate} onChange={(kickTemplate) => patch({ kickTemplate })} maxLength={TEMPLATE_MAX} rows={2} />
            </Field>
            <MessagePreview content={sample(value.kickTemplate, name, server)} author="Taproot" />
            <p className={settingsStyles.hint}>
              Placeholders: <code>{"{user.name}"}</code> the member's name, <code>{"{user.id}"}</code> their ID,{" "}
              <code>{"{reason}"}</code> the reason (or "No reason given"), <code>{"{server}"}</code> the community name. Kicks
              made outside Taproot have no reason.
            </p>
          </Stack>
        </div>
      </Stack>
    </Card>
  );
};

const ActionLog: React.FC = () => {
  const form = useLogsForm();
  const d = form.draft;

  if (!d) {
    if (form.loadError) return <ErrorState message={form.loadError} onRetry={() => void form.reload()} />;
    return <Spinner block label="Loading settings…" />;
  }

  const announcements = d.announcements ?? { bans: true, kicks: true, banTemplate: "", kickTemplate: "" };
  const errors = {
    ban: templateError(announcements.banTemplate, "ban"),
    kick: templateError(announcements.kickTemplate, "kick"),
  };
  const invalid = errors.ban ?? errors.kick;
  const groups = [...new Set(d.events.map((e) => e.group))];
  const setEvent = (next: LogsEventSetting) => form.patch({ events: d.events.map((e) => (e.key === next.key ? next : e)) });
  const setAll = (enabled: boolean) => form.patch({ events: d.events.map((e) => ({ ...e, enabled })) });
  const routedOnly = !d.channelId && d.events.some((e) => e.enabled && e.channelId);

  return (
    <Stack>
      <PageHeader
        title="Action log"
        description="Post deleted and edited messages, joins, leaves, bans, role, channel and voice changes to a staff channel."
      />
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

      <Card title="Log channel" description="Where events go unless an event picks its own channel below.">
        <Stack>
          <Field
            label="Default channel"
            help="Make it a private staff channel: logs include deleted messages and member IDs. Taproot posts a short note there when you save."
          >
            <ChannelSelect value={d.channelId} onChange={(channelId) => form.patch({ channelId })} noneLabel="Off" />
          </Field>
          {routedOnly && <p className={settingsStyles.hint}>Only events with their own channel are logged while this is off.</p>}
        </Stack>
      </Card>

      <Card
        title="Events"
        description="Turn events on or off, and optionally send some to a different channel."
        actions={
          <div className={styles.bulk}>
            <Button size="sm" variant="quiet" onClick={() => setAll(true)}>
              All on
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setAll(false)}>
              All off
            </Button>
          </div>
        }
      >
        <Stack gap={20}>
          {groups.map((group) => (
            <div key={group} className={styles.group}>
              <h3 className={styles.groupTitle}>{group}</h3>
              {d.events
                .filter((e) => e.group === group)
                .map((event) => (
                  <EventRow key={event.key} event={event} onChange={setEvent} />
                ))}
            </div>
          ))}
          <p className={settingsStyles.hint}>
            Deleted-message content comes from messages Taproot saw in the last day while running; it's kept in memory only.
            Deletions, kicks and role changes made by Taproot itself don't raise events, but its kicks and bans are still
            logged from the mod log.
          </p>
        </Stack>
      </Card>

      <Card title="Ignored channels" description="Messages and voice activity in these channels aren't logged. The log channels and the mod log are always skipped.">
        <ChannelMultiSelect
          value={d.ignoredChannelIds}
          onChange={(ignoredChannelIds) => form.patch({ ignoredChannelIds })}
          emptyText="No ignored channels"
        />
      </Card>

      <AnnouncementsCard value={announcements} onChange={(a) => form.patch({ announcements: a })} errors={errors} />

      {(form.dirty || form.saving) && (
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
      )}
    </Stack>
  );
};

export default ActionLog;
