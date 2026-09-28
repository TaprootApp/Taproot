import React, { useState } from "react";
import { moderationServiceClient } from "@taproot/gen-client";
import { CaseAction, ModCase } from "@taproot/gen-shared";
import { Badge, Column, ConfirmDialog, Field, IconButton, Modal, Button, Table, TextArea } from "../../components";
import { CASE_ACTION_LABEL, CASE_ACTION_TONE, formatDateTime, formatDuration, formatRelative, useAction } from "../../lib";
import { MemberLink } from "./MemberLink";
import styles from "./moderation.module.css";

// The case log table shared by Overview, Cases and a member's recent cases,
// with optional per-case actions (edit reason, void warning).

/** Purge/lock/unlock cases target a channel, not a member. */
export function isChannelAction(action: CaseAction): boolean {
  return action === CaseAction.PURGE || action === CaseAction.LOCK || action === CaseAction.UNLOCK;
}

/**
 * Channel cases keep the mod log's Markdown as their name ("[#general](root://channel/…)"
 * or "the **Staff** channel group"); show it as plain text.
 */
function channelCaseLabel(c: ModCase): string {
  const plain = (c.userName || "").replace(/\[([^\]]*)\]\(root:\/\/[^)\s]*\)/g, "$1").replace(/\*\*/g, "").trim();
  if (!plain) return `#${c.userId}`;
  return /^(#|the )/.test(plain) ? plain : `#${plain}`;
}

export interface CaseTableProps {
  cases: ModCase[];
  loading?: boolean;
  empty?: React.ReactNode;
  /** Show the edit-reason / void-warning buttons. */
  actions?: boolean;
  /** Hide the member column (a single member's history). */
  hideMember?: boolean;
  /** Called with the server's copy after an edit or void. */
  onCaseChanged?: (updated: ModCase) => void;
}

export const CaseTable: React.FC<CaseTableProps> = ({ cases, loading, empty, actions, hideMember, onCaseChanged }) => {
  const [editing, setEditing] = useState<ModCase | undefined>();
  const [voiding, setVoiding] = useState<ModCase | undefined>();

  const columns: Column<ModCase>[] = [
    {
      key: "id",
      header: "#",
      width: "56px",
      render: (c) => <span className={styles.caseId}>{c.id}</span>,
    },
    {
      key: "action",
      header: "Action",
      width: "110px",
      render: (c) => (
        <Badge tone={c.voided ? "neutral" : CASE_ACTION_TONE[c.action]} title={c.voided ? "Voided" : undefined}>
          <span className={c.voided ? styles.voided : undefined}>{CASE_ACTION_LABEL[c.action]}</span>
        </Badge>
      ),
    },
  ];
  if (!hideMember) {
    columns.push({
      key: "member",
      header: "Member",
      render: (c) =>
        isChannelAction(c.action) ? (
          <span className="tp-muted">{channelCaseLabel(c)}</span>
        ) : (
          <MemberLink userId={c.userId} name={c.userName} />
        ),
    });
  }
  columns.push(
    {
      key: "reason",
      header: "Reason",
      wrap: true,
      render: (c) => (
        <span className={c.voided ? styles.voided : styles.reason}>
          {c.reason || <span className="tp-subtle">No reason given</span>}
          {c.durationMs > 0 && <span className="tp-subtle"> · {formatDuration(c.durationMs)}</span>}
          {c.voided && <span className="tp-subtle"> (voided)</span>}
        </span>
      ),
    },
    {
      key: "moderator",
      header: "By",
      hideOnMobile: true,
      render: (c) =>
        c.moderatorId ? (
          <MemberLink userId={c.moderatorId} name={c.moderatorName} />
        ) : (
          <span className="tp-muted">{c.moderatorName || "Taproot"}</span>
        ),
    },
    {
      key: "when",
      header: "When",
      width: "96px",
      hideOnMobile: true,
      render: (c) => <span title={formatDateTime(c.createdAtMs)}>{formatRelative(c.createdAtMs)}</span>,
    },
  );
  if (actions) {
    columns.push({
      key: "actions",
      header: "",
      width: "80px",
      align: "right",
      render: (c) => (
        <span className={styles.rowActions}>
          <IconButton icon="edit" label={`Edit reason for case #${c.id}`} onClick={() => setEditing(c)} />
          {c.action === CaseAction.WARN && !c.voided && (
            <IconButton icon="trash" danger label={`Void warning #${c.id}`} onClick={() => setVoiding(c)} />
          )}
        </span>
      ),
    });
  }

  return (
    <>
      <Table columns={columns} rows={cases} rowKey={(c) => c.id} loading={loading} empty={empty} />
      {editing && (
        <EditReasonDialog
          modCase={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(c) => {
            setEditing(undefined);
            onCaseChanged?.(c);
          }}
        />
      )}
      <VoidWarningDialog
        modCase={voiding}
        onClose={() => setVoiding(undefined)}
        onVoided={(c) => {
          setVoiding(undefined);
          onCaseChanged?.(c);
        }}
      />
    </>
  );
};

const EditReasonDialog: React.FC<{ modCase: ModCase; onClose: () => void; onSaved: (c: ModCase) => void }> = ({
  modCase,
  onClose,
  onSaved,
}) => {
  const [reason, setReason] = useState(modCase.reason);
  const save = useAction(
    () => moderationServiceClient.updateCaseReason({ caseId: modCase.id, reason: reason.trim() }),
    { success: `Updated the reason for case #${modCase.id}.` },
  );
  const blank = reason.trim() === "";
  const submit = async () => {
    if (blank) return;
    const updated = await save.run();
    if (updated) onSaved(updated);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit reason for case #${modCase.id}`}
      size="sm"
      dismissible={!save.busy}
      footer={
        <>
          <Button onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={save.busy} disabled={blank}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Reason" error={save.error}>
        {/* The server keeps 500 characters (updateReason in server/src/modlog.ts). */}
        <TextArea value={reason} onChange={setReason} rows={3} maxLength={500} showCount={false} />
      </Field>
    </Modal>
  );
};

const VoidWarningDialog: React.FC<{
  modCase: ModCase | undefined;
  onClose: () => void;
  onVoided: (c: ModCase) => void;
}> = ({ modCase, onClose, onVoided }) => {
  const voidIt = useAction((id: number) => moderationServiceClient.voidWarning({ id }), {
    success: (c) => `Voided warning #${c.id}.`,
  });
  return (
    <ConfirmDialog
      open={!!modCase}
      title={modCase ? `Void warning #${modCase.id}?` : "Void warning?"}
      message={
        modCase
          ? `It stays in the log struck through, but no longer counts toward ${modCase.userName || "the member"}'s warnings or automatic punishments.`
          : undefined
      }
      confirmLabel="Void warning"
      danger
      busy={voidIt.busy}
      onCancel={onClose}
      onConfirm={async () => {
        if (!modCase) return;
        const updated = await voidIt.run(modCase.id);
        if (updated) onVoided(updated);
      }}
    />
  );
};
