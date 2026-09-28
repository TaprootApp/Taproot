import React, { useState } from "react";
import type { SupportAvailableForm } from "@taproot/gen-shared";
import { SupportQuestionType } from "@taproot/gen-shared";
import { supportServiceClient } from "@taproot/gen-client";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  Stack,
  TextArea,
  TextInput,
} from "../../components";
import { NavLink, plural, useAction, useRpc } from "../../lib";
import { useSupportChanged } from "./shared";
import styles from "./support.module.css";

// Forms (everyone): applications, appeals and requests the admins built.
// Members fill them in here; the server checks every answer again.

/** Mirrors FORM_LIMITS in server/src/modules/support/logic.ts. */
const SHORT_MAX = 200;
const LONG_MAX = 2000;

const Forms: React.FC = () => {
  const list = useRpc(() => supportServiceClient.listAvailableForms());
  useSupportChanged(["support:forms", "support:submissions"], () => void list.reload());
  const [filling, setFilling] = useState<SupportAvailableForm | undefined>(undefined);
  const forms = list.data?.forms ?? [];

  let body: React.ReactNode;
  if (list.error && !list.data) body = <ErrorState message={list.error} onRetry={() => void list.reload()} />;
  else if (!list.data) body = <Spinner block />;
  else if (forms.length === 0) {
    body = (
      <EmptyState
        icon={<Icon name="clipboard" size={28} />}
        title="No forms right now"
        description="When the staff open applications or other forms, they show up here."
      />
    );
  } else {
    body = (
      <div className={styles.list}>
        {forms.map((f) => (
          <div key={f.id} className={styles.row}>
            <div className={styles.main}>
              <div className={styles.title}>{f.title}</div>
              <div className={styles.meta}>
                {f.blockedReason || (f.description ? f.description : plural(f.questions.length, "question"))}
              </div>
            </div>
            <Button variant={f.blockedReason ? "secondary" : "primary"} disabled={!!f.blockedReason} onClick={() => setFilling(f)}>
              Fill in
            </Button>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Forms"
        description={
          <>
            Apply, appeal or ask the staff for something. See what happened to what you sent on your{" "}
            <NavLink to="me">Me</NavLink> page.
          </>
        }
      />
      <Card padded={false}>{body}</Card>
      {filling && (
        <FillForm
          form={filling}
          onClose={() => setFilling(undefined)}
          onSent={() => {
            setFilling(undefined);
            void list.reload();
          }}
        />
      )}
    </>
  );
};

const FillForm: React.FC<{ form: SupportAvailableForm; onClose: () => void; onSent: () => void }> = ({ form, onClose, onSent }) => {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const submit = useAction(
    () =>
      supportServiceClient.submitForm({
        formId: form.id,
        answers: Object.entries(answers).map(([questionId, value]) => ({ questionId, value })),
      }),
    { success: "Sent! The staff will take a look.", toastError: false },
  );
  const missing = form.questions.filter((q) => q.required && !(answers[q.id] ?? "").trim());
  const set = (id: string, value: string) => setAnswers((a) => ({ ...a, [id]: value }));

  const send = async () => {
    setTouched(true);
    if (missing.length > 0) return;
    if (await submit.run()) onSent();
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!submit.busy}
      size="lg"
      title={form.title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submit.busy}>
            Cancel
          </Button>
          <Button variant="primary" icon="send" loading={submit.busy} onClick={send}>
            Send
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        {form.description && <p className={styles.hint} style={{ whiteSpace: "pre-wrap" }}>{form.description}</p>}
        {form.questions.map((q) => {
          const value = answers[q.id] ?? "";
          const error = touched && q.required && !value.trim() ? "This one needs an answer." : undefined;
          const label = (
            <>
              {q.label}
              {!q.required && <span className={styles.required}> (optional)</span>}
            </>
          );
          if (q.type === SupportQuestionType.CHOICE) {
            return (
              <Field key={q.id} label={label} error={error}>
                <div className={styles.choices} role="radiogroup">
                  {q.choices.map((c) => (
                    <label key={c} className={styles.choice}>
                      <input type="radio" name={`q-${q.id}`} checked={value === c} onChange={() => set(q.id, c)} />
                      {c}
                    </label>
                  ))}
                </div>
              </Field>
            );
          }
          return (
            <Field key={q.id} label={label} error={error}>
              {q.type === SupportQuestionType.LONG ? (
                <TextArea value={value} onChange={(v) => set(q.id, v)} maxLength={LONG_MAX} rows={4} showCount />
              ) : (
                <TextInput value={value} onChange={(v) => set(q.id, v)} maxLength={SHORT_MAX} />
              )}
            </Field>
          );
        })}
        {submit.error && <Banner tone="error">{submit.error}</Banner>}
      </Stack>
    </Modal>
  );
};

export default Forms;
