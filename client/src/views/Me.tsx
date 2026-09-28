import React, { useState } from "react";
import type { Reminder, SelfRole } from "@taproot/gen-shared";
import { contentServiceClient } from "@taproot/gen-client";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  MessagePreview,
  normalizeHex,
  PageHeader,
  Spinner,
  Stack,
  Toggle,
} from "../components";
import { formatDateTime, formatRelative, NavLink, plural, truncate, useAction, useRpc, useSession } from "../lib";
import { channelLabel, useContentChanged } from "./content/shared";
import styles from "./content/content.module.css";
import { MODULE_ME_SECTIONS } from "../modules";

// The member page (everyone): pick self-assignable roles and see or cancel
// your own reminders. Same rules as "iam"/"iamnot" and "reminders cancel".

const Me: React.FC = () => {
  const { session } = useSession();
  return (
    <>
      <PageHeader
        title={session.nickname ? `Hi, ${session.nickname}` : "Me"}
        description={`Your roles, reminders and more in ${session.communityName || "this community"}.`}
      />
      <Stack gap={16}>
        <SelfRoles />
        <Reminders />
        {MODULE_ME_SECTIONS.map((Section, i) => (
          <Section key={i} />
        ))}
      </Stack>
    </>
  );
};

const SelfRoles: React.FC = () => {
  const { session, isAdmin } = useSession();
  const list = useRpc(() => contentServiceClient.listSelfRoles());
  useContentChanged(["selfroles"], () => void list.reload());
  const [pending, setPending] = useState<string | undefined>(undefined);

  const set = useAction((role: SelfRole, has: boolean) => contentServiceClient.setSelfRole({ roleId: role.roleId, has }), {
    success: undefined,
  });

  const toggle = async (role: SelfRole, has: boolean) => {
    setPending(role.roleId);
    // Flip it right away; the server's answer (or a reload on failure) settles it.
    if (list.data) {
      list.setData({ roles: list.data.roles.map((r) => (r.roleId === role.roleId ? { ...r, has } : r)) });
    }
    const result = await set.run(role, has);
    setPending(undefined);
    if (result) list.setData(result);
    else void list.reload();
  };

  const roles = list.data?.roles ?? [];
  const mine = roles.filter((r) => r.has).length;

  let body: React.ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState compact message={list.error} onRetry={() => void list.reload()} />;
  } else if (!list.data) {
    body = <Spinner block />;
  } else if (roles.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<Icon name="users" size={28} />}
        title="No roles to pick from yet"
        description={
          isAdmin ? (
            <>
              Choose which roles members can give themselves in{" "}
              <NavLink to="general">Settings › General</NavLink>.
            </>
          ) : (
            "When the admins make some roles self-assignable, you'll be able to add them here."
          )
        }
      />
    );
  } else {
    body = (
      <div className={styles.list}>
        {roles.map((role) => (
          <div key={role.roleId} className={styles.listRow}>
            <span
              className={styles.swatch}
              style={role.colorHex ? { background: normalizeHex(role.colorHex) } : undefined}
              aria-hidden
            />
            <div className={styles.listMain}>
              <Toggle
                checked={role.has}
                onChange={(has) => void toggle(role, has)}
                disabled={pending !== undefined}
                label={role.name}
                description={role.has ? "You have this role." : undefined}
              />
            </div>
            {pending === role.roleId && <Spinner size={16} inline />}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card
      title="Roles"
      description={
        roles.length
          ? `Turn roles on or off for yourself. You have ${mine} of ${roles.length}. You can also type ${session.prefix}iam <role> in chat.`
          : undefined
      }
      padded={false}
    >
      {body}
    </Card>
  );
};

const Reminders: React.FC = () => {
  const { session } = useSession();
  const list = useRpc(() => contentServiceClient.listMyReminders());
  useContentChanged(["reminders"], () => void list.reload());
  const [cancelling, setCancelling] = useState<Reminder | undefined>(undefined);

  const cancel = useAction((id: number) => contentServiceClient.cancelReminder({ id }), {
    success: "Reminder cancelled.",
  });

  const reminders = [...(list.data?.reminders ?? [])].sort((a, b) => a.dueAtMs - b.dueAtMs);
  const example = `${session.prefix}remind 2h check the oven`;

  let body: React.ReactNode;
  if (list.error && !list.data) {
    body = <ErrorState compact message={list.error} onRetry={() => void list.reload()} />;
  } else if (!list.data) {
    body = <Spinner block />;
  } else if (reminders.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<Icon name="clock" size={28} />}
        title="No reminders"
        description={
          <>
            Type <span className="tp-mono">{example}</span> in any channel and Taproot will ping you there.
          </>
        }
      />
    );
  } else {
    body = (
      <div className={styles.list}>
        {reminders.map((r) => (
          <div key={r.id} className={styles.listRow}>
            <div className={styles.listMain}>
              <div className={styles.listTitle}>{truncate(r.message, 300)}</div>
              <div className={styles.listMeta}>
                {formatRelative(r.dueAtMs)} · {formatDateTime(r.dueAtMs)} · {channelLabel(r.channelName)}
              </div>
            </div>
            <Button size="sm" variant="quiet" onClick={() => setCancelling(r)}>
              Cancel
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card
      title="Reminders"
      description={
        reminders.length ? (
          <>
            {plural(reminders.length, "reminder")} coming up. Add more in chat with{" "}
            <span className="tp-mono">{session.prefix}remind 2h text</span>. They go off within about a minute.
          </>
        ) : undefined
      }
      padded={false}
    >
      {body}
      <ConfirmDialog
        open={!!cancelling}
        title="Cancel reminder?"
        message={cancelling && `Taproot won't ping you ${formatRelative(cancelling.dueAtMs)}.`}
        confirmLabel="Cancel reminder"
        cancelLabel="Keep it"
        danger
        busy={cancel.busy}
        onCancel={() => setCancelling(undefined)}
        onConfirm={async () => {
          if (!cancelling) return;
          const result = await cancel.run(cancelling.id);
          if (result) list.setData(result);
          setCancelling(undefined);
        }}
      >
        {cancelling && <MessagePreview content={cancelling.message} />}
      </ConfirmDialog>
    </Card>
  );
};

export default Me;
