import React, { useState } from "react";
import { modtoolsServiceClient } from "@taproot/gen-client";
import { ModtoolsNote, ModtoolsTempRole, ModtoolsVoiceAction, StaffLevel } from "@taproot/gen-shared";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DurationInput,
  ErrorState,
  Field,
  IconButton,
  RoleSelect,
  Row,
  Spinner,
  TextArea,
} from "../../components";
import { formatDateTime, formatRelative, useAction, useRpc, useSession } from "../../lib";
import { DAY, HOUR, MAX_NOTE, MAX_TEMP_ROLE, useModtoolsChanged } from "./shared";
import styles from "./modtools.module.css";

// Extra cards on a member's page (views/Members.tsx): staff notes, temp roles
// and voice actions. Everything is re-checked on the server.

export interface MemberCardsProps {
  userId: string;
  name: string;
  /** The viewer outranks the member (and it's not themself or a bot). */
  canAct: boolean;
  inCommunity: boolean;
}

export const MemberCards: React.FC<MemberCardsProps> = ({ userId, name, canAct, inCommunity }) => {
  const info = useRpc(() => modtoolsServiceClient.getMember({ userId }), [userId]);
  useModtoolsChanged(["notes", "temproles", "voice"], () => void info.reload());

  if (!info.data) {
    return (
      <Card title="Notes, temp roles and voice">
        {info.error ? (
          <ErrorState message={info.error} onRetry={() => void info.reload()} compact />
        ) : (
          <Spinner block label="Loading…" />
        )}
      </Card>
    );
  }
  const reload = () => void info.reload();
  return (
    <>
      <NotesCard userId={userId} name={name} notes={info.data.notes} onChanged={reload} />
      {(inCommunity || info.data.tempRoles.length > 0) && (
        <TempRolesCard userId={userId} name={name} rows={info.data.tempRoles} canAdd={canAct && inCommunity} onChanged={reload} />
      )}
      {inCommunity && (
        <VoiceCard
          userId={userId}
          name={name}
          canAct={canAct}
          muted={info.data.voiceMuted}
          channelName={info.data.voiceChannelName}
          onChanged={reload}
        />
      )}
    </>
  );
};

// --- Notes ---------------------------------------------------------------------

const NotesCard: React.FC<{ userId: string; name: string; notes: ModtoolsNote[]; onChanged: () => void }> = ({
  userId,
  name,
  notes,
  onChanged,
}) => {
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState<ModtoolsNote | undefined>();
  const add = useAction(() => modtoolsServiceClient.addNote({ userId, text: text.trim() }), { success: "Note added" });
  // deleteNote returns nothing, so resolve to true to tell success from failure.
  const remove = useAction((id: number) => modtoolsServiceClient.deleteNote({ id }).then(() => true), {
    success: "Note deleted",
  });
  const trimmed = text.trim();

  const submit = async () => {
    if (!trimmed || trimmed.length > MAX_NOTE) return;
    if (await add.run()) {
      setText("");
      onChanged();
    }
  };

  return (
    <Card title="Staff notes" description={`Private context about ${name}. Notes aren't cases, and members never see them.`}>
      {notes.length === 0 ? (
        <p className="tp-muted">No notes yet.</p>
      ) : (
        <ul className={styles.list}>
          {notes.map((n) => (
            <li key={n.id} className={styles.item}>
              <div className={styles.itemBody}>
                <p className={styles.noteText}>{n.text}</p>
                <div className={styles.meta}>
                  #{n.id} · {n.authorName || "Unknown"} ·{" "}
                  <span title={formatDateTime(n.createdAtMs)}>{formatRelative(n.createdAtMs)}</span>
                </div>
              </div>
              <IconButton icon="trash" label={`Delete note #${n.id}`} danger onClick={() => setDeleting(n)} />
            </li>
          ))}
        </ul>
      )}
      <div className={styles.adder}>
        <TextArea
          value={text}
          onChange={setText}
          rows={2}
          maxLength={MAX_NOTE}
          placeholder={`Add a note about ${name}…`}
          aria-label="New note"
        />
        <div className={styles.adderActions}>
          <Button icon="plus" onClick={() => void submit()} loading={add.busy} disabled={!trimmed}>
            Add note
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={!!deleting}
        title="Delete this note?"
        message="It's removed for every moderator. This can't be undone."
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (deleting && (await remove.run(deleting.id))) onChanged();
          setDeleting(undefined);
        }}
      />
    </Card>
  );
};

// --- Temp roles ------------------------------------------------------------------

const TempRolesCard: React.FC<{
  userId: string;
  name: string;
  rows: ModtoolsTempRole[];
  canAdd: boolean;
  onChanged: () => void;
}> = ({ userId, name, rows, canAdd, onChanged }) => {
  const { level } = useSession();
  const [roleId, setRoleId] = useState<string | undefined>();
  const [duration, setDuration] = useState<number | undefined>(DAY);
  const [ending, setEnding] = useState<ModtoolsTempRole | undefined>();
  const add = useAction(
    (r: string, ms: number) => modtoolsServiceClient.addTempRole({ userId, roleId: r, durationMs: ms }),
    { success: (res) => res.message },
  );
  const end = useAction((id: number) => modtoolsServiceClient.removeTempRole({ id }), { success: (res) => res.message });

  const submit = async () => {
    if (!roleId || !duration) return;
    if (await add.run(roleId, duration)) {
      setRoleId(undefined);
      onChanged();
    }
  };

  return (
    <Card title="Temp roles" description="Roles Taproot takes away again automatically.">
      {rows.length === 0 ? (
        <p className="tp-muted">No temp roles.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.id} className={styles.item}>
              <div className={styles.itemBody}>
                <Badge>{r.roleName || "Deleted role"}</Badge>
                <div className={styles.meta}>
                  Ends <span title={formatDateTime(r.expiresAtMs)}>{formatRelative(r.expiresAtMs)}</span> · given by{" "}
                  {r.addedByName || "Unknown"}
                </div>
              </div>
              {canAdd && (
                <IconButton icon="close" label={`Take ${r.roleName} back now`} danger onClick={() => setEnding(r)} />
              )}
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <div className={styles.inlineForm}>
          <Field label="Role">
            <RoleSelect
              value={roleId}
              onChange={setRoleId}
              excludePrivileged={level < StaffLevel.ADMIN}
              placeholder="Pick a role…"
            />
          </Field>
          <Field label="For">
            <DurationInput
              value={duration}
              onChange={setDuration}
              allowEmpty={false}
              presets={[HOUR, DAY, 7 * DAY, 30 * DAY]}
              max={MAX_TEMP_ROLE}
            />
          </Field>
          <div className={styles.formButton}>
            <Button icon="plus" onClick={() => void submit()} loading={add.busy} disabled={!roleId || !duration}>
              Give role
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!ending}
        title={`Take ${ending?.roleName || "the role"} back?`}
        message={`${name} loses the role now instead of when it runs out.`}
        confirmLabel="Take back"
        danger
        busy={end.busy}
        onCancel={() => setEnding(undefined)}
        onConfirm={async () => {
          if (ending && (await end.run(ending.id))) onChanged();
          setEnding(undefined);
        }}
      />
    </Card>
  );
};

// --- Voice ---------------------------------------------------------------------

const VoiceCard: React.FC<{
  userId: string;
  name: string;
  canAct: boolean;
  muted: boolean;
  channelName: string;
  onChanged: () => void;
}> = ({ userId, name, canAct, muted, channelName, onChanged }) => {
  const [confirmKick, setConfirmKick] = useState(false);
  const voice = useAction((action: ModtoolsVoiceAction) => modtoolsServiceClient.voiceAction({ userId, action }), {
    success: (res) => res.message,
  });
  const run = async (action: ModtoolsVoiceAction) => {
    if (await voice.run(action)) onChanged();
  };

  return (
    <Card title="Voice">
      <div className={styles.voiceStatus}>
        {channelName ? <Badge tone="brand">In {channelName}</Badge> : <span className="tp-muted">Not in voice</span>}
        {muted && <Badge tone="warning">Voice-muted</Badge>}
      </div>
      {canAct ? (
        <Row>
          {muted ? (
            <Button icon="mic" onClick={() => void run(ModtoolsVoiceAction.UNMUTE)} loading={voice.busy}>
              Voice unmute
            </Button>
          ) : (
            <Button icon="mute" onClick={() => void run(ModtoolsVoiceAction.MUTE)} loading={voice.busy}>
              Voice mute
            </Button>
          )}
          {channelName && (
            <Button icon="userX" variant="danger" onClick={() => setConfirmKick(true)} disabled={voice.busy}>
              Disconnect
            </Button>
          )}
        </Row>
      ) : (
        <p className="tp-muted">You can't take voice actions on {name}.</p>
      )}
      <p className="tp-subtle" style={{ marginTop: 10 }}>
        A voice mute is a server mute they can't undo, re-applied every time they join voice until it's lifted.
      </p>
      <ConfirmDialog
        open={confirmKick}
        title={`Disconnect ${name}?`}
        message={`${name} is removed from ${channelName || "voice"}. They can join again.`}
        confirmLabel="Disconnect"
        danger
        busy={voice.busy}
        onCancel={() => setConfirmKick(false)}
        onConfirm={async () => {
          await run(ModtoolsVoiceAction.KICK);
          setConfirmKick(false);
        }}
      />
    </Card>
  );
};
