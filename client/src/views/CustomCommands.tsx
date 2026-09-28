import React, { useMemo, useState } from "react";
import type { CustomCommand, CustomCommandList } from "@taproot/gen-shared";
import { contentServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  MessagePreview,
  Modal,
  PageHeader,
  Stack,
  Table,
  TextArea,
  TextInput,
} from "../components";
import type { Column } from "../components";
import { plural, truncate, useAction, useRpc, useSession } from "../lib";
import { appendToken, COMMAND_PLACEHOLDERS, MAX_MESSAGE, PlaceholderHelp, useContentChanged } from "./content/shared";
import styles from "./content/content.module.css";

// Custom commands (moderator+): text replies triggered by "<prefix><name>".
// Same rules as "cc add/edit/remove"; the server re-checks everything.

/** Mirrors NAME in server/src/features/customCommands.ts. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * What the name box holds: lowercase, spaces as dashes, and a pasted prefix
 * dropped (the server does the same). A prefix made of letters isn't stripped
 * while typing, or "t" would eat the start of "test".
 */
function cleanName(raw: string, prefix: string): string {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "-");
  const symbolic = prefix && !/^[a-z0-9]+$/i.test(prefix);
  return symbolic && text.startsWith(prefix.toLowerCase()) ? text.slice(prefix.length) : text;
}

function nameProblem(name: string): string | undefined {
  if (!name) return undefined;
  if (name.length > 32) return "Names can be up to 32 characters.";
  if (!NAME.test(name)) return "Use letters, numbers, - and _, starting with a letter or number.";
  return undefined;
}

const CustomCommands: React.FC = () => {
  const { session } = useSession();
  const prefix = session.prefix;
  const list = useRpc(() => contentServiceClient.listCustomCommands());
  useContentChanged(["commands"], () => void list.reload());

  const [query, setQuery] = useState("");
  // undefined = closed, null = new command.
  const [editing, setEditing] = useState<CustomCommand | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<CustomCommand | undefined>(undefined);

  const remove = useAction((name: string) => contentServiceClient.deleteCustomCommand({ name }), {
    success: () => `Deleted ${prefix}${deleting?.name ?? "command"}.`,
  });

  const commands = list.data?.commands ?? [];
  const filtered = useMemo(() => {
    const q = cleanName(query, prefix);
    const text = query.trim().toLowerCase();
    if (!text) return commands;
    return commands.filter((c) => c.name.includes(q) || c.response.toLowerCase().includes(text));
  }, [commands, query, prefix]);
  const totalUses = commands.reduce((sum, c) => sum + c.uses, 0);

  const columns: Column<CustomCommand>[] = [
    {
      key: "name",
      header: "Command",
      width: "28%",
      render: (c) => <span className={styles.code}>{prefix + c.name}</span>,
    },
    {
      key: "response",
      header: "Response",
      hideOnMobile: true,
      render: (c) => (
        <span className={styles.clip} title={c.response}>
          {truncate(c.response.replace(/\s+/g, " "), 120)}
        </span>
      ),
    },
    { key: "uses", header: "Uses", align: "right", width: "80px", render: (c) => c.uses.toLocaleString() },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "88px",
      render: (c) => (
        <div className={styles.cellActions} onClick={(e) => e.stopPropagation()}>
          <IconButton icon="edit" label={`Edit ${prefix}${c.name}`} onClick={() => setEditing(c)} />
          <IconButton icon="trash" label={`Delete ${prefix}${c.name}`} danger onClick={() => setDeleting(c)} />
        </div>
      ),
    },
  ];

  const onSaved = (result: CustomCommandList) => {
    list.setData(result);
    setEditing(undefined);
  };

  return (
    <>
      <PageHeader
        title="Custom commands"
        description={
          <>
            Canned replies anyone can trigger in chat, like <span className="tp-mono">{prefix}rules</span>.
          </>
        }
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditing(null)}>
            New command
          </Button>
        }
      />

      {list.error && !list.data ? (
        <Card>
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        </Card>
      ) : (
        <Card padded={false}>
          {commands.length > 0 && (
            <div className={styles.toolbar}>
              <TextInput
                className={styles.search}
                value={query}
                onChange={setQuery}
                placeholder="Search names and responses"
                aria-label="Search custom commands"
                prefix={<Icon name="search" size={14} />}
              />
              <span className="tp-subtle">
                {plural(commands.length, "command")} · {plural(totalUses, "use")}
              </span>
            </div>
          )}
          <Table
            columns={columns}
            rows={filtered}
            rowKey={(c) => c.name}
            onRowClick={(c) => setEditing(c)}
            loading={list.loading}
            empty={
              commands.length === 0 ? (
                <EmptyState
                  icon={<Icon name="terminal" size={28} />}
                  title="No custom commands yet"
                  description={`Make one and members can type ${prefix}<name> to get its reply.`}
                  action={
                    <Button variant="primary" icon="plus" onClick={() => setEditing(null)}>
                      New command
                    </Button>
                  }
                />
              ) : (
                <EmptyState compact title="No matches" description={`Nothing matches "${query.trim()}".`} />
              )
            }
          />
        </Card>
      )}

      {editing !== undefined && (
        <CommandEditor
          command={editing ?? undefined}
          prefix={prefix}
          existing={commands}
          onClose={() => setEditing(undefined)}
          onSaved={onSaved}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete command?"
        message={
          deleting && (
            <>
              <span className="tp-mono">{prefix + deleting.name}</span> will stop working right away. It has been used{" "}
              {plural(deleting.uses, "time")}.
            </>
          )
        }
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setDeleting(undefined)}
        onConfirm={async () => {
          if (!deleting) return;
          const result = await remove.run(deleting.name);
          if (result) list.setData(result);
          setDeleting(undefined);
        }}
      />
    </>
  );
};

const CommandEditor: React.FC<{
  command: CustomCommand | undefined;
  prefix: string;
  existing: CustomCommand[];
  onClose: () => void;
  onSaved: (list: CustomCommandList) => void;
}> = ({ command, prefix, existing, onClose, onSaved }) => {
  const [name, setName] = useState(command?.name ?? "");
  const [response, setResponse] = useState(command?.response ?? "");
  const [touched, setTouched] = useState(false);

  const save = useAction(
    () =>
      contentServiceClient.saveCustomCommand({
        name,
        response,
        originalName: command?.name,
      }),
    { success: () => (command ? `Saved ${prefix}${name}.` : `Created ${prefix}${name}.`), toastError: false },
  );

  const taken = name !== command?.name && existing.some((c) => c.name === name);
  const nameError = nameProblem(name) ?? (taken ? `${prefix}${name} already exists.` : undefined);
  const canSave = !!name && !nameError && !!response.trim() && !save.busy;

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
      title={command ? `Edit ${prefix}${command.name}` : "New custom command"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.busy} disabled={!canSave}>
            {command ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field
          label="Name"
          error={nameError ?? (touched && !name ? "Give it a name." : undefined)}
          help="Letters, numbers, - and _, up to 32 characters."
          hint={name && !nameError ? <>Members type <span className="tp-mono">{prefix + name}</span></> : undefined}
        >
          <TextInput
            value={name}
            onChange={(v) => setName(cleanName(v, prefix))}
            onEnter={submit}
            prefix={prefix}
            maxLength={40}
            placeholder="rules"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Response"
          error={touched && !response.trim() ? "Write what Taproot should reply." : undefined}
          help="Markdown works. Click a placeholder to add it."
        >
          <TextArea value={response} onChange={setResponse} maxLength={MAX_MESSAGE} rows={4} placeholder="Please read the rules, {user}!" />
        </Field>
        <PlaceholderHelp placeholders={COMMAND_PLACEHOLDERS} onInsert={(t) => setResponse((r) => appendToken(r, t))} />
        <div>
          <div className={styles.previewLabel}>Preview</div>
          <MessagePreview content={response} author="Taproot" placeholders emptyText="The reply will show here." />
        </div>
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
    </Modal>
  );
};

export default CustomCommands;
