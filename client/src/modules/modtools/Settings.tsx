import React, { useEffect, useState } from "react";
import { modtoolsServiceClient } from "@taproot/gen-client";
import type { ModtoolsConfig, ModtoolsTimedAutorole } from "@taproot/gen-shared";
import {
  Banner,
  Button,
  Card,
  DurationInput,
  ErrorState,
  Field,
  IconButton,
  PageHeader,
  RoleSelect,
  Row,
  Spinner,
  Stack,
  Toggle,
} from "../../components";
import { formatDuration, useAction, useRpc } from "../../lib";
import { DAY, HOUR, MAX_AUTOROLE_DELAY, MAX_TIMED_AUTOROLES, MINUTE, useModtoolsChanged } from "./shared";
import styles from "./modtools.module.css";

// Mod tools settings (admin): timed autoroles and member notifications.
// Limits match normalizeTimedAutoroles in server/src/modules/modtools/logic.ts.

/** A timed autorole row being edited; delay undefined while the text is invalid. */
interface DraftRule {
  roleId: string | undefined;
  delayMs: number | undefined;
}

interface Draft {
  rules: DraftRule[];
  notifyWarn: boolean;
  notifyMute: boolean;
  notifyKick: boolean;
  notifyBan: boolean;
}

function toDraft(c: ModtoolsConfig): Draft {
  return {
    rules: c.timedAutoroles.map((r) => ({ roleId: r.roleId, delayMs: r.delayMs })),
    notifyWarn: c.notifyWarn,
    notifyMute: c.notifyMute,
    notifyKick: c.notifyKick,
    notifyBan: c.notifyBan,
  };
}

function problem(d: Draft): string | undefined {
  if (d.rules.length > MAX_TIMED_AUTOROLES) return `At most ${MAX_TIMED_AUTOROLES} timed autoroles.`;
  if (d.rules.some((r) => !r.roleId)) return "Pick a role for every timed autorole.";
  if (d.rules.some((r) => r.delayMs === undefined || r.delayMs < MINUTE)) return "Each delay must be at least 1 minute.";
  const ids = d.rules.map((r) => r.roleId);
  if (new Set(ids).size !== ids.length) return "Each role can only be listed once.";
  return undefined;
}

const Settings: React.FC = () => {
  const config = useRpc(() => modtoolsServiceClient.getConfig());
  const [base, setBase] = useState<Draft | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);

  useEffect(() => {
    if (!config.data) return;
    const fresh = toDraft(config.data);
    setBase(fresh);
    // Keep unsaved edits when someone else saves meanwhile.
    setDraft((current) => (current && dirty ? current : fresh));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.data]);

  useModtoolsChanged(["config"], () => void config.reload());

  const save = useAction(
    (d: Draft) =>
      modtoolsServiceClient.updateConfig({
        timedAutoroles: d.rules.map((r): ModtoolsTimedAutorole => ({ roleId: r.roleId ?? "", delayMs: r.delayMs ?? 0 })),
        notifyWarn: d.notifyWarn,
        notifyMute: d.notifyMute,
        notifyKick: d.notifyKick,
        notifyBan: d.notifyBan,
      }),
    { success: "Settings saved" },
  );

  if (!draft) {
    return (
      <Stack>
        <PageHeader title="Mod tools" />
        {config.error ? <ErrorState message={config.error} onRetry={() => void config.reload()} /> : <Spinner block label="Loading settings…" />}
      </Stack>
    );
  }

  const patch = (change: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...change } : d));
  const setRule = (i: number, change: Partial<DraftRule>) =>
    patch({ rules: draft.rules.map((r, j) => (j === i ? { ...r, ...change } : r)) });
  const invalid = problem(draft);

  const onSave = async () => {
    const result = await save.run(draft);
    if (result) {
      const fresh = toDraft(result);
      setBase(fresh);
      setDraft(fresh);
    }
  };

  return (
    <Stack>
      <PageHeader title="Mod tools" description="Timed autoroles and member notifications for moderation actions." />
      {save.error && (
        <Banner tone="error" title="Couldn't save">
          {save.error}
        </Banner>
      )}

      <Card
        title="Timed autoroles"
        description="Roles given automatically some time after a member joins, like a Regular role after a day. Members who leave first don't get them."
      >
        <Stack gap={10}>
          {draft.rules.length === 0 && <p className="tp-muted">No timed autoroles.</p>}
          {draft.rules.map((rule, i) => (
            <div key={i} className={styles.ruleRow}>
              <div className={styles.ruleRole}>
                <Field label="Role">
                  <RoleSelect
                    value={rule.roleId}
                    onChange={(roleId) => setRule(i, { roleId })}
                    excludePrivileged
                    placeholder="Pick a role…"
                  />
                </Field>
              </div>
              <div className={styles.ruleDelay}>
                <Field label="After joining" help={rule.delayMs ? `Given ${formatDuration(rule.delayMs)} after they join.` : undefined}>
                  <DurationInput
                    value={rule.delayMs}
                    onChange={(delayMs) => setRule(i, { delayMs })}
                    allowEmpty={false}
                    presets={[10 * MINUTE, HOUR, DAY, 7 * DAY]}
                    max={MAX_AUTOROLE_DELAY}
                  />
                </Field>
              </div>
              <IconButton
                icon="trash"
                label="Remove this timed autorole"
                danger
                onClick={() => patch({ rules: draft.rules.filter((_, j) => j !== i) })}
              />
            </div>
          ))}
          <div>
            <Button
              icon="plus"
              onClick={() => patch({ rules: [...draft.rules, { roleId: undefined, delayMs: DAY }] })}
              disabled={draft.rules.length >= MAX_TIMED_AUTOROLES}
            >
              Add timed autorole
            </Button>
          </div>
          <p className={styles.hint}>
            Roles with staff permissions can't be given automatically. Timing is accurate to about a minute. Removing a
            rule also cancels grants still waiting for it.
          </p>
        </Stack>
      </Card>

      <Card
        title="Member notifications"
        description="Send the member a Root notification when a moderator acts on them. Off by default."
      >
        <Stack gap={12}>
          <Toggle checked={draft.notifyWarn} onChange={(notifyWarn) => patch({ notifyWarn })} label="Warnings" />
          <Toggle checked={draft.notifyMute} onChange={(notifyMute) => patch({ notifyMute })} label="Mutes" />
          <Toggle
            checked={draft.notifyKick}
            onChange={(notifyKick) => patch({ notifyKick })}
            label="Kicks"
            description="Root already notifies kicked members, and they may not receive Taproot's once they're gone."
          />
          <Toggle
            checked={draft.notifyBan}
            onChange={(notifyBan) => patch({ notifyBan })}
            label="Bans"
            description="Root already notifies banned members (with the ban reason)."
          />
          <p className={styles.hint}>
            Apps can't send direct messages on Root, so this is a push notification. It only says what happened and
            in which community, never the reason or who acted, because notifications show on lock screens.
          </p>
        </Stack>
      </Card>

      {dirty && (
        <Card>
          <Row justify="between" align="center">
            <span className="tp-muted">{invalid ?? "You have unsaved changes."}</span>
            <Row>
              <Button variant="quiet" onClick={() => base && setDraft(base)} disabled={save.busy}>
                Discard
              </Button>
              <Button variant="primary" onClick={() => void onSave()} loading={save.busy} disabled={!!invalid}>
                Save changes
              </Button>
            </Row>
          </Row>
        </Card>
      )}
    </Stack>
  );
};

export default Settings;
