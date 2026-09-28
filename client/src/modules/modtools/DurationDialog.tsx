import React, { useEffect, useState } from "react";
import { modtoolsServiceClient } from "@taproot/gen-client";
import { ConfirmDialog, DurationInput, Field } from "../../components";
import { useAction } from "../../lib";
import { DAY, HOUR, MAX_CHANGED_DURATION } from "./shared";

// Change how long an active mute or temp ban has left (the "duration"
// command). Used from the Members page's mute and ban banners.

export interface DurationDialogProps {
  /** The mute or ban case; undefined keeps the dialog closed. */
  caseId: number | undefined;
  kind: "mute" | "ban";
  name: string;
  onClose: () => void;
  onDone?: () => void;
}

export const DurationDialog: React.FC<DurationDialogProps> = ({ caseId, kind, name, onClose, onDone }) => {
  const [duration, setDuration] = useState<number | undefined>(0);
  const action = useAction((id: number, ms: number) => modtoolsServiceClient.changeDuration({ caseId: id, durationMs: ms }), {
    success: (r) => r.message,
    toastError: false,
  });

  useEffect(() => {
    if (caseId === undefined) return;
    setDuration(0);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const submit = async () => {
    if (caseId === undefined || duration === undefined) return;
    if (await action.run(caseId, duration)) {
      onDone?.();
      onClose();
    }
  };

  const empty = kind === "mute" ? "Indefinite" : "Permanent";
  return (
    <ConfirmDialog
      open={caseId !== undefined}
      title={`Change ${name}'s ${kind === "mute" ? "mute" : "ban"} length`}
      message={
        kind === "mute"
          ? "The new length counts from now."
          : "The new length counts from now. Root can't edit a ban, so Taproot lifts it and bans again with the same reason; Root posts its usual ban notice."
      }
      confirmLabel="Change"
      busy={action.busy}
      confirmDisabled={duration === undefined}
      onCancel={onClose}
      onConfirm={() => void submit()}
    >
      <Field label="Ends in" help={`Leave empty for ${empty.toLowerCase()}.`} error={action.error}>
        <DurationInput
          value={duration}
          onChange={setDuration}
          emptyLabel={empty}
          presets={[HOUR, 6 * HOUR, DAY, 7 * DAY]}
          max={MAX_CHANGED_DURATION}
        />
      </Field>
    </ConfirmDialog>
  );
};
