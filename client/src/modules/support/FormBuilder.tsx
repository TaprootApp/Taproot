import React, { useState } from "react";
import type { SupportForm, SupportFormList, SupportQuestion } from "@taproot/gen-shared";
import { SupportQuestionType } from "@taproot/gen-shared";
import { supportServiceClient } from "@taproot/gen-client";
import {
  Badge,
  Banner,
  Button,
  Card,
  ChannelSelect,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Modal,
  PageHeader,
  RoleSelect,
  Select,
  Spinner,
  Stack,
  TextArea,
  TextInput,
  Toggle,
} from "../../components";
import type { SelectOption } from "../../components";
import { NavLink, plural, useAction, useRpc } from "../../lib";
import { useSupportChanged } from "./shared";
import styles from "./support.module.css";

// Form builder (admin): applications, appeals and request forms members
// fill in on the Forms page. Limits mirror FORM_LIMITS in
// server/src/modules/support/logic.ts; the server validates everything.

const MAX_QUESTIONS = 25;
const MAX_CHOICES = 20;

const TYPE_OPTIONS: SelectOption<number>[] = [
  { value: SupportQuestionType.SHORT, label: "Short answer" },
  { value: SupportQuestionType.LONG, label: "Paragraph" },
  { value: SupportQuestionType.CHOICE, label: "Multiple choice" },
];

const TYPE_LABEL: Record<number, string> = {
  [SupportQuestionType.SHORT]: "short answer",
  [SupportQuestionType.LONG]: "paragraph",
  [SupportQuestionType.CHOICE]: "multiple choice",
};

const emptyQuestion = (): SupportQuestion => ({ id: "", label: "", type: SupportQuestionType.SHORT, required: true, choices: [] });

const emptyForm = (): SupportForm => ({
  id: 0,
  title: "",
  description: "",
  questions: [emptyQuestion()],
  channelId: undefined,
  channelName: "",
  roleId: "",
  onePerMember: true,
  enabled: true,
  submissionCount: 0,
  pendingCount: 0,
});

/** Starting points for common forms. */
const TEMPLATES: Array<{ name: string; form: () => SupportForm }> = [
  {
    name: "Staff application",
    form: () => ({
      ...emptyForm(),
      title: "Staff application",
      description: "Want to help run the community? Tell us about yourself.",
      questions: [
        { id: "", label: "How old are you?", type: SupportQuestionType.SHORT, required: true, choices: [] },
        { id: "", label: "Which time zone are you in?", type: SupportQuestionType.SHORT, required: true, choices: [] },
        { id: "", label: "Why do you want to join the staff?", type: SupportQuestionType.LONG, required: true, choices: [] },
        {
          id: "",
          label: "How active are you?",
          type: SupportQuestionType.CHOICE,
          required: true,
          choices: ["Every day", "A few times a week", "Weekends"],
        },
      ],
    }),
  },
  {
    name: "Mute or warning appeal",
    form: () => ({
      ...emptyForm(),
      title: "Appeal",
      description: "Think a mute or warning was a mistake? Tell us what happened.",
      onePerMember: false,
      questions: [
        { id: "", label: "Which case are you appealing? (number, if you know it)", type: SupportQuestionType.SHORT, required: false, choices: [] },
        { id: "", label: "What happened, and why should it be lifted?", type: SupportQuestionType.LONG, required: true, choices: [] },
      ],
    }),
  },
];

const FormBuilder: React.FC = () => {
  const list = useRpc(() => supportServiceClient.listForms());
  useSupportChanged(["support:forms", "support:submissions"], () => void list.reload());
  const [editing, setEditing] = useState<SupportForm | undefined>(undefined);
  const [deleting, setDeleting] = useState<SupportForm | undefined>(undefined);
  const remove = useAction((id: number) => supportServiceClient.deleteForm({ id }), { success: "Form deleted." });
  const forms = list.data?.forms ?? [];

  let body: React.ReactNode;
  if (list.error && !list.data) body = <ErrorState message={list.error} onRetry={() => void list.reload()} />;
  else if (!list.data) body = <Spinner block />;
  else if (forms.length === 0) {
    body = (
      <EmptyState
        icon={<Icon name="clipboard" size={28} />}
        title="No forms yet"
        description="Build an application, an appeal or any other form. Members fill it in on the Forms page."
        action={
          <Stack gap={8}>
            <Button variant="primary" icon="plus" onClick={() => setEditing(emptyForm())}>
              New form
            </Button>
            {TEMPLATES.map((t) => (
              <Button key={t.name} variant="quiet" onClick={() => setEditing(t.form())}>
                Start from “{t.name}”
              </Button>
            ))}
          </Stack>
        }
      />
    );
  } else {
    body = (
      <div className={styles.list}>
        {forms.map((f) => (
          <div key={f.id} className={styles.row}>
            <div className={styles.main}>
              <div className={styles.title}>
                {f.title} {!f.enabled && <Badge>Closed</Badge>}
              </div>
              <div className={styles.meta}>
                {plural(f.questions.length, "question")} · {f.channelName ? `posts to #${f.channelName}` : "not posted to a channel"} ·{" "}
                {f.onePerMember ? "once per member" : "unlimited"} ·{" "}
                <NavLink to="submissions" params={{ formId: String(f.id) }}>
                  {plural(f.submissionCount, "submission")}
                  {f.pendingCount > 0 && `, ${f.pendingCount} pending`}
                </NavLink>
              </div>
            </div>
            <IconButton icon="edit" label={`Edit ${f.title}`} onClick={() => setEditing(f)} />
            <IconButton icon="trash" label={`Delete ${f.title}`} danger onClick={() => setDeleting(f)} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Form builder"
        description="Applications, appeals and requests members fill in on the Forms page."
        actions={
          forms.length > 0 && (
            <Button variant="primary" icon="plus" onClick={() => setEditing(emptyForm())}>
              New form
            </Button>
          )
        }
      />
      <Stack gap={16}>
        <Banner tone="info" title="About appeals">
          Banned members can't open Root communities, so they can't reach this form. Appeal forms work for mutes and
          warnings; ban appeals need another way in (like a second community or an email).
        </Banner>
        <Card padded={false}>{body}</Card>
      </Stack>
      {editing && (
        <FormEditor
          form={editing}
          onClose={() => setEditing(undefined)}
          onSaved={(result) => {
            list.setData(result);
            setEditing(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete this form?"
        message={
          deleting && (
            <>
              <strong>{deleting.title}</strong> and its {plural(deleting.submissionCount, "submission")} are deleted for good.
              Messages already posted stay.
            </>
          )
        }
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

function localProblem(f: SupportForm): string | undefined {
  if (!f.title.trim()) return "Give the form a title.";
  if (f.questions.length === 0) return "Add at least one question.";
  for (const [i, q] of f.questions.entries()) {
    if (!q.label.trim()) return `Question ${i + 1} needs some text.`;
    if (q.type === SupportQuestionType.CHOICE && q.choices.filter((c) => c.trim()).length < 2) {
      return `Question ${i + 1} needs at least 2 choices.`;
    }
  }
  return undefined;
}

const FormEditor: React.FC<{ form: SupportForm; onClose: () => void; onSaved: (list: SupportFormList) => void }> = ({
  form,
  onClose,
  onSaved,
}) => {
  const [draft, setDraft] = useState<SupportForm>(form);
  const [touched, setTouched] = useState(false);
  const save = useAction(() => supportServiceClient.saveForm(draft), {
    success: form.id ? "Form saved." : "Form created. Members can fill it in on the Forms page.",
    toastError: false,
  });
  const patch = (change: Partial<SupportForm>) => setDraft((d) => ({ ...d, ...change }));
  const setQuestion = (i: number, change: Partial<SupportQuestion>) =>
    setDraft((d) => ({ ...d, questions: d.questions.map((q, j) => (j === i ? { ...q, ...change } : q)) }));
  const move = (i: number, by: number) =>
    setDraft((d) => {
      const questions = [...d.questions];
      const [q] = questions.splice(i, 1);
      questions.splice(i + by, 0, q);
      return { ...d, questions };
    });
  const problem = localProblem(draft);

  const submit = async () => {
    setTouched(true);
    if (problem) return;
    const result = await save.run();
    if (result) onSaved(result);
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!save.busy}
      size="lg"
      title={form.id ? `Edit ${form.title}` : "New form"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.busy}>
            {form.id ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        <Field label="Title">
          <TextInput value={draft.title} onChange={(title) => patch({ title })} maxLength={100} placeholder="Staff application" autoFocus />
        </Field>
        <Field label="Description (optional)" help="Shown at the top of the form.">
          <TextArea value={draft.description} onChange={(description) => patch({ description })} maxLength={1000} rows={2} />
        </Field>
        <div className={styles.grid}>
          <Field label="Post submissions to" help="Use a staff-only channel.">
            <ChannelSelect value={draft.channelId} onChange={(channelId) => patch({ channelId })} noneLabel="Don't post (GUI only)" />
          </Field>
          <Field label="Who can fill it in">
            <RoleSelect value={draft.roleId || undefined} onChange={(roleId) => patch({ roleId: roleId ?? "" })} noneLabel="Everyone" />
          </Field>
        </div>
        <Toggle
          checked={draft.onePerMember}
          onChange={(onePerMember) => patch({ onePerMember })}
          label="One submission per member"
          description="Deleting a member's submission lets them send it again."
        />
        <Toggle
          checked={draft.enabled}
          onChange={(enabled) => patch({ enabled })}
          label="Taking submissions"
          description="Turn off to hide the form without deleting it."
        />

        <div className={styles.question}>Questions</div>
        {draft.questions.map((q, i) => (
          <div key={i} className={styles.questionCard}>
            <div className={styles.questionHead}>
              <span className={styles.meta}>
                Question {i + 1} · {TYPE_LABEL[q.type] ?? "question"}
              </span>
              <IconButton icon="chevronLeft" label="Move up" disabled={i === 0} onClick={() => move(i, -1)} style={{ transform: "rotate(90deg)" }} />
              <IconButton
                icon="chevronRight"
                label="Move down"
                disabled={i === draft.questions.length - 1}
                onClick={() => move(i, 1)}
                style={{ transform: "rotate(90deg)" }}
              />
              <IconButton
                icon="trash"
                label="Remove question"
                danger
                disabled={draft.questions.length === 1}
                onClick={() => patch({ questions: draft.questions.filter((_, j) => j !== i) })}
              />
            </div>
            <TextInput value={q.label} onChange={(label) => setQuestion(i, { label })} maxLength={200} placeholder="Your question" />
            <div className={styles.grid}>
              <Select<number> value={q.type} onChange={(type) => setQuestion(i, { type })} options={TYPE_OPTIONS} />
              <Toggle checked={q.required} onChange={(required) => setQuestion(i, { required })} label="Required" />
            </div>
            {q.type === SupportQuestionType.CHOICE && (
              <Field label="Choices" help="One per line, 2 to 20.">
                <TextArea
                  value={q.choices.join("\n")}
                  onChange={(text) => setQuestion(i, { choices: text.split("\n").slice(0, MAX_CHOICES) })}
                  rows={3}
                  placeholder={"Yes\nNo"}
                />
              </Field>
            )}
          </div>
        ))}
        <div>
          <Button icon="plus" disabled={draft.questions.length >= MAX_QUESTIONS} onClick={() => patch({ questions: [...draft.questions, emptyQuestion()] })}>
            Add question
          </Button>
        </div>
        {touched && problem && <Banner tone="warning">{problem}</Banner>}
        {save.error && <Banner tone="error">{save.error}</Banner>}
      </Stack>
    </Modal>
  );
};

export default FormBuilder;
