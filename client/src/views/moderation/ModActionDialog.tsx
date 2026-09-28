import React, { useEffect, useState } from "react";
import { moderationServiceClient } from "@taproot/gen-client";
import type { ActionResult, ModActionRequest } from "@taproot/gen-shared";
import { ConfirmDialog, DurationInput, Field, TextArea } from "../../components";
import { useAction } from "../../lib";

// One dialog for every member action (warn, mute, unmute, kick, ban, unban),
// with a reason box and, for mute and ban, a duration. The server applies
// the same rank rules as the text commands; its refusals show inline.

export type ModActionKind = "warn" | "mute" | "unmute" | "kick" | "ban" | "unban";

export interface ModTarget {
  userId: string;
  nickname: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Matches MAX_DURATION in server/src/services/moderationService.ts.
const MAX_DURATION = 5 * 365 * DAY;
// Matches MAX_BAN_REASON in server/src/features/modActions.ts (Root's limit).
const MAX_BAN_REASON = 256;
// Case reasons are kept to 500 characters (createCase in server/src/modlog.ts).
const MAX_REASON = 500;

interface KindSpec {
  verb: string;
  message: (name: string) => string;
  danger: boolean;
  reasonRequired: boolean;
  duration?: { emptyLabel: string; presets: number[]; help: string };
  maxReason: number;
  call: (request: ModActionRequest) => Promise<ActionResult>;
}

const SPECS: Record<ModActionKind, KindSpec> = {
  warn: {
    verb: "Warn",
    message: () => `The warning is logged as a case. Enough warnings can trigger an automatic punishment.`,
    danger: false,
    reasonRequired: true,
    maxReason: MAX_REASON,
    call: (r) => moderationServiceClient.warn(r),
  },
  mute: {
    verb: "Mute",
    message: (n) => `${n} won't be able to send messages until unmuted or the mute runs out.`,
    danger: true,
    reasonRequired: false,
    duration: {
      emptyLabel: "Indefinite",
      presets: [10 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY],
      help: "Leave empty to mute until someone unmutes them.",
    },
    maxReason: MAX_REASON,
    call: (r) => moderationServiceClient.mute(r),
  },
  unmute: {
    verb: "Unmute",
    message: (n) => `${n} will be able to talk again.`,
    danger: false,
    reasonRequired: false,
    maxReason: MAX_REASON,
    call: (r) => moderationServiceClient.unmute(r),
  },
  kick: {
    verb: "Kick",
    message: (n) => `${n} is removed from the community but can rejoin with an invite.`,
    danger: true,
    reasonRequired: false,
    maxReason: MAX_REASON,
    call: (r) => moderationServiceClient.kick(r),
  },
  ban: {
    verb: "Ban",
    message: (n) => `${n} is removed from the community and can't rejoin while banned.`,
    danger: true,
    reasonRequired: false,
    duration: {
      emptyLabel: "Permanent",
      presets: [DAY, 7 * DAY, 30 * DAY],
      help: "Leave empty for a permanent ban.",
    },
    maxReason: MAX_BAN_REASON,
    call: (r) => moderationServiceClient.ban(r),
  },
  unban: {
    verb: "Unban",
    message: (n) => `${n} will be able to rejoin the community.`,
    danger: false,
    reasonRequired: false,
    maxReason: MAX_REASON,
    call: (r) => moderationServiceClient.unban(r),
  },
};

export interface ModActionDialogProps {
  /** Which action; undefined keeps the dialog closed. */
  kind: ModActionKind | undefined;
  target: ModTarget | undefined;
  onClose: () => void;
  /** Called after the server accepted the action (the result is already toasted). */
  onDone?: (result: ActionResult) => void;
}

export const ModActionDialog: React.FC<ModActionDialogProps> = ({ kind, target, onClose, onDone }) => {
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState<number | undefined>(0);
  // Server refusals show inside the dialog, not as a toast behind it.
  const action = useAction((spec: KindSpec, request: ModActionRequest) => spec.call(request), {
    success: (r) => r.message || "Done.",
    toastError: false,
  });

  const open = !!kind && !!target;
  useEffect(() => {
    // Fresh form each time the dialog opens.
    if (!open) return;
    setReason("");
    setDuration(0);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, target?.userId]);

  if (!kind || !target) return <ConfirmDialog open={false} title="" onConfirm={() => {}} onCancel={onClose} />;
  const spec = SPECS[kind];
  const name = target.nickname || "This member";
  const trimmed = reason.trim();
  const reasonMissing = spec.reasonRequired && trimmed === "";
  const tooLong = trimmed.length > spec.maxReason;
  const badDuration = !!spec.duration && duration === undefined;

  const submit = async () => {
    if (reasonMissing || tooLong || badDuration) return;
    const result = await action.run(spec, {
      userId: target.userId,
      reason: trimmed,
      durationMs: spec.duration ? duration ?? 0 : 0,
    });
    if (result) {
      onDone?.(result);
      onClose();
    }
  };

  return (
    <ConfirmDialog
      open
      title={`${spec.verb} ${name}?`}
      message={spec.message(name)}
      confirmLabel={spec.verb}
      danger={spec.danger}
      busy={action.busy}
      confirmDisabled={reasonMissing || tooLong || badDuration}
      onCancel={onClose}
      onConfirm={() => void submit()}
    >
      <Field
        label="Reason"
        hint={spec.reasonRequired ? "Required" : "Optional"}
        error={tooLong ? `Keep it under ${spec.maxReason} characters.` : action.error}
        help={kind === "ban" ? "Saved with the ban in Root and in the case log." : "Recorded in the case log and mod log."}
      >
        <TextArea
          value={reason}
          onChange={setReason}
          rows={2}
          maxLength={spec.maxReason}
          showCount={kind === "ban"}
          placeholder={spec.reasonRequired ? "What did they do?" : "Why?"}
        />
      </Field>
      {spec.duration && (
        <Field label="Duration" help={spec.duration.help}>
          <DurationInput
            value={duration}
            onChange={setDuration}
            emptyLabel={spec.duration.emptyLabel}
            presets={spec.duration.presets}
            max={MAX_DURATION}
          />
        </Field>
      )}
    </ConfirmDialog>
  );
};
