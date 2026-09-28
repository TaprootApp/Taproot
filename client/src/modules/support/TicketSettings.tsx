import React, { useEffect, useState } from "react";
import type { SupportTicketConfig, SupportTicketSettings } from "@taproot/gen-shared";
import { SupportTranscriptMode } from "@taproot/gen-shared";
import { supportServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ChannelSelect,
  ConfirmDialog,
  ErrorState,
  Field,
  MessagePreview,
  NumberInput,
  PageHeader,
  RoleMultiSelect,
  Select,
  Spinner,
  Stack,
  TextArea,
  TextInput,
  Toggle,
} from "../../components";
import type { SelectOption } from "../../components";
import { useAction, useRpc, useSession } from "../../lib";
import settingsStyles from "../../views/settings/Settings.module.css";
import { useSupportChanged } from "./shared";
import styles from "./support.module.css";

// Ticket settings (admin): where ticket channels go, who works them, the
// log channel and transcripts, and the "react to open a ticket" panel.
// Limits match saveTicketConfig in server/src/modules/support/service.ts.

const MODE_OPTIONS: SelectOption<number>[] = [
  { value: SupportTranscriptMode.FULL, label: "Post the whole transcript" },
  { value: SupportTranscriptMode.SUMMARY, label: "Post a summary only" },
  { value: SupportTranscriptMode.OFF, label: "Post only when tickets open and close" },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function problems(c: SupportTicketConfig): string | undefined {
  if (c.enabled && !c.channelGroupId) return "Pick the channel group tickets are created in.";
  if (!Number.isInteger(c.maxOpen) || c.maxOpen < 1 || c.maxOpen > 10) return "Open tickets per member must be 1 to 10.";
  if (!Number.isInteger(c.transcriptRetentionDays) || c.transcriptRetentionDays < 0 || c.transcriptRetentionDays > 3650) {
    return "Keep transcripts for 0 (forever) to 3,650 days.";
  }
  return undefined;
}

const TicketSettings: React.FC = () => {
  const settings = useRpc(() => supportServiceClient.getTicketSettings());
  const [base, setBase] = useState<SupportTicketConfig | undefined>(undefined);
  const [draft, setDraft] = useState<SupportTicketConfig | undefined>(undefined);
  const dirty = !!draft && !!base && !same(draft, base);

  // Take the server's version when it changes, unless there are unsaved edits.
  useEffect(() => {
    const fresh = settings.data?.config;
    if (!fresh) return;
    if (!dirty) {
      setBase(fresh);
      setDraft(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);
  useSupportChanged(["support:config"], () => void settings.reload());

  const save = useAction((c: SupportTicketConfig) => supportServiceClient.saveTicketConfig(c), { success: "Settings saved" });
  const onSaved = (result: SupportTicketSettings | undefined) => {
    if (!result?.config) return;
    settings.setData(result);
    setBase(result.config);
    setDraft(result.config);
  };

  if (!draft) {
    return (
      <>
        <PageHeader title="Tickets" description="Private support channels between a member and the staff." />
        {settings.error ? <ErrorState message={settings.error} onRetry={() => void settings.reload()} /> : <Spinner block label="Loading settings…" />}
      </>
    );
  }

  const patch = (change: Partial<SupportTicketConfig>) => setDraft((d) => (d ? { ...d, ...change } : d));
  const invalid = problems(draft);
  const groups: SelectOption<string>[] = (settings.data?.channelGroups ?? []).map((g) => ({ value: g.id, label: g.name }));

  return (
    <Stack>
      <PageHeader title="Tickets" description="Private support channels between a member and the staff." />
      {save.error && (
        <Banner tone="error" title="Couldn't save">
          {save.error}
        </Banner>
      )}
      <Card>
        <Stack gap={12}>
          <Toggle
            checked={draft.enabled}
            onChange={(enabled) => patch({ enabled })}
            label="Tickets"
            description="Members can open tickets with the ticket open command, the panel or their Me page."
          />
          <p className={styles.hint}>
            Each ticket is a new private text channel. Only the member who opened it, the staff roles below and Taproot can see
            it. When it's closed, Taproot saves a transcript and deletes the channel.
          </p>
        </Stack>
      </Card>

      <Card title="Where and who">
        <Stack gap={16}>
          <Field
            label="Channel group"
            help="New ticket channels go here. Taproot needs to see this group. A group just for tickets keeps the sidebar tidy."
          >
            <Select<string>
              value={draft.channelGroupId || undefined}
              onChange={(channelGroupId) => patch({ channelGroupId })}
              options={groups}
              placeholder="Pick a channel group…"
            />
          </Field>
          <Field
            label="Staff roles"
            help="These roles see and can work every ticket. With none picked, roles that can kick, ban or manage the community are used. Admins who don't have one of these roles won't see tickets."
          >
            <RoleMultiSelect value={draft.staffRoleIds} onChange={(staffRoleIds) => patch({ staffRoleIds })} emptyText="Roles with moderator permissions" />
          </Field>
          <Field label="Open tickets per member">
            <NumberInput value={draft.maxOpen} onChange={(maxOpen) => patch({ maxOpen })} min={1} max={10} suffix="at a time" />
          </Field>
        </Stack>
      </Card>

      <Card title="Welcome message" description="Posted in each new ticket.">
        <Stack gap={12}>
          <TextArea value={draft.welcomeMessage} onChange={(welcomeMessage) => patch({ welcomeMessage })} maxLength={2000} rows={4} />
          <p className={styles.hint}>
            Placeholders: <code>{"{user}"}</code> mentions the member, <code>{"{user.name}"}</code> is their name,{" "}
            <code>{"{topic}"}</code> is what they wrote when opening, <code>{"{ticket}"}</code> is the ticket number. Taproot adds a
            line explaining the ticket commands.
          </p>
          <MessagePreview content={draft.welcomeMessage} author="Taproot" placeholders emptyText="Only the command help will be posted." />
          <Toggle
            checked={draft.pingStaff}
            onChange={(pingStaff) => patch({ pingStaff })}
            label="Mention the staff roles"
            description="Pings the staff roles in each new ticket."
          />
        </Stack>
      </Card>

      <Card title="Log and transcripts">
        <Stack gap={16}>
          <Field label="Log channel" help="Openings, closings and transcripts are posted here. Use a staff-only channel.">
            <ChannelSelect
              value={draft.transcriptChannelId}
              onChange={(transcriptChannelId) => patch({ transcriptChannelId })}
              noneLabel="No log channel"
            />
          </Field>
          <Field label="When a ticket closes">
            <Select<number> value={draft.transcriptMode} onChange={(transcriptMode) => patch({ transcriptMode })} options={MODE_OPTIONS} />
          </Field>
          <Field
            label="Keep transcripts for"
            help="Every transcript is also kept on the Tickets page. After this many days it's deleted there (0 keeps them until you delete them)."
          >
            <NumberInput
              value={draft.transcriptRetentionDays}
              onChange={(transcriptRetentionDays) => patch({ transcriptRetentionDays })}
              min={0}
              max={3650}
              suffix="days"
            />
          </Field>
        </Stack>
      </Card>

      <PanelCard settings={settings.data} onChanged={(result) => result && settings.setData(result)} />

      {(dirty || save.busy) && (
        <div className={settingsStyles.saveBar} role="region" aria-label="Unsaved changes">
          <span className={settingsStyles.saveText}>{invalid ?? "You have unsaved changes."}</span>
          <div className={settingsStyles.saveActions}>
            <Button variant="quiet" onClick={() => setDraft(settings.data?.config ?? base)} disabled={save.busy}>
              Discard
            </Button>
            <Button variant="primary" loading={save.busy} disabled={!!invalid} onClick={async () => onSaved(await save.run(draft))}>
              Save changes
            </Button>
          </div>
        </div>
      )}
    </Stack>
  );
};

/** The "react to open a ticket" message. Posting one replaces the old one. */
const PanelCard: React.FC<{ settings: SupportTicketSettings | undefined; onChanged: (s: SupportTicketSettings | undefined) => void }> = ({
  settings,
  onChanged,
}) => {
  const { session } = useSession();
  const config = settings?.config;
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("Need help?");
  const [description, setDescription] = useState("");
  const [emoji, setEmoji] = useState(config?.panelEmoji || ":ticket:");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const post = useAction(() => supportServiceClient.postTicketPanel({ channelId: channelId ?? "", title, description, emoji }), {
    success: "Panel posted.",
  });
  const remove = useAction(() => supportServiceClient.removeTicketPanel(), { success: "Panel removed." });
  const live = !!config?.panelChannelId;

  return (
    <Card
      title="Ticket panel"
      description="A message members react to so they can open a ticket without typing a command."
      footer={
        <div className={styles.questionHead} style={{ justifyContent: "flex-end" }}>
          {live && (
            <Button variant="quiet" onClick={() => setConfirmRemove(true)}>
              Remove panel
            </Button>
          )}
          <Button
            variant="primary"
            icon="send"
            loading={post.busy}
            disabled={!channelId || !emoji.trim()}
            onClick={async () => onChanged(await post.run())}
          >
            {live ? "Post a new panel" : "Post panel"}
          </Button>
        </div>
      }
    >
      <Stack gap={16}>
        {live ? (
          <Banner tone="success">
            The panel is live in <span className={styles.mono}>#{settings?.panelChannelName}</span>. Posting a new one removes it.
          </Banner>
        ) : (
          <p className={styles.hint}>
            No panel yet. Members can still type <span className={styles.mono}>{session.prefix}ticket open</span>.
          </p>
        )}
        <div className={styles.grid}>
          <Field label="Channel">
            <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel…" />
          </Field>
          <Field label="Emoji" help="As a :shortcode:.">
            <TextInput value={emoji} onChange={setEmoji} maxLength={64} spellCheck={false} autoComplete="off" />
          </Field>
        </div>
        <Field label="Title">
          <TextInput value={title} onChange={setTitle} maxLength={100} />
        </Field>
        <Field label="Description (optional)">
          <TextArea value={description} onChange={setDescription} maxLength={1000} rows={2} placeholder="Questions, reports and appeals welcome." />
        </Field>
        <p className={styles.hint}>
          Each reaction opens a ticket for that member, and Taproot clears the reactions so the panel stays ready. The
          ticket settings above must be saved and turned on first.
        </p>
      </Stack>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove the ticket panel?"
        message="The panel message is deleted. Open tickets aren't affected."
        confirmLabel="Remove"
        danger
        busy={remove.busy}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={async () => {
          onChanged(await remove.run());
          setConfirmRemove(false);
        }}
      />
    </Card>
  );
};

export default TicketSettings;
