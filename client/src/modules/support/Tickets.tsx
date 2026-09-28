import React, { useEffect, useState } from "react";
import type { SupportTicket } from "@taproot/gen-shared";
import { SupportTicketStatus } from "@taproot/gen-shared";
import { supportServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  Stack,
  Table,
  Tabs,
  TextInput,
} from "../../components";
import type { Column } from "../../components";
import { formatDateTime, formatRelative, NavLink, plural, truncate, useAction, useRpc, useSession } from "../../lib";
import { TICKET_STATUS, useSupportChanged, usePaged } from "./shared";
import styles from "./support.module.css";

// Tickets (moderator+): open and closed tickets, transcripts, and closing a
// ticket from here. Same rules as "ticket close"; the server re-checks.

type TabKey = "open" | "closed";

const Tickets: React.FC = () => {
  const { isAdmin } = useSession();
  const [tab, setTab] = useState<TabKey>("open");
  const list = usePaged(async (offset, limit) => {
    const status = tab === "open" ? SupportTicketStatus.OPEN : SupportTicketStatus.CLOSED;
    const page = await supportServiceClient.listTickets({ status, offset, limit });
    return { items: page.tickets, total: page.total };
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void list.reload(), [tab]);
  useSupportChanged(["support:tickets"], () => void list.reload());
  const [selected, setSelected] = useState<SupportTicket | undefined>(undefined);

  const columns: Column<SupportTicket>[] = [
    { key: "id", header: "#", width: "56px", render: (t) => <span className="tp-mono">{t.id}</span> },
    {
      key: "opener",
      header: "Member",
      render: (t) => (
        <div>
          <div>{t.openerName}</div>
          {t.topic && <div className={styles.meta}>{truncate(t.topic, 80)}</div>}
        </div>
      ),
    },
    tab === "open"
      ? {
          key: "channel",
          header: "Channel",
          hideOnMobile: true,
          render: (t) => (
            <>
              <span className="tp-mono">#{t.channelName}</span>
              {t.claimedByName && <div className={styles.meta}>Claimed by {t.claimedByName}</div>}
            </>
          ),
        }
      : {
          key: "closed",
          header: "Closed by",
          hideOnMobile: true,
          render: (t) => (
            <>
              <div>{t.closedByName}</div>
              {t.closeReason && <div className={styles.meta}>{truncate(t.closeReason, 80)}</div>}
            </>
          ),
        },
    {
      key: "when",
      header: tab === "open" ? "Opened" : "Closed",
      align: "right",
      width: "120px",
      render: (t) => <span title={formatDateTime(tab === "open" ? t.openedAtMs : t.closedAtMs)}>{formatRelative(tab === "open" ? t.openedAtMs : t.closedAtMs)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tickets"
        description={
          isAdmin ? (
            <>
              Private support channels between a member and the staff. Set them up on the{" "}
              <NavLink to="ticketSettings">Tickets settings</NavLink> page.
            </>
          ) : (
            "Private support channels between a member and the staff."
          )
        }
      />
      <Tabs<TabKey>
        tabs={[
          { key: "open", label: "Open", count: tab === "open" ? list.total : undefined },
          { key: "closed", label: "Closed", count: tab === "closed" ? list.total : undefined },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ height: 16 }} />
      {list.error && list.items.length === 0 ? (
        <Card>
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        </Card>
      ) : (
        <Card padded={false}>
          <Table
            columns={columns}
            rows={list.items}
            rowKey={(t) => t.id}
            onRowClick={setSelected}
            loading={list.loading && list.items.length === 0}
            empty={
              <EmptyState
                icon={<Icon name="ticket" size={28} />}
                title={tab === "open" ? "No open tickets" : "No closed tickets"}
                description={tab === "open" ? "New tickets show up here as members open them." : "Closed tickets and their transcripts are kept here."}
              />
            }
          />
          {list.items.length < list.total && (
            <div className={styles.footer}>
              <Button onClick={() => void list.loadMore()} loading={list.loading}>
                Load more
              </Button>
            </div>
          )}
        </Card>
      )}
      {selected && <TicketDetail ticket={selected} onClose={() => setSelected(undefined)} onChanged={() => void list.reload()} />}
    </>
  );
};

const TicketDetail: React.FC<{ ticket: SupportTicket; onClose: () => void; onChanged: () => void }> = ({ ticket, onClose, onChanged }) => {
  const { isAdmin } = useSession();
  const open = ticket.status === SupportTicketStatus.OPEN;
  const transcript = useRpc(() => supportServiceClient.getTranscript({ id: ticket.id }), [ticket.id], {
    skip: open || !ticket.hasTranscript,
  });
  const [reason, setReason] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const close = useAction(() => supportServiceClient.closeTicket({ id: ticket.id, reason }), {
    success: `Ticket #${ticket.id} closed.`,
  });
  const remove = useAction(() => supportServiceClient.deleteTicket({ id: ticket.id }), { success: `Ticket #${ticket.id} deleted.` });
  const status = TICKET_STATUS[ticket.status];

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!close.busy}
      size="lg"
      title={`Ticket #${ticket.id}`}
      footer={
        <>
          {!open && isAdmin && (
            <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>
              Delete record
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={close.busy}>
            Done
          </Button>
          {open && (
            <Button
              variant="primary"
              icon="check"
              loading={close.busy}
              onClick={async () => {
                if (await close.run()) {
                  onChanged();
                  onClose();
                }
              }}
            >
              Close ticket
            </Button>
          )}
        </>
      }
    >
      <Stack gap={16}>
        <div className={styles.answers}>
          <Row label="Status">
            <Badge tone={status.tone}>{status.label}</Badge>
          </Row>
          <Row label="Opened by">
            {ticket.openerName} · {formatDateTime(ticket.openedAtMs)}
          </Row>
          {ticket.topic && <Row label="Topic">{ticket.topic}</Row>}
          {ticket.claimedByName && <Row label="Claimed by">{ticket.claimedByName}</Row>}
          {open ? (
            <Row label="Channel">
              <span className="tp-mono">#{ticket.channelName}</span>
            </Row>
          ) : (
            <Row label="Closed by">
              {ticket.closedByName} · {formatDateTime(ticket.closedAtMs)}
              {ticket.closeReason && ` · ${ticket.closeReason}`}
            </Row>
          )}
        </div>
        {open ? (
          <Field label="Reason (optional)" help="Shown in the transcript and the log channel, not to the member.">
            <TextInput value={reason} onChange={setReason} maxLength={300} placeholder="Resolved" />
          </Field>
        ) : !ticket.hasTranscript ? (
          <Banner tone="info">No transcript is saved for this ticket (its channel was deleted by hand, or the transcript expired).</Banner>
        ) : transcript.error ? (
          <ErrorState compact message={transcript.error} onRetry={() => void transcript.reload()} />
        ) : !transcript.data ? (
          <Spinner block label="Loading transcript…" />
        ) : (
          <div>
            <div className={styles.question}>Transcript · {plural(ticket.messageCount, "message")}</div>
            <pre className={styles.transcript}>{transcript.data.text}</pre>
          </div>
        )}
        {close.error && <Banner tone="error">{close.error}</Banner>}
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this ticket's record?"
        message="The ticket and its transcript are removed from Taproot for good. Messages already posted to the log channel stay."
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const ok = await remove.run();
          setConfirmDelete(false);
          if (ok) {
            onChanged();
            onClose();
          }
        }}
      />
    </Modal>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className={styles.question}>{label}</div>
    <div className={styles.answer}>{children}</div>
  </div>
);

export default Tickets;
