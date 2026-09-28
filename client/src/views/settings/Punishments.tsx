import React, { useState } from "react";
import { PunishmentType, WarnAction } from "@taproot/gen-shared";
import { moderationServiceClient, ModerationServiceClientEvent } from "@taproot/gen-client";
import styles from "./Settings.module.css";
import {
  Badge,
  Banner,
  Button,
  Card,
  Column,
  ConfirmDialog,
  DurationInput,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Modal,
  NumberInput,
  PageHeader,
  Row,
  Select,
  Stack,
  Table,
} from "../../components";
import { PUNISHMENT_LABEL, formatDuration, plural, useAction, useBroadcast, useRpc } from "../../lib";

// Automatic punishments when a member reaches a number of active warnings
// (!warnpunish). Limits match setWarnAction in moderationService.ts: count
// 1-100, duration up to 5 years (0 = indefinite/permanent, ignored for kick).

const MAX_COUNT = 100;
const MAX_DURATION = 5 * 365 * 24 * 60 * 60 * 1000;
const PRESETS = [60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

const ACTIONS = [PunishmentType.MUTE, PunishmentType.KICK, PunishmentType.BAN].map((value) => ({
  value,
  label: PUNISHMENT_LABEL[value],
}));

const TONE: Partial<Record<PunishmentType, "warning" | "danger">> = {
  [PunishmentType.MUTE]: "warning",
  [PunishmentType.KICK]: "danger",
  [PunishmentType.BAN]: "danger",
};

function describe(rule: WarnAction): string {
  if (rule.action === PunishmentType.KICK) return "Kick";
  const verb = rule.action === PunishmentType.MUTE ? "Mute" : "Ban";
  if (!rule.durationMs) return rule.action === PunishmentType.MUTE ? "Mute indefinitely" : "Ban permanently";
  return `${verb} for ${formatDuration(rule.durationMs)}`;
}

interface Draft {
  warnCount: number;
  action: PunishmentType;
  /** undefined while the typed duration is invalid. */
  durationMs: number | undefined;
}

/** Add/edit dialog. `original` is the rule being edited, if any. */
const RuleDialog: React.FC<{
  open: boolean;
  original: WarnAction | undefined;
  rules: WarnAction[];
  onClose: () => void;
  onSaved: (rules: WarnAction[]) => void;
}> = ({ open, original, rules, onClose, onSaved }) => {
  const nextCount = () => {
    for (let n = 3; n <= MAX_COUNT; n++) if (!rules.some((r) => r.warnCount === n)) return n;
    return 1;
  };
  const [draft, setDraft] = useState<Draft>(() =>
    original ? { ...original } : { warnCount: nextCount(), action: PunishmentType.MUTE, durationMs: 60 * 60 * 1000 },
  );

  const save = useAction(
    async (d: Draft) => {
      const saved = await moderationServiceClient.setWarnAction({
        warnCount: d.warnCount,
        action: d.action,
        durationMs: d.action === PunishmentType.KICK ? 0 : (d.durationMs ?? 0),
      });
      // Changing the count moves the rule: drop the old one.
      if (original && original.warnCount !== d.warnCount) {
        return (await moderationServiceClient.deleteWarnAction({ warnCount: original.warnCount })).actions;
      }
      return saved.actions;
    },
    { success: (): string => (original ? "Punishment updated" : "Punishment added"), toastError: false },
  );

  const countError =
    !Number.isInteger(draft.warnCount) || draft.warnCount < 1 || draft.warnCount > MAX_COUNT
      ? `Warning count must be a whole number from 1 to ${MAX_COUNT}.`
      : undefined;
  const hasDuration = draft.action !== PunishmentType.KICK;
  const durationError = hasDuration && draft.durationMs === undefined ? "That duration isn't valid." : undefined;
  const clash = rules.find((r) => r.warnCount === draft.warnCount && r.warnCount !== original?.warnCount);
  const invalid = !!countError || !!durationError;

  const submit = async () => {
    if (invalid) return;
    const result = await save.run(draft);
    if (result) {
      onSaved(result);
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!save.busy}
      size="sm"
      title={original ? `At ${plural(original.warnCount, "warning")}` : "Add a punishment"}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={save.busy} disabled={invalid}>
            {clash ? "Replace" : "Save"}
          </Button>
        </>
      }
    >
      <Stack>
        <Field label="When a member reaches" error={countError}>
          <NumberInput
            value={draft.warnCount}
            onChange={(warnCount) => setDraft((d) => ({ ...d, warnCount }))}
            min={1}
            max={MAX_COUNT}
            suffix="active warnings"
          />
        </Field>
        <Field label="Taproot will">
          <Select value={draft.action} onChange={(action) => setDraft((d) => ({ ...d, action }))} options={ACTIONS} />
        </Field>
        {hasDuration && (
          <Field
            label="For"
            error={durationError}
            help={draft.action === PunishmentType.MUTE ? "Leave empty to mute until a moderator unmutes." : "Leave empty to ban permanently."}
          >
            <DurationInput
              value={draft.durationMs}
              onChange={(durationMs) => setDraft((d) => ({ ...d, durationMs }))}
              emptyLabel={draft.action === PunishmentType.MUTE ? "Indefinite" : "Permanent"}
              presets={PRESETS}
              max={MAX_DURATION}
            />
          </Field>
        )}
        {clash && (
          <Banner tone="warning">
            There's already a rule at {plural(clash.warnCount, "warning")} ({describe(clash).toLowerCase()}). Saving replaces
            it.
          </Banner>
        )}
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
    </Modal>
  );
};

const Punishments: React.FC = () => {
  const list = useRpc(() => moderationServiceClient.listWarnActions());
  // Threshold changes (here, another admin, or the warnpunish command) arrive
  // as CasesChanged with area "punishments".
  useBroadcast(moderationServiceClient, ModerationServiceClientEvent.CasesChanged, () => void list.reload(), {
    filter: (event) => event.area === "punishments",
  });
  const rules = list.data?.actions ?? [];
  // `key` remounts the dialog so its draft starts fresh each time it opens.
  const [editing, setEditing] = useState<{ key: number; rule: WarnAction | undefined } | undefined>(undefined);
  const [deleting, setDeleting] = useState<WarnAction | undefined>(undefined);

  const remove = useAction((warnCount: number) => moderationServiceClient.deleteWarnAction({ warnCount }), {
    success: "Punishment removed",
  });

  const open = (rule: WarnAction | undefined) => setEditing({ key: Date.now(), rule });

  const columns: Column<WarnAction>[] = [
    {
      key: "count",
      header: "Warnings",
      width: "120px",
      render: (r) => <strong>{plural(r.warnCount, "warning")}</strong>,
    },
    {
      key: "action",
      header: "Punishment",
      render: (r) => <Badge tone={TONE[r.action]}>{PUNISHMENT_LABEL[r.action]}</Badge>,
    },
    {
      key: "duration",
      header: "Duration",
      render: (r) =>
        r.action === PunishmentType.KICK ? (
          <span className="tp-subtle">—</span>
        ) : r.durationMs ? (
          formatDuration(r.durationMs)
        ) : (
          <span className="tp-muted">{r.action === PunishmentType.MUTE ? "Indefinite" : "Permanent"}</span>
        ),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "96px",
      render: (r) => (
        <Row gap={4} justify="end" wrap={false}>
          <IconButton icon="edit" label={`Edit the rule at ${r.warnCount} warnings`} onClick={(e) => { e.stopPropagation(); open(r); }} />
          <IconButton
            icon="trash"
            danger
            label={`Delete the rule at ${r.warnCount} warnings`}
            onClick={(e) => {
              e.stopPropagation();
              setDeleting(r);
            }}
          />
        </Row>
      ),
    },
  ];

  return (
    <Stack>
      <PageHeader
        title="Punishments"
        description="Punish members automatically when their active warnings reach a count. Voided warnings don't count."
        actions={
          <>
            <Button icon="refresh" onClick={() => void list.reload()} loading={list.loading && !!list.data}>
              Refresh
            </Button>
            <Button variant="primary" icon="plus" onClick={() => open(undefined)} disabled={!list.data}>
              Add punishment
            </Button>
          </>
        }
      />
      {list.error && !list.data ? (
        <ErrorState message={list.error} onRetry={() => void list.reload()} />
      ) : (
        <Card padded={false}>
          <Table
            columns={columns}
            rows={rules}
            rowKey={(r) => r.warnCount}
            onRowClick={(r) => open(r)}
            loading={list.loading}
            empty={
              <EmptyState
                icon="gavel"
                title="No automatic punishments"
                description="Warnings are recorded, but nothing else happens when they pile up."
                action={
                  <Button variant="primary" icon="plus" onClick={() => open(undefined)}>
                    Add punishment
                  </Button>
                }
              />
            }
          />
        </Card>
      )}
      <p className={styles.hint}>
        The punishment runs when a warning brings the member to exactly that count, so a rule at 3 and another at 5 escalate
        from one to the other.
      </p>

      {editing && (
        <RuleDialog
          key={editing.key}
          open
          original={editing.rule}
          rules={rules}
          onClose={() => setEditing(undefined)}
          onSaved={(actions) => list.setData({ actions })}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={deleting ? `Delete the rule at ${plural(deleting.warnCount, "warning")}?` : ""}
        message={deleting ? `Members reaching ${plural(deleting.warnCount, "warning")} will no longer be punished automatically (${describe(deleting).toLowerCase()}).` : undefined}
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.run(deleting.warnCount);
          if (result) list.setData(result);
          setDeleting(undefined);
        }}
      />
    </Stack>
  );
};

export default Punishments;
