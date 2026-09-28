import React, { useState } from "react";
import { SupportSubmissionStatus, SupportTicketStatus } from "@taproot/gen-shared";
import { supportServiceClient } from "@taproot/gen-client";
import { Badge, Banner, Button, Card, EmptyState, ErrorState, Field, Icon, Modal, Spinner, Stack, TextInput } from "../../components";
import { formatRelative, NavLink, truncate, useAction, useRpc } from "../../lib";
import { SUBMISSION_STATUS, TICKET_STATUS, useSupportChanged } from "./shared";
import styles from "./support.module.css";

// Cards on every member's Me page: their tickets (with an "Open a ticket"
// button) and the status of the forms they sent.

export const MyTickets: React.FC = () => {
  const list = useRpc(() => supportServiceClient.listMyTickets());
  useSupportChanged(["support:tickets"], () => void list.reload());
  const [opening, setOpening] = useState(false);
  const tickets = list.data?.tickets ?? [];
  const hasOpen = tickets.some((t) => t.status === SupportTicketStatus.OPEN);
  // Nothing to show a member when tickets are off and they never had one.
  if (list.data && !list.data.ticketsEnabled && tickets.length === 0) return null;

  let body: React.ReactNode;
  if (list.error && !list.data) body = <ErrorState compact message={list.error} onRetry={() => void list.reload()} />;
  else if (!list.data) body = <Spinner block />;
  else if (tickets.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<Icon name="ticket" size={28} />}
        title="No tickets"
        description="Open one to talk privately with the staff."
      />
    );
  } else {
    body = (
      <div className={styles.list}>
        {tickets.slice(0, 10).map((t) => {
          const open = t.status === SupportTicketStatus.OPEN;
          return (
            <div key={t.id} className={styles.row}>
              <div className={styles.main}>
                <div className={styles.title}>
                  Ticket #{t.id}
                  {t.topic && ` · ${truncate(t.topic, 60)}`}
                </div>
                <div className={styles.meta}>
                  {open ? (
                    <>
                      Find <span className={styles.mono}>#{t.channelName}</span> in the channel list · opened {formatRelative(t.openedAtMs)}
                    </>
                  ) : (
                    <>Closed {formatRelative(t.closedAtMs)}</>
                  )}
                </div>
              </div>
              <Badge tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].label}</Badge>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Card
      title="Tickets"
      description="Private channels between you and the staff."
      actions={
        <Button size="sm" icon="plus" onClick={() => setOpening(true)} disabled={!list.data?.ticketsEnabled}>
          Open a ticket
        </Button>
      }
      padded={false}
    >
      {hasOpen && (
        <div style={{ padding: "12px 16px 0" }}>
          <Banner tone="info">Your open ticket is a private channel in the sidebar. Only you and the staff can see it.</Banner>
        </div>
      )}
      {body}
      {opening && <OpenTicket onClose={() => setOpening(false)} onOpened={() => void list.reload()} />}
    </Card>
  );
};

const OpenTicket: React.FC<{ onClose: () => void; onOpened: () => void }> = ({ onClose, onOpened }) => {
  const [topic, setTopic] = useState("");
  const open = useAction(() => supportServiceClient.openTicket({ topic }), { toastError: false });
  const [channel, setChannel] = useState<string | undefined>(undefined);

  const submit = async () => {
    const ticket = await open.run();
    if (ticket) {
      setChannel(ticket.channelName);
      onOpened();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!open.busy}
      title={channel ? "Ticket opened" : "Open a ticket"}
      footer={
        channel ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={open.busy}>
              Cancel
            </Button>
            <Button variant="primary" icon="ticket" loading={open.busy} onClick={submit}>
              Open ticket
            </Button>
          </>
        )
      }
    >
      {channel ? (
        <p className={styles.hint}>
          Your ticket is <span className={styles.mono}>#{channel}</span>. Open it from the channel list and tell the staff what
          you need. Only you, the staff and Taproot can see it.
        </p>
      ) : (
        <Stack gap={12}>
          <Field label="What's it about? (optional)" help="The staff see this when the ticket opens.">
            <TextInput value={topic} onChange={setTopic} onEnter={submit} maxLength={200} placeholder="Question about my role" autoFocus />
          </Field>
          {open.error && <Banner tone="error">{open.error}</Banner>}
        </Stack>
      )}
    </Modal>
  );
};

export const MySubmissions: React.FC = () => {
  const list = useRpc(() => supportServiceClient.listMySubmissions());
  useSupportChanged(["support:submissions"], () => void list.reload());
  const submissions = list.data?.submissions ?? [];

  let body: React.ReactNode;
  if (list.error && !list.data) body = <ErrorState compact message={list.error} onRetry={() => void list.reload()} />;
  else if (!list.data) body = <Spinner block />;
  else if (submissions.length === 0) {
    body = (
      <EmptyState
        compact
        icon={<Icon name="clipboard" size={28} />}
        title="Nothing sent yet"
        description={
          <>
            Applications and appeals you send on the <NavLink to="forms">Forms</NavLink> page show up here.
          </>
        }
      />
    );
  } else {
    body = (
      <div className={styles.list}>
        {submissions.slice(0, 15).map((s) => {
          const status = SUBMISSION_STATUS[s.status];
          return (
            <div key={s.id} className={styles.row}>
              <div className={styles.main}>
                <div className={styles.title}>{s.formTitle}</div>
                <div className={styles.meta}>
                  Sent {formatRelative(s.createdAtMs)}
                  {s.status !== SupportSubmissionStatus.PENDING && s.note && ` · “${truncate(s.note, 200)}”`}
                </div>
              </div>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <Card title="Forms you sent" description="What the staff decided." padded={false}>
      {body}
    </Card>
  );
};
