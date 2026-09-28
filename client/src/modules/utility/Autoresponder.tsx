import React, { useMemo, useState } from "react";
import { UtilityMatchMode } from "@taproot/gen-shared";
import type { UtilityAutoresponder, UtilityAutoresponderList } from "@taproot/gen-shared";
import { utilityServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ChannelMultiSelect,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  MessagePreview,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Stack,
  Table,
  TextArea,
  TextInput,
} from "../../components";
import type { Column, SelectOption } from "../../components";
import { formatDuration, plural, truncate, useAction, useRpc, useSession } from "../../lib";
import { appendToken, PlaceholderHelp } from "../../views/content/shared";
import type { Placeholder } from "../../views/content/shared";
import styles from "../../views/content/content.module.css";
import { MAX_RESPONSE, MAX_TRIGGER, useUtilityChanged } from "./shared";

// Autoresponders (moderator+): replies or reactions when an ordinary message
// matches a trigger. Same rules as "ar"; the server re-checks everything.

const MATCH_OPTIONS: SelectOption<UtilityMatchMode>[] = [
  { value: UtilityMatchMode.EXACT, label: "Exact: the whole message" },
  { value: UtilityMatchMode.CONTAINS, label: "Contains: anywhere, as whole words" },
  { value: UtilityMatchMode.STARTS_WITH, label: "Starts with" },
  { value: UtilityMatchMode.WILDCARD, label: "Wildcard: * matches any text" },
];

const MATCH_LABEL: Record<number, string> = {
  [UtilityMatchMode.EXACT]: "Exact",
  [UtilityMatchMode.CONTAINS]: "Contains",
  [UtilityMatchMode.STARTS_WITH]: "Starts with",
  [UtilityMatchMode.WILDCARD]: "Wildcard",
};

const AR_PLACEHOLDERS: Placeholder[] = [
  { token: "{user}", meaning: "mentions who posted" },
  { token: "{user.name}", meaning: "their name" },
  { token: "{channel}", meaning: "the channel" },
  { token: "{server}", meaning: "the community's name" },
];

const BLANK: UtilityAutoresponder = {
  id: 0,
  trigger: "",
  match: UtilityMatchMode.CONTAINS,
  response: "",
  reaction: "",
  channelIds: [],
  cooldownSeconds: 10,
  uses: 0,
  channelNames: [],
};

const Autoresponder: React.FC = () => {
  const { session } = useSession();
  const list = useRpc(() => utilityServiceClient.listAutoresponders());
  useUtilityChanged(["utility:autoresponders"], () => void list.reload());

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<UtilityAutoresponder | undefined>(undefined);
  const [deleting, setDeleting] = useState<UtilityAutoresponder | undefined>(undefined);

  const remove = useAction((id: number) => utilityServiceClient.deleteAutoresponder({ id }), { success: "Autoresponder deleted." });

  const items = list.data?.autoresponders ?? [];
  const max = list.data?.max ?? 100;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((a) => a.trigger.toLowerCase().includes(q) || a.response.toLowerCase().includes(q));
  }, [items, query]);

  const columns: Column<UtilityAutoresponder>[] = [
    {
      key: "trigger",
      header: "Trigger",
      width: "30%",
      render: (a) => (
        <Stack gap={2}>
          <span className={styles.code} title={a.trigger}>
            {truncate(a.trigger, 40)}
          </span>
          <span className="tp-subtle">{MATCH_LABEL[a.match] ?? "Exact"}</span>
        </Stack>
      ),
    },
    {
      key: "response",
      header: "Response",
      hideOnMobile: true,
      render: (a) => (
        <span className={styles.clip} title={a.response}>
          {a.reaction && <Badge tone="brand">{a.reaction}</Badge>} {truncate(a.response.replace(/\s+/g, " "), 100)}
        </span>
      ),
    },
    {
      key: "where",
      header: "Where",
      hideOnMobile: true,
      width: "18%",
      render: (a) => (
        <span className="tp-subtle" title={a.channelNames.map((n) => `#${n}`).join(", ")}>
          {a.channelIds.length === 0 ? "Everywhere" : a.channelIds.length === 1 ? `#${a.channelNames[0]}` : plural(a.channelIds.length, "channel")}
          {a.cooldownSeconds > 0 && ` · ${formatDuration(a.cooldownSeconds * 1000)}`}
        </span>
      ),
    },
    { key: "uses", header: "Uses", align: "right", width: "70px", render: (a) => a.uses.toLocaleString() },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "88px",
      render: (a) => (
        <div className={styles.cellActions} onClick={(e) => e.stopPropagation()}>
          <IconButton icon="edit" label={`Edit autoresponder ${a.trigger}`} onClick={() => setEditing(a)} />
          <IconButton icon="trash" label={`Delete autoresponder ${a.trigger}`} danger onClick={() => setDeleting(a)} />
        </div>
      ),
    },
  ];

  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setEditing(BLANK)} disabled={items.length >= max}>
      New autoresponder
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Autoresponder"
        description={
          <>
            Automatic replies or reactions when a message matches a trigger. Commands like{" "}
            <span className="tp-mono">{session.prefix}help</span> never trigger them, and bots are ignored.
          </>
        }
        actions={newButton}
      />

      {list.error && !list.data ? (
        <Card>
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        </Card>
      ) : (
        <Card padded={false}>
          {items.length > 0 && (
            <div className={styles.toolbar}>
              <TextInput
                className={styles.search}
                value={query}
                onChange={setQuery}
                placeholder="Search triggers and responses"
                aria-label="Search autoresponders"
                prefix={<Icon name="search" size={14} />}
              />
              <span className="tp-subtle">
                {items.length} of {max}
              </span>
            </div>
          )}
          <Table
            columns={columns}
            rows={filtered}
            rowKey={(a) => a.id}
            onRowClick={(a) => setEditing(a)}
            loading={list.loading}
            empty={
              items.length === 0 ? (
                <EmptyState
                  icon={<Icon name="message" size={28} />}
                  title="No autoresponders yet"
                  description="Answer common questions automatically, or react when someone says good morning."
                  action={newButton}
                />
              ) : (
                <EmptyState compact title="No matches" description={`Nothing matches "${query.trim()}".`} />
              )
            }
          />
        </Card>
      )}

      {editing && <Editor initial={editing} onClose={() => setEditing(undefined)} onSaved={(r) => (list.setData(r), setEditing(undefined))} />}

      <ConfirmDialog
        open={!!deleting}
        title="Delete autoresponder?"
        message={deleting && <>Messages matching <span className="tp-mono">{deleting.trigger}</span> will no longer get a response.</>}
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.run(deleting.id);
          if (result) list.setData(result);
          setDeleting(undefined);
        }}
      />
    </>
  );
};

const Editor: React.FC<{
  initial: UtilityAutoresponder;
  onClose: () => void;
  onSaved: (list: UtilityAutoresponderList) => void;
}> = ({ initial, onClose, onSaved }) => {
  const [draft, setDraft] = useState<UtilityAutoresponder>(initial);
  const [touched, setTouched] = useState(false);
  const patch = (p: Partial<UtilityAutoresponder>) => setDraft((d) => ({ ...d, ...p }));

  const save = useAction(() => utilityServiceClient.saveAutoresponder(draft), {
    success: initial.id ? "Autoresponder saved." : "Autoresponder created.",
    toastError: false,
  });

  const triggerError =
    !draft.trigger.trim() ? (touched ? "Give the trigger text." : undefined) : draft.match === UtilityMatchMode.WILDCARD && !draft.trigger.replace(/\*/g, "").trim() ? "Add some text besides *." : undefined;
  const reactionError = draft.reaction.trim() && !/^:[^:\s]+:$/.test(draft.reaction.trim()) ? "Write it as a :shortcode:, like :wave:." : undefined;
  const needsOne = !draft.response.trim() && !draft.reaction.trim();
  const canSave = !!draft.trigger.trim() && !triggerError && !reactionError && !needsOne && !save.busy;

  const submit = async () => {
    setTouched(true);
    if (!canSave) return;
    const result = await save.run();
    if (result) onSaved(result);
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!save.busy}
      size="lg"
      title={initial.id ? "Edit autoresponder" : "New autoresponder"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.busy} disabled={!canSave}>
            {initial.id ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field label="Trigger" error={triggerError} help="Matching ignores upper and lower case.">
          <TextInput
            value={draft.trigger}
            onChange={(trigger) => patch({ trigger })}
            maxLength={MAX_TRIGGER}
            placeholder={draft.match === UtilityMatchMode.WILDCARD ? "*server ip*" : "good morning"}
            autoFocus
          />
        </Field>
        <Field label="Match">
          <Select value={draft.match} onChange={(match) => patch({ match })} options={MATCH_OPTIONS} />
        </Field>
        <Field label="Reply" help="Markdown works. Leave empty to only react." error={touched && needsOne ? "Give a reply, a reaction, or both." : undefined}>
          <TextArea value={draft.response} onChange={(response) => patch({ response })} maxLength={MAX_RESPONSE} rows={3} placeholder="Good morning, {user}! ☀️" />
        </Field>
        <PlaceholderHelp placeholders={AR_PLACEHOLDERS} onInsert={(t) => patch({ response: appendToken(draft.response, t) })} />
        {draft.response.trim() && (
          <div>
            <div className={styles.previewLabel}>Preview</div>
            <MessagePreview content={draft.response} author="Taproot" placeholders />
          </div>
        )}
        <Field label="Reaction" error={reactionError} help="Optional. Taproot reacts to the matching message with this emoji.">
          <TextInput value={draft.reaction} onChange={(reaction) => patch({ reaction })} maxLength={80} placeholder=":wave:" spellCheck={false} />
        </Field>
        <Field label="Channels" help="Leave empty to respond in every channel Taproot can see.">
          <ChannelMultiSelect value={draft.channelIds} onChange={(channelIds) => patch({ channelIds })} emptyText="Every channel" />
        </Field>
        <Field label="Cooldown" help="Seconds before this trigger can respond again. 0 means no cooldown (still at most once every 3 seconds per channel).">
          <NumberInput value={draft.cooldownSeconds} onChange={(cooldownSeconds) => patch({ cooldownSeconds })} min={0} max={86400} suffix="seconds" width={140} />
        </Field>
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
    </Modal>
  );
};

export default Autoresponder;
