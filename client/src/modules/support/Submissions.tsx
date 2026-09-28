import React, { useEffect, useState } from "react";
import type { SupportSubmission } from "@taproot/gen-shared";
import { SupportSubmissionStatus } from "@taproot/gen-shared";
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
  Select,
  Stack,
  Table,
  TextArea,
} from "../../components";
import type { Column, SelectOption } from "../../components";
import { formatDateTime, formatRelative, NavLink, useAction, useNav, useRpc, useSession } from "../../lib";
import { SUBMISSION_STATUS, useSupportChanged, usePaged } from "./shared";
import styles from "./support.module.css";

// Submissions (moderator+): everything members sent through forms, filtered
// by form and status. Staff accept, deny or close each one with a note; the
// member sees the result on their Me page.

const STATUS_OPTIONS: SelectOption<number>[] = [
  { value: SupportSubmissionStatus.UNSPECIFIED, label: "Any status" },
  { value: SupportSubmissionStatus.PENDING, label: "Pending" },
  { value: SupportSubmissionStatus.ACCEPTED, label: "Accepted" },
  { value: SupportSubmissionStatus.DENIED, label: "Denied" },
  { value: SupportSubmissionStatus.CLOSED, label: "Closed" },
];

const Submissions: React.FC = () => {
  const { isAdmin } = useSession();
  const { params } = useNav();
  const [formId, setFormId] = useState<number>(Number(params?.formId) || 0);
  const [status, setStatus] = useState<number>(SupportSubmissionStatus.PENDING);
  // Staff can't list forms (the builder is admin-only), so the filter is
  // built from the submissions' own form titles.
  const [formNames, setFormNames] = useState<Map<number, string>>(new Map());
  const list = usePaged(async (offset, limit) => {
    const page = await supportServiceClient.listSubmissions({ formId, status, offset, limit });
    return { items: page.submissions, total: page.total };
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void list.reload(), [formId, status]);
  useSupportChanged(["support:submissions", "support:forms"], () => void list.reload());
  const allForms = useRpc(() => supportServiceClient.listForms(), [], { skip: !isAdmin });
  useEffect(() => {
    setFormNames((prev) => {
      const next = new Map(prev);
      for (const s of list.items) next.set(s.formId, s.formTitle);
      for (const f of allForms.data?.forms ?? []) next.set(f.id, f.title);
      return next;
    });
  }, [list.items, allForms.data]);
  const [selected, setSelected] = useState<SupportSubmission | undefined>(undefined);

  const formOptions: SelectOption<number>[] = [
    { value: 0, label: "All forms" },
    ...[...formNames.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, title]) => ({ value: id, label: title })),
  ];

  const columns: Column<SupportSubmission>[] = [
    { key: "id", header: "#", width: "56px", render: (s) => <span className="tp-mono">{s.id}</span> },
    {
      key: "who",
      header: "Member",
      render: (s) => (
        <div>
          <div>{s.userName}</div>
          <div className={styles.meta}>{s.formTitle}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      render: (s) => <Badge tone={SUBMISSION_STATUS[s.status].tone}>{SUBMISSION_STATUS[s.status].label}</Badge>,
    },
    {
      key: "when",
      header: "Sent",
      align: "right",
      width: "110px",
      hideOnMobile: true,
      render: (s) => <span title={formatDateTime(s.createdAtMs)}>{formatRelative(s.createdAtMs)}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Submissions"
        description={
          isAdmin ? (
            <>
              What members sent through forms. Build forms on the <NavLink to="formBuilder">Form builder</NavLink> page.
            </>
          ) : (
            "What members sent through forms."
          )
        }
      />
      {list.error && list.items.length === 0 ? (
        <Card>
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        </Card>
      ) : (
        <Card padded={false}>
          <div className={styles.toolbar}>
            <Select<number> value={formId} onChange={setFormId} options={formOptions} />
            <Select<number> value={status} onChange={setStatus} options={STATUS_OPTIONS} />
            <span className="tp-subtle">{list.total.toLocaleString()} found</span>
          </div>
          <Table
            columns={columns}
            rows={list.items}
            rowKey={(s) => s.id}
            onRowClick={setSelected}
            loading={list.loading && list.items.length === 0}
            empty={
              <EmptyState
                icon={<Icon name="clipboard" size={28} />}
                title="Nothing here"
                description={status === SupportSubmissionStatus.PENDING ? "No submissions are waiting for review." : "No submissions match these filters."}
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
      {selected && (
        <Review
          submission={selected}
          canDelete={isAdmin}
          onClose={() => setSelected(undefined)}
          onSaved={(s) => {
            list.replace(s, (a, b) => a.id === b.id);
            setSelected(undefined);
          }}
          onDeleted={() => {
            setSelected(undefined);
            void list.reload();
          }}
        />
      )}
    </>
  );
};

const REVIEW_OPTIONS: SelectOption<number>[] = STATUS_OPTIONS.filter((o) => o.value !== SupportSubmissionStatus.UNSPECIFIED);

const Review: React.FC<{
  submission: SupportSubmission;
  canDelete: boolean;
  onClose: () => void;
  onSaved: (s: SupportSubmission) => void;
  onDeleted: () => void;
}> = ({ submission, canDelete, onClose, onSaved, onDeleted }) => {
  const [status, setStatus] = useState<number>(
    submission.status === SupportSubmissionStatus.PENDING ? SupportSubmissionStatus.ACCEPTED : submission.status,
  );
  const [note, setNote] = useState(submission.note);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useAction(() => supportServiceClient.reviewSubmission({ id: submission.id, status, note }), {
    success: "Submission updated. The member was notified.",
    toastError: false,
  });
  const remove = useAction(() => supportServiceClient.deleteSubmission({ id: submission.id }), { success: "Submission deleted." });
  const current = SUBMISSION_STATUS[submission.status];

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!save.busy}
      size="lg"
      title={`${submission.formTitle} · #${submission.id}`}
      footer={
        <>
          {canDelete && (
            <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.busy}
            onClick={async () => {
              const result = await save.run();
              if (result) onSaved(result);
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <div className={styles.meta}>
          From <strong>{submission.userName}</strong> · {formatDateTime(submission.createdAtMs)} ·{" "}
          <Badge tone={current.tone}>{current.label}</Badge>
          {submission.reviewerName && submission.status !== SupportSubmissionStatus.PENDING && ` by ${submission.reviewerName}`}
        </div>
        <div className={styles.answers}>
          {submission.answers.map((a, i) => (
            <div key={i}>
              <div className={styles.question}>{a.label}</div>
              <div className={styles.answer}>{a.value}</div>
            </div>
          ))}
        </div>
        <div className={styles.grid}>
          <Field label="Status">
            <Select<number> value={status} onChange={setStatus} options={REVIEW_OPTIONS} />
          </Field>
        </div>
        <Field label="Note (optional)" help="The member sees this note with the status on their Me page.">
          <TextArea value={note} onChange={setNote} maxLength={1000} rows={3} placeholder="Thanks for applying!" />
        </Field>
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this submission?"
        message="It's removed from Taproot for good, along with the message posted for it. The member can send the form again."
        confirmLabel="Delete"
        danger
        busy={remove.busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const ok = await remove.run();
          setConfirmDelete(false);
          if (ok) onDeleted();
        }}
      />
    </Modal>
  );
};

export default Submissions;
