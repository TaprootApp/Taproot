import React, { useState } from "react";
import { AutomodplusAllowType, AutomodplusPurgeMode } from "@taproot/gen-shared";
import type { AutomodplusChannelRules, AutomodplusPurge, AutomodplusPurgeSave } from "@taproot/gen-shared";
import { AutomodplusServiceClientEvent, automodplusServiceClient } from "@taproot/gen-client";
import {
  Button,
  Card,
  ChannelSelect,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Spinner,
  Stack,
  Table,
  TextInput,
  Toggle,
} from "../../components";
import type { Column } from "../../components";
import { formatDateTime, formatRelative, useAction, useBroadcast, useChannels, useRpc } from "../../lib";
import { DraftNotices, UnsavedBar, firstError, rangeError, useDraftForm } from "./shared";
import styles from "./automodplus.module.css";

// Channel rules (admins): Auto delete, Slowmode and Auto purge. The first two
// are one form (UpdateChannelRules replaces both lists); auto purges are saved
// one at a time because each has its own schedule. Same rules as the
// autodelete, slowmode and autopurge commands.

type ListRules = Pick<AutomodplusChannelRules, "autoDelete" | "slowmode">;

const ALLOW_OPTIONS = [
  { value: AutomodplusAllowType.ANY, label: "Anything (no type rule)" },
  { value: AutomodplusAllowType.IMAGES, label: "Images and videos only" },
  { value: AutomodplusAllowType.ATTACHMENTS, label: "Attachments only" },
  { value: AutomodplusAllowType.LINKS, label: "Links only" },
  { value: AutomodplusAllowType.TEXT, label: "Text only" },
  { value: AutomodplusAllowType.COMMANDS, label: "Commands only" },
];

function listErrors(d: ListRules | undefined): Record<string, string | undefined> {
  if (!d) return {};
  const errors: Record<string, string | undefined> = {};
  const seen = new Set<string>();
  d.autoDelete.forEach((r, i) => {
    if (!r.channelId) errors[`ad${i}`] = "Pick a channel for every auto delete rule.";
    else if (seen.has(r.channelId)) errors[`ad${i}`] = "Each channel can have only one auto delete rule.";
    seen.add(r.channelId);
    errors[`adm${i}`] = rangeError(r.deleteAfterMinutes, 0, 10080, "Delete after");
    if (r.allow === AutomodplusAllowType.ANY && r.deleteAfterMinutes === 0) {
      errors[`adn${i}`] = "An auto delete rule needs a message type or a delay.";
    }
  });
  seen.clear();
  d.slowmode.forEach((r, i) => {
    if (!r.channelId) errors[`sm${i}`] = "Pick a channel for every slowmode rule.";
    else if (seen.has(r.channelId)) errors[`sm${i}`] = "Each channel can have only one slowmode.";
    seen.add(r.channelId);
    errors[`sms${i}`] = rangeError(r.seconds, 1, 21600, "Slowmode seconds");
  });
  return errors;
}

// --- Auto purge editor ----------------------------------------------------------

function minuteToText(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function textToMinute(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "04:00 UTC is 9:00 PM your time" */
function localHint(minute: number): string {
  const d = new Date();
  d.setUTCHours(Math.floor(minute / 60), minute % 60, 0, 0);
  return `${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} your time`;
}

function describeSchedule(p: AutomodplusPurge): string {
  return p.mode === AutomodplusPurgeMode.DAILY
    ? `Daily at ${minuteToText(p.dailyMinuteUtc)} UTC`
    : `Every ${p.everyHours === 1 ? "hour" : `${p.everyHours} hours`}`;
}

const PurgeEditor: React.FC<{
  initial: AutomodplusPurge | null;
  onClose: () => void;
  onSaved: (rules: AutomodplusChannelRules) => void;
}> = ({ initial, onClose, onSaved }) => {
  const [channelId, setChannelId] = useState<string | undefined>(initial?.channelId);
  const [mode, setMode] = useState<AutomodplusPurgeMode>(initial?.mode ?? AutomodplusPurgeMode.DAILY);
  const [everyHours, setEveryHours] = useState(initial?.everyHours || 24);
  const [time, setTime] = useState(minuteToText(initial?.dailyMinuteUtc ?? 240));
  const [keepPinned, setKeepPinned] = useState(initial?.keepPinned ?? true);
  const save = useAction((req: AutomodplusPurgeSave) => automodplusServiceClient.savePurge(req), { success: "Auto purge saved" });

  const minute = textToMinute(time);
  const errors = {
    channel: channelId ? undefined : "Pick a channel.",
    hours: mode === AutomodplusPurgeMode.INTERVAL ? rangeError(everyHours, 1, 720, "Hours") : undefined,
    time: mode === AutomodplusPurgeMode.DAILY && minute === undefined ? "Use a 24-hour time like 04:00." : undefined,
  };
  const invalid = firstError(errors);

  const submit = async () => {
    if (invalid || !channelId) return;
    const result = await save.run({
      id: initial?.id ?? 0,
      channelId,
      mode,
      everyHours,
      dailyMinuteUtc: minute ?? 0,
      keepPinned,
    });
    if (result) onSaved(result);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? "Edit auto purge" : "New auto purge"}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={save.busy} disabled={!!invalid}>
            Save
          </Button>
        </>
      }
    >
      <Stack gap={14}>
        <Field label="Channel">
          <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel" />
        </Field>
        <Field label="How often">
          <Select
            value={mode}
            onChange={(m: AutomodplusPurgeMode) => setMode(m)}
            options={[
              { value: AutomodplusPurgeMode.DAILY, label: "Every day at a set time" },
              { value: AutomodplusPurgeMode.INTERVAL, label: "Every few hours" },
            ]}
          />
        </Field>
        {mode === AutomodplusPurgeMode.INTERVAL ? (
          <Field label="Every" error={errors.hours}>
            <NumberInput value={everyHours} onChange={setEveryHours} min={1} max={720} suffix="hours" />
          </Field>
        ) : (
          <Field label="At (UTC)" error={errors.time} help={minute !== undefined ? localHint(minute) : undefined}>
            <TextInput value={time} onChange={setTime} placeholder="04:00" />
          </Field>
        )}
        <Toggle checked={keepPinned} onChange={setKeepPinned} label="Keep pinned messages" />
        <p className={styles.hint}>
          Everything else in the channel is deleted, one message at a time (Root allows about 5 a second). Each run
          removes up to 1,000 messages and continues a few minutes later if there are more.
        </p>
      </Stack>
    </Modal>
  );
};

// --- Page -------------------------------------------------------------------------

const ChannelRules: React.FC = () => {
  const channels = useChannels();
  const form = useDraftForm<ListRules>(async () => {
    const r = await automodplusServiceClient.getChannelRules();
    return { autoDelete: r.autoDelete, slowmode: r.slowmode };
  }, "automodplus:channels");
  const purges = useRpc(() => automodplusServiceClient.getChannelRules());
  useBroadcast(automodplusServiceClient, AutomodplusServiceClientEvent.AutomodplusChanged, () => void purges.reload(), {
    filter: (e) => e.area === "automodplus:channels",
  });

  const [editing, setEditing] = useState<AutomodplusPurge | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<AutomodplusPurge | undefined>(undefined);
  const remove = useAction((id: number) => automodplusServiceClient.deletePurge({ id }), { success: "Auto purge removed" });
  const runNow = useAction((id: number) => automodplusServiceClient.runPurge({ id }), {
    success: "Purge started. It may take a minute.",
  });

  const d = form.draft;
  const errors = listErrors(d);
  const channelName = (id: string) => {
    const c = channels.byId.get(id);
    return c ? `#${c.name}` : channels.loading ? "…" : "Unknown channel";
  };

  const columns: Column<AutomodplusPurge>[] = [
    { key: "channel", header: "Channel", render: (p) => channelName(p.channelId) },
    { key: "schedule", header: "Schedule", render: (p) => `${describeSchedule(p)}${p.keepPinned ? "" : " · pins too"}` },
    { key: "next", header: "Next run", hideOnMobile: true, render: (p) => formatDateTime(p.nextRunAtMs) },
    {
      key: "last",
      header: "Last run",
      hideOnMobile: true,
      render: (p) =>
        p.lastRunAtMs ? (
          `${formatRelative(p.lastRunAtMs)} · ${p.lastDeleted} deleted`
        ) : (
          <span className={styles.muted}>Never</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "120px",
      render: (p) => (
        <div className={styles.rowEnd} onClick={(e) => e.stopPropagation()}>
          <IconButton icon="refresh" label="Run now" onClick={() => void runNow.run(p.id)} loading={runNow.busy} />
          <IconButton icon="edit" label="Edit" onClick={() => setEditing(p)} />
          <IconButton icon="trash" label="Delete" danger onClick={() => setDeleting(p)} />
        </div>
      ),
    },
  ];

  return (
    <Stack>
      <PageHeader
        title="Channel rules"
        description="Keep channels on topic, slow them down, or clear them out on a schedule."
      />
      {d ? (
        <>
          <DraftNotices form={form} />
          <Card
            title="Auto delete"
            description="Delete messages that aren't the right kind for a channel, and/or every message after a while."
            actions={
              <Button
                size="sm"
                icon="plus"
                onClick={() =>
                  form.set((x) => ({
                    ...x,
                    autoDelete: [
                      ...x.autoDelete,
                      { channelId: "", allow: AutomodplusAllowType.IMAGES, deleteAfterMinutes: 0, exemptStaff: true },
                    ],
                  }))
                }
                disabled={d.autoDelete.length >= 50}
              >
                Add channel
              </Button>
            }
          >
            {d.autoDelete.length === 0 ? (
              <EmptyState compact title="No auto delete rules" description="Add a channel to keep it for pictures, links or commands." />
            ) : (
              d.autoDelete.map((r, i) => {
                const change = (c: Partial<typeof r>) =>
                  form.set((x) => ({ ...x, autoDelete: x.autoDelete.map((y, j) => (j === i ? { ...y, ...c } : y)) }));
                return (
                  <div className={styles.ruleRow} key={i}>
                    <Field label="Channel" error={errors[`ad${i}`] ?? errors[`adn${i}`]}>
                      <ChannelSelect value={r.channelId || undefined} onChange={(channelId) => change({ channelId: channelId ?? "" })} placeholder="Pick a channel" />
                    </Field>
                    <Field label="Allow">
                      <Select value={r.allow} onChange={(allow: AutomodplusAllowType) => change({ allow })} options={ALLOW_OPTIONS} />
                    </Field>
                    <Field label="Delete after" help="0 = keep" error={errors[`adm${i}`]}>
                      <NumberInput value={r.deleteAfterMinutes} onChange={(deleteAfterMinutes) => change({ deleteAfterMinutes })} min={0} suffix="min" />
                    </Field>
                    <div className={styles.rowEnd}>
                      <Toggle checked={r.exemptStaff} onChange={(exemptStaff) => change({ exemptStaff })} label="Staff exempt" />
                      <IconButton
                        icon="trash"
                        label="Remove"
                        danger
                        onClick={() => form.set((x) => ({ ...x, autoDelete: x.autoDelete.filter((_, j) => j !== i) }))}
                      />
                    </div>
                  </div>
                );
              })
            )}
            <p className={styles.hint} style={{ marginTop: 10 }}>
              Timed deletion keeps pinned messages (pin one to keep it) and runs about once a minute.
            </p>
          </Card>

          <Card
            title="Slowmode"
            description="Members must wait between messages. Root has no built-in slowmode, so messages sent too soon are deleted with a short notice. Staff are exempt."
            actions={
              <Button
                size="sm"
                icon="plus"
                onClick={() => form.set((x) => ({ ...x, slowmode: [...x.slowmode, { channelId: "", seconds: 30 }] }))}
                disabled={d.slowmode.length >= 50}
              >
                Add channel
              </Button>
            }
          >
            {d.slowmode.length === 0 ? (
              <EmptyState compact title="No slowmode channels" />
            ) : (
              d.slowmode.map((r, i) => {
                const change = (c: Partial<typeof r>) =>
                  form.set((x) => ({ ...x, slowmode: x.slowmode.map((y, j) => (j === i ? { ...y, ...c } : y)) }));
                return (
                  <div className={styles.slowRow} key={i}>
                    <Field label="Channel" error={errors[`sm${i}`]}>
                      <ChannelSelect value={r.channelId || undefined} onChange={(channelId) => change({ channelId: channelId ?? "" })} placeholder="Pick a channel" />
                    </Field>
                    <Field label="One message every" error={errors[`sms${i}`]}>
                      <NumberInput value={r.seconds} onChange={(seconds) => change({ seconds })} min={1} max={21600} suffix="seconds" />
                    </Field>
                    <div className={styles.rowEnd}>
                      <IconButton
                        icon="trash"
                        label="Remove"
                        danger
                        onClick={() => form.set((x) => ({ ...x, slowmode: x.slowmode.filter((_, j) => j !== i) }))}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </>
      ) : form.loadError ? (
        <ErrorState message={form.loadError} onRetry={() => void form.reload()} />
      ) : (
        <Spinner block label="Loading channel rules…" />
      )}

      <Card
        title="Auto purge"
        description="Clear a channel on a schedule, like a daily reset for #lfg."
        padded={false}
        actions={
          <Button size="sm" icon="plus" onClick={() => setEditing(null)}>
            Add auto purge
          </Button>
        }
      >
        {purges.error && !purges.data ? (
          <ErrorState compact message={purges.error} onRetry={() => void purges.reload()} />
        ) : (
          <Table
            columns={columns}
            rows={purges.data?.purges ?? []}
            rowKey={(p) => p.id}
            loading={purges.loading && !purges.data}
            empty={<EmptyState compact icon="🧹" title="No auto purges" description="Add one to clear a channel regularly." />}
          />
        )}
      </Card>

      <UnsavedBar
        dirty={form.dirty}
        saving={form.saving}
        invalid={firstError(errors)}
        onSave={() =>
          void form.save(async (x) => {
            const r = await automodplusServiceClient.updateChannelRules(x);
            return { autoDelete: r.autoDelete, slowmode: r.slowmode };
          })
        }
        onDiscard={form.discard}
      />

      {editing !== undefined && (
        <PurgeEditor
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(r) => {
            purges.setData(r);
            setEditing(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this auto purge?"
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => {
          if (!deleting) return;
          void remove.run(deleting.id).then((r) => {
            if (r) purges.setData(r);
            setDeleting(undefined);
          });
        }}
        message={deleting && `${channelName(deleting.channelId)} will no longer be purged (${describeSchedule(deleting).toLowerCase()}).`}
      />
    </Stack>
  );
};

export default ChannelRules;
