import React, { useState } from "react";
import type { Panel, PanelList, PanelRole } from "@taproot/gen-shared";
import { contentServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ChannelSelect,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Modal,
  PageHeader,
  RoleSelect,
  Spinner,
  Stack,
  TextInput,
} from "../components";
import { normalizeHex } from "../components";
import { plural, useAction, useRoles, useRpc, useSession } from "../lib";
import { channelLabel, useContentChanged } from "./content/shared";
import styles from "./content/content.module.css";

// Reaction roles (admin): panels are Taproot messages; members react with an
// emoji to get its role and remove the reaction to drop it. Same data as
// "rr create/add/remove/delete" in chat.

/** A :shortcode:, as resolveEmojiText on the server expects. */
const SHORTCODE = /^:[^:\s]+:$/;

/** Emoji whose reaction Taproot couldn't add, per panel. */
type Unseeded = Record<number, string[]>;

const ReactionRoles: React.FC = () => {
  const { isAdmin, session } = useSession();
  const list = useRpc(() => contentServiceClient.listPanels(), [], { skip: !isAdmin });
  useContentChanged(["panels"], () => {
    if (isAdmin) void list.reload();
  });

  const [creating, setCreating] = useState(false);
  const [unseeded, setUnseeded] = useState<Unseeded>({});

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Reaction roles" />
        <Card>
          <EmptyState
            icon={<Icon name="smile" size={28} />}
            title="Admins only"
            description={`Only admins can manage reaction role panels. Members can still pick self-assignable roles with ${session.prefix}iam or on the Me page.`}
          />
        </Card>
      </>
    );
  }

  const panels = list.data?.panels ?? [];

  /** Swaps one panel in the list for its updated version. */
  const replacePanel = (panel: Panel) => {
    const current = list.data?.panels ?? [];
    const next = current.some((p) => p.id === panel.id)
      ? current.map((p) => (p.id === panel.id ? panel : p))
      : [...current, panel];
    list.setData({ panels: next });
  };

  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      New panel
    </Button>
  );

  let body: React.ReactNode;
  if (list.error && !list.data) {
    body = (
      <Card>
        <ErrorState message={list.error} onRetry={() => void list.reload()} />
      </Card>
    );
  } else if (!list.data) {
    body = <Spinner block />;
  } else if (panels.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={<Icon name="smile" size={28} />}
          title="No reaction role panels yet"
          description="Create a panel in a channel, then add emoji and roles. Members react to get a role and remove their reaction to drop it."
          action={newButton}
        />
      </Card>
    );
  } else {
    body = (
      <div className={styles.panels}>
        {panels.map((panel) => (
          <PanelCard
            key={panel.id}
            panel={panel}
            unseeded={unseeded[panel.id] ?? []}
            onChanged={replacePanel}
            onDeleted={(result) => list.setData(result)}
            onUnseeded={(emoji, seeded) =>
              setUnseeded((u) => {
                const rest = (u[panel.id] ?? []).filter((e) => e !== emoji);
                return { ...u, [panel.id]: seeded ? rest : [...rest, emoji] };
              })
            }
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Reaction roles"
        description="Panels where members pick their own roles by reacting with an emoji."
        actions={panels.length > 0 ? newButton : undefined}
      />
      {body}
      {creating && (
        <CreatePanelDialog
          onClose={() => setCreating(false)}
          onCreated={(panel) => {
            replacePanel(panel);
            setCreating(false);
          }}
        />
      )}
    </>
  );
};

const PanelCard: React.FC<{
  panel: Panel;
  unseeded: string[];
  onChanged: (panel: Panel) => void;
  onDeleted: (list: PanelList) => void;
  onUnseeded: (emoji: string, seeded: boolean) => void;
}> = ({ panel, unseeded, onChanged, onDeleted, onUnseeded }) => {
  const roles = useRoles();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removingEmoji, setRemovingEmoji] = useState<string | undefined>(undefined);

  const remove = useAction(
    (emoji: string) => contentServiceClient.removePanelRole({ panelId: panel.id, emoji }),
    { success: "Role removed from the panel." },
  );
  const del = useAction(() => contentServiceClient.deletePanel({ id: panel.id }), { success: "Panel deleted." });

  const removeRole = async (entry: PanelRole) => {
    setRemovingEmoji(entry.emoji);
    const result = await remove.run(entry.emoji);
    setRemovingEmoji(undefined);
    if (result) {
      onChanged(result);
      onUnseeded(entry.emoji, true);
    }
  };

  return (
    <Card
      title={panel.title}
      description={`#${panel.id} · ${channelLabel(panel.channelName)} · ${plural(panel.roles.length, "role")}`}
      actions={
        <>
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add role
          </Button>
          <IconButton icon="trash" label={`Delete panel ${panel.title}`} danger onClick={() => setDeleting(true)} />
        </>
      }
      padded={false}
    >
      {unseeded.length > 0 && (
        <div className={styles.bannerWrap}>
          <Banner tone="warning" title="React once to finish">
            Taproot couldn't add the {unseeded.join(" ")} reaction to the panel message in{" "}
            {channelLabel(panel.channelName)}. React with {unseeded.length === 1 ? "it" : "them"} once yourself so
            members have something to click.
          </Banner>
        </div>
      )}
      {panel.roles.length === 0 ? (
        <EmptyState
          compact
          title="No roles on this panel yet"
          description="Add an emoji and a role, and Taproot updates the panel message."
        />
      ) : (
        <div className={styles.list}>
          {panel.roles.map((entry) => {
            const role = roles.byId.get(entry.roleId);
            return (
              <div key={entry.emoji} className={styles.listRow}>
                <span className={styles.emoji}>{entry.emoji}</span>
                <div className={styles.listMain}>
                  <Chip
                    label={role?.name ?? entry.roleName}
                    color={role?.colorHex ? normalizeHex(role.colorHex) : undefined}
                    muted={!role && !roles.loading}
                  />
                  {entry.label && <div className={styles.listMeta}>{entry.label}</div>}
                </div>
                <IconButton
                  icon="trash"
                  label={`Remove ${entry.emoji} from the panel`}
                  danger
                  loading={removingEmoji === entry.emoji}
                  disabled={remove.busy}
                  onClick={() => void removeRole(entry)}
                />
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <AddRoleDialog
          panel={panel}
          onClose={() => setAdding(false)}
          onAdded={(updated, emoji, seeded) => {
            onChanged(updated);
            onUnseeded(emoji, seeded);
            setAdding(false);
          }}
        />
      )}

      <ConfirmDialog
        open={deleting}
        title="Delete panel?"
        message={
          <>
            Taproot deletes the “{panel.title}” message in {channelLabel(panel.channelName)}. Members keep the roles
            they already have.
          </>
        }
        confirmLabel="Delete panel"
        danger
        busy={del.busy}
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          const result = await del.run();
          setDeleting(false);
          if (result) onDeleted(result);
        }}
      />
    </Card>
  );
};

const CreatePanelDialog: React.FC<{ onClose: () => void; onCreated: (panel: Panel) => void }> = ({
  onClose,
  onCreated,
}) => {
  const [channelId, setChannelId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const create = useAction(
    () => contentServiceClient.createPanel({ channelId: channelId ?? "", title: title.trim() }),
    { success: (p) => `Panel posted in ${channelLabel(p.channelName)}.` },
  );
  const canCreate = !!channelId && !!title.trim() && !create.busy;
  const submit = async () => {
    if (!canCreate) return;
    const panel = await create.run();
    if (panel) onCreated(panel);
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!create.busy}
      title="New reaction role panel"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={create.busy} disabled={!canCreate}>
            Create panel
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field label="Channel" help="Taproot posts the panel message here.">
          <ChannelSelect value={channelId} onChange={setChannelId} placeholder="Pick a channel" />
        </Field>
        <Field label="Title" help="Shown at the top of the panel, e.g. “Pick your games”.">
          <TextInput value={title} onChange={setTitle} onEnter={submit} maxLength={200} placeholder="Pick your roles" />
        </Field>
      </Stack>
    </Modal>
  );
};

const AddRoleDialog: React.FC<{
  panel: Panel;
  onClose: () => void;
  onAdded: (panel: Panel, emoji: string, seeded: boolean) => void;
}> = ({ panel, onClose, onAdded }) => {
  const [emoji, setEmoji] = useState("");
  const [roleId, setRoleId] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("");

  const shortcode = emoji.trim();
  const emojiValid = SHORTCODE.test(shortcode);
  const replaces = panel.roles.find((r) => r.emoji === shortcode);
  const add = useAction(
    () => contentServiceClient.addPanelRole({ panelId: panel.id, emoji: shortcode, roleId: roleId ?? "", label: label.trim() }),
    { success: (r) => (r.reactionSeeded ? "Role added to the panel." : undefined) },
  );

  const canAdd = emojiValid && !!roleId && !add.busy;
  const submit = async () => {
    if (!canAdd) return;
    const result = await add.run();
    if (result?.panel) onAdded(result.panel, shortcode, result.reactionSeeded);
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!add.busy}
      title={`Add a role to “${panel.title}”`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={add.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={add.busy} disabled={!canAdd}>
            Add role
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field
          label="Emoji"
          error={shortcode && !emojiValid ? "Write it as a :shortcode:, like :tada:." : undefined}
          help="Type the emoji's shortcode with colons, like :tada: or :video_game:. Community emoji work too, by name."
          hint={replaces ? `Replaces ${replaces.roleName} on this emoji.` : undefined}
        >
          <TextInput
            value={emoji}
            onChange={(v) => setEmoji(v.replace(/\s+/g, ""))}
            onEnter={submit}
            placeholder=":tada:"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            className="tp-mono"
          />
        </Field>
        <Field label="Role" help="Roles with staff permissions can't go on a panel.">
          <RoleSelect value={roleId} onChange={setRoleId} excludePrivileged placeholder="Pick a role" />
        </Field>
        <Field label="Label" help="Optional. Shown next to the role on the panel.">
          <TextInput value={label} onChange={setLabel} onEnter={submit} maxLength={100} placeholder="Game night pings" />
        </Field>
      </Stack>
    </Modal>
  );
};

export default ReactionRoles;
