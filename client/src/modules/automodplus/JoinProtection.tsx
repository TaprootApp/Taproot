import React, { useState } from "react";
import { AutomodplusJoinAction } from "@taproot/gen-shared";
import type { AutomodplusAutoban, AutomodplusJoinProtection, AutomodplusRaid } from "@taproot/gen-shared";
import { AutomodplusServiceClientEvent, automodplusServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ChannelMultiSelect,
  ConfirmDialog,
  ErrorState,
  Field,
  NumberInput,
  PageHeader,
  Select,
  Spinner,
  Stack,
  TextInput,
  Toggle,
} from "../../components";
import { formatDateTime, formatRelative, plural, useAction, useBroadcast, useRpc } from "../../lib";
import { TagList } from "../../views/settings/shared";
import { DraftNotices, UnsavedBar, firstError, rangeError, useDraftForm } from "./shared";
import styles from "./automodplus.module.css";

// Join protection (admins): Autoban (kick or ban new members by name or
// account age) and raid protection (lock channels and throttle joins when
// many people join at once). Same limits as the autoban and raid commands.

function parsePatterns(text: string): string[] | string {
  const out = text
    .split(/[,\n]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (out.some((p) => /^\*+$/.test(p))) return "A pattern needs at least one character besides *.";
  if (out.some((p) => p.length > 64)) return "Patterns can be at most 64 characters.";
  return out;
}

function errorsOf(d: Pick<AutomodplusJoinProtection, "autoban" | "raid"> | undefined): Record<string, string | undefined> {
  if (!d?.autoban || !d.raid) return {};
  const a = d.autoban;
  const r = d.raid;
  return {
    days: rangeError(a.minAccountDays, 0, 3650, "Account age"),
    reason: a.reason.length > 200 ? "The reason can be at most 200 characters." : undefined,
    joins: rangeError(r.joins, 2, 500, "Joins"),
    seconds: rangeError(r.seconds, 5, 3600, "Seconds"),
    throttleCount: rangeError(r.throttleCount, 1, 1000, "Throttle joins"),
    throttleWindow: rangeError(r.throttleWindowMinutes, 1, 1440, "Throttle minutes"),
    autoEnd: rangeError(r.autoEndMinutes, 0, 10080, "Auto end"),
  };
}

const RaidStatusCard: React.FC<{
  data: AutomodplusJoinProtection | undefined;
  onChanged: (d: AutomodplusJoinProtection) => void;
}> = ({ data, onChanged }) => {
  const s = data?.status;
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const toggle = useAction((active: boolean) => automodplusServiceClient.setRaidMode({ active, reason }), {
    success: (r) => (r.status?.active ? "Raid mode is on" : "Raid mode is off"),
  });
  const run = async (active: boolean) => {
    const result = await toggle.run(active);
    if (result) onChanged(result);
    setConfirm(false);
  };

  if (!data) {
    return (
      <Card>
        <Spinner label="Checking raid status…" />
      </Card>
    );
  }
  return (
    <Card>
      <div className={styles.status}>
        <div className={styles.statusText}>
          <span className={styles.statusTitle}>
            {s?.active ? "🚨 Raid mode is on" : "Raid mode is off"}{" "}
            {s?.active && <Badge tone="danger">Active</Badge>}
          </span>
          {s?.active ? (
            <>
              <span>
                Started {formatRelative(s.startedAtMs)}
                {s.reason ? ` · ${s.reason}` : ""}
              </span>
              <span>
                {plural(s.lockedCount, "channel")} locked · join throttle {s.throttled ? "tightened" : "unchanged"}
                {s.endsAtMs ? ` · ends ${formatDateTime(s.endsAtMs)}` : " · ends when you turn it off"}
              </span>
            </>
          ) : (
            <span>Start it by hand if a raid gets past detection. Moderators can also use the raid command.</span>
          )}
        </div>
        {s?.active ? (
          <Button variant="primary" onClick={() => void run(false)} loading={toggle.busy}>
            End raid mode
          </Button>
        ) : (
          <Button variant="danger" icon="alert" onClick={() => setConfirm(true)}>
            Start raid mode
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        title="Start raid mode?"
        confirmLabel="Start raid mode"
        danger
        busy={toggle.busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void run(true)}
      >
        <Stack gap={10}>
          <p className={styles.hint}>
            The channels picked below are locked and the join throttle is tightened (if turned on), until you end it
            {data?.raid?.autoEndMinutes ? ` or ${data.raid.autoEndMinutes} minutes pass` : ""}.
          </p>
          <Field label="Reason (optional)">
            <TextInput value={reason} onChange={setReason} placeholder="e.g. spam accounts joining" />
          </Field>
        </Stack>
      </ConfirmDialog>
    </Card>
  );
};

type Settings = Pick<AutomodplusJoinProtection, "autoban" | "raid">;

const JoinProtection: React.FC = () => {
  // The raid status changes on its own, so it's kept out of the form's draft.
  const form = useDraftForm<Settings>(async () => {
    const j = await automodplusServiceClient.getJoinProtection();
    return { autoban: j.autoban, raid: j.raid };
  }, "automodplus:join");
  const status = useRpc(() => automodplusServiceClient.getJoinProtection());
  useBroadcast(automodplusServiceClient, AutomodplusServiceClientEvent.AutomodplusChanged, () => void status.reload(), {
    filter: (e) => e.area === "automodplus:join",
  });
  const d = form.draft;
  const errors = errorsOf(d);

  if (!d?.autoban || !d.raid) {
    return (
      <Stack>
        <PageHeader title="Join protection" description="Stop raids and known bad accounts at the door." />
        {form.loadError ? (
          <ErrorState message={form.loadError} onRetry={() => void form.reload()} />
        ) : (
          <Spinner block label="Loading join protection…" />
        )}
      </Stack>
    );
  }
  const a = d.autoban;
  const r = d.raid;
  const patchAutoban = (c: Partial<AutomodplusAutoban>) => form.set((x) => ({ ...x, autoban: { ...x.autoban!, ...c } }));
  const patchRaid = (c: Partial<AutomodplusRaid>) => form.set((x) => ({ ...x, raid: { ...x.raid!, ...c } }));

  return (
    <Stack>
      <PageHeader title="Join protection" description="Stop raids and known bad accounts at the door." />
      <DraftNotices form={form} />
      <RaidStatusCard data={status.data} onChanged={status.setData} />

      <Card
        title="Autoban"
        description="Kick or ban new members as they join, by name or account age. Every one is logged as a case."
        actions={<Toggle checked={a.enabled} onChange={(enabled) => patchAutoban({ enabled })} ariaLabel="Autoban on/off" />}
      >
        <Stack gap={14} className={a.enabled ? undefined : styles.dimmed}>
          <Field label="Names" help="Matched anywhere in the name, ignoring case. * matches anything: free*nitro catches “Free Nitro Bot”.">
            <TagList
              value={a.namePatterns}
              onChange={(namePatterns) => patchAutoban({ namePatterns })}
              parse={parsePatterns}
              placeholder="Add a pattern"
              emptyText="No name patterns"
              mono
            />
          </Field>
          <Field
            label="Accounts younger than"
            help="0 = off. Root user IDs carry the time the account was made, so this is the account's age, not when they joined here."
            error={errors.days}
          >
            <NumberInput value={a.minAccountDays} onChange={(minAccountDays) => patchAutoban({ minAccountDays })} min={0} suffix="days" />
          </Field>
          <div className={styles.numbers}>
            <Field label="Action">
              <Select
                value={a.action}
                onChange={(action: AutomodplusJoinAction) => patchAutoban({ action })}
                options={[
                  { value: AutomodplusJoinAction.KICK, label: "Kick (they can rejoin)" },
                  { value: AutomodplusJoinAction.BAN, label: "Ban" },
                ]}
              />
            </Field>
            <Field label="Reason" help="Bans show it to the member." error={errors.reason}>
              <TextInput value={a.reason} onChange={(reason) => patchAutoban({ reason })} placeholder="Autoban" />
            </Field>
          </div>
        </Stack>
      </Card>

      <Card
        title="Raid detection"
        description="Turns raid mode on when many members join at once, and alerts the mod log."
        actions={<Toggle checked={r.enabled} onChange={(enabled) => patchRaid({ enabled })} ariaLabel="Raid detection on/off" />}
      >
        <Stack gap={14} className={r.enabled ? undefined : styles.dimmed}>
          <div className={styles.numbers}>
            <Field label="More than" error={errors.joins}>
              <NumberInput value={r.joins} onChange={(joins) => patchRaid({ joins })} min={2} suffix="joins" />
            </Field>
            <Field label="Within" error={errors.seconds}>
              <NumberInput value={r.seconds} onChange={(seconds) => patchRaid({ seconds })} min={5} suffix="seconds" />
            </Field>
          </div>
          {!r.enabled && <p className={styles.hint}>Off: raid mode only starts by hand. The settings below still apply then.</p>}
        </Stack>
      </Card>

      <Card title="During raid mode" description="What happens when raid mode starts, automatically or by hand.">
        <Stack gap={14}>
          <Field label="Lock these channels" help="Like the lock command: @everyone can't post. Unlocked again when raid mode ends.">
            <ChannelMultiSelect value={r.lockChannelIds} onChange={(lockChannelIds) => patchRaid({ lockChannelIds })} emptyText="Don't lock anything" />
          </Field>
          <Toggle
            checked={r.throttleEnabled}
            onChange={(throttleEnabled) => patchRaid({ throttleEnabled })}
            label="Tighten the join throttle"
            description="Sets Root's community join limit, and puts the previous one back afterwards."
          />
          {r.throttleEnabled && (
            <div className={styles.numbers}>
              <Field label="Allow" error={errors.throttleCount}>
                <NumberInput value={r.throttleCount} onChange={(throttleCount) => patchRaid({ throttleCount })} min={1} suffix="joins" />
              </Field>
              <Field label="Every" error={errors.throttleWindow}>
                <NumberInput
                  value={r.throttleWindowMinutes}
                  onChange={(throttleWindowMinutes) => patchRaid({ throttleWindowMinutes })}
                  min={1}
                  suffix="minutes"
                />
              </Field>
            </div>
          )}
          <Field label="End automatically after" help="0 = only when staff end it." error={errors.autoEnd}>
            <NumberInput value={r.autoEndMinutes} onChange={(autoEndMinutes) => patchRaid({ autoEndMinutes })} min={0} suffix="minutes" />
          </Field>
          {r.lockChannelIds.length === 0 && !r.throttleEnabled && (
            <Banner tone="info">Raid mode will only alert the mod log. Pick channels to lock or turn on the throttle.</Banner>
          )}
        </Stack>
      </Card>

      <UnsavedBar
        dirty={form.dirty}
        saving={form.saving}
        invalid={firstError(errors)}
        onSave={() =>
          void form.save((x) => automodplusServiceClient.updateJoinProtection({ autoban: x.autoban, raid: x.raid }))
        }
        onDiscard={form.discard}
      />
    </Stack>
  );
};

export default JoinProtection;
