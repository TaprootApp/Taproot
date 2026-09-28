import { rootServer, ChannelGuid, MessageGuid, UserGuid } from "@rootsdk/server-app";
import { all, get, run } from "../../db";
import { write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { MAX_MESSAGE, userMention } from "../../lib/text";
import { nicknameOf } from "../../members";
import { memberRoleIds } from "../../permissions";
import { notifyChange } from "../../services/changes";
import { learnSelf } from "./tickets";
import { send } from "../../messaging";
import { AnsweredQuestion, formatSubmission, Question, SubmissionStatus } from "./logic";

// Forms: admin-built questionnaires (applications, appeals, reports) that
// members fill in on the Forms page. Submissions are stored, posted to the
// form's channel and reviewed by staff on the Submissions page. Bots have no
// modals in chat, so the GUI is the only way to fill a form.

export interface Form {
  id: number;
  title: string;
  description: string;
  questions: Question[];
  channel_id: string | null;
  role_id: string | null;
  one_per_member: boolean;
  enabled: boolean;
}

interface FormRow extends Omit<Form, "questions" | "one_per_member" | "enabled"> {
  questions: string;
  one_per_member: number;
  enabled: number;
}

export interface Submission {
  id: number;
  form_id: number;
  form_title: string;
  user_id: string;
  user_name: string;
  answers: AnsweredQuestion[];
  status: SubmissionStatus;
  note: string;
  reviewer_name: string;
  channel_id: string | null;
  message_id: string | null;
  created_at: number;
  updated_at: number;
}

interface SubmissionRow extends Omit<Submission, "answers"> {
  answers: string;
}

export async function createTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS support_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    questions TEXT NOT NULL,
    channel_id TEXT,
    role_id TEXT,
    one_per_member INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Answers are stored with their question text, so editing a form later
  // never changes what an old submission says.
  await run(`CREATE TABLE IF NOT EXISTS support_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id INTEGER NOT NULL,
    form_title TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    answers TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT NOT NULL DEFAULT '',
    reviewer_name TEXT NOT NULL DEFAULT '',
    channel_id TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_support_submissions_form ON support_submissions (form_id, id DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_support_submissions_user ON support_submissions (user_id, form_id)`);
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toForm(row: FormRow): Form {
  return { ...row, questions: parseJson(row.questions, []), one_per_member: Boolean(row.one_per_member), enabled: Boolean(row.enabled) };
}

function toSubmission(row: SubmissionRow): Submission {
  return { ...row, answers: parseJson(row.answers, []) };
}

// --- Forms ----------------------------------------------------------------------------

export async function listForms(): Promise<Form[]> {
  return (await all<FormRow>("SELECT * FROM support_forms ORDER BY id")).map(toForm);
}

export async function formById(id: number): Promise<Form | undefined> {
  const row = await get<FormRow>("SELECT * FROM support_forms WHERE id = ?", [id]);
  return row && toForm(row);
}

export async function formCounts(): Promise<Map<number, { total: number; pending: number }>> {
  const rows = await all<{ form_id: number; total: number; pending: number }>(
    "SELECT form_id, COUNT(*) AS total, SUM(status = 'pending') AS pending FROM support_submissions GROUP BY form_id",
  );
  return new Map(rows.map((r) => [r.form_id, { total: r.total, pending: r.pending ?? 0 }]));
}

/** Creates (id 0) or replaces a form. Callers validate first. */
export async function saveForm(id: number, form: Omit<Form, "id">): Promise<number> {
  const now = Date.now();
  const values = [
    form.title,
    form.description,
    JSON.stringify(form.questions),
    form.channel_id,
    form.role_id,
    form.one_per_member ? 1 : 0,
    form.enabled ? 1 : 0,
    now,
  ];
  let savedId = id;
  if (id) {
    await run(
      "UPDATE support_forms SET title = ?, description = ?, questions = ?, channel_id = ?, role_id = ?, one_per_member = ?, enabled = ?, updated_at = ? WHERE id = ?",
      [...values, id],
    );
  } else {
    savedId = (
      await run(
        "INSERT INTO support_forms (title, description, questions, channel_id, role_id, one_per_member, enabled, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [...values, now],
      )
    ).lastID;
  }
  notifyChange("support:forms");
  return savedId;
}

/** Deletes the form and its submissions. */
export async function deleteForm(id: number): Promise<boolean> {
  const { changes } = await run("DELETE FROM support_forms WHERE id = ?", [id]);
  if (!changes) return false;
  await run("DELETE FROM support_submissions WHERE form_id = ?", [id]);
  notifyChange("support:forms");
  notifyChange("support:submissions");
  return true;
}

/** Why `userId` can't submit `form` right now, or undefined if they can. */
export async function submitBlocker(form: Form, userId: UserGuid): Promise<string | undefined> {
  if (!form.enabled) return "This form isn't taking submissions right now.";
  if (form.role_id && !(await memberRoleIds(userId)).includes(form.role_id as never)) {
    return "This form is only for members with a certain role.";
  }
  if (form.one_per_member) {
    const existing = await get<{ n: number }>("SELECT COUNT(*) AS n FROM support_submissions WHERE form_id = ? AND user_id = ?", [
      form.id,
      userId,
    ]);
    if ((existing?.n ?? 0) > 0) return "You've already sent this form.";
  }
  return undefined;
}

// --- Submissions ---------------------------------------------------------------------

export async function submissionById(id: number): Promise<Submission | undefined> {
  const row = await get<SubmissionRow>("SELECT * FROM support_submissions WHERE id = ?", [id]);
  return row && toSubmission(row);
}

export async function listSubmissions(formId: number, status: SubmissionStatus | undefined, offset: number, limit: number) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (formId) {
    where.push("form_id = ?");
    params.push(formId);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, total] = await Promise.all([
    all<SubmissionRow>(`SELECT * FROM support_submissions ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]),
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM support_submissions ${clause}`, params),
  ]);
  return { rows: rows.map(toSubmission), total: total?.n ?? 0 };
}

export async function listMySubmissions(userId: string): Promise<Submission[]> {
  return (await all<SubmissionRow>("SELECT * FROM support_submissions WHERE user_id = ? ORDER BY id DESC LIMIT 50", [userId])).map(
    toSubmission,
  );
}

function render(s: Submission): string {
  return formatSubmission({
    id: s.id,
    formTitle: s.form_title,
    userMention: userMention(s.user_name, s.user_id),
    answers: s.answers,
    status: s.status,
    reviewer: s.reviewer_name,
    note: s.note,
    maxLength: MAX_MESSAGE,
  });
}

/** Stores a checked submission and posts it to the form's channel. */
export async function createSubmission(form: Form, userId: UserGuid, answers: AnsweredQuestion[]): Promise<Submission> {
  const now = Date.now();
  const name = await nicknameOf(userId);
  const { lastID } = await run(
    "INSERT INTO support_submissions (form_id, form_title, user_id, user_name, answers, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    [form.id, form.title, userId, name, JSON.stringify(answers), now, now],
  );
  const submission = (await submissionById(lastID))!;
  if (form.channel_id) {
    try {
      const msg = await send(form.channel_id, render(submission));
      await learnSelf(msg);
      await run("UPDATE support_submissions SET channel_id = ?, message_id = ? WHERE id = ?", [form.channel_id, msg.id, lastID]);
    } catch (err) {
      // Stored either way; staff still see it on the Submissions page.
      log("warn", "form submission post failed", { error: errMessage(err) });
    }
  }
  notifyChange("support:submissions");
  return (await submissionById(lastID))!;
}

/** Sets a submission's status and note, updates its posted message and pings the member. */
export async function reviewSubmission(s: Submission, status: SubmissionStatus, note: string, reviewerId: UserGuid): Promise<Submission> {
  const reviewer = await nicknameOf(reviewerId);
  await run("UPDATE support_submissions SET status = ?, note = ?, reviewer_name = ?, updated_at = ? WHERE id = ?", [
    status,
    note,
    reviewer,
    Date.now(),
    s.id,
  ]);
  const updated = (await submissionById(s.id))!;
  notifyChange("support:submissions");
  if (updated.channel_id && updated.message_id) {
    await write("channelMessages.edit", () =>
      rootServer.community.channelMessages.edit({
        channelId: updated.channel_id as ChannelGuid,
        id: updated.message_id as MessageGuid,
        content: render(updated),
      }),
    ).catch((err) => log("warn", "submission message edit failed", { error: errMessage(err) }));
  }
  if (status !== s.status && status !== "pending") {
    // Generic on purpose: notifications show on lock screens, and a form may be an appeal.
    await write("notifications.send", () =>
      rootServer.community.notifications.send({
        userIds: [updated.user_id as UserGuid],
        title: "Form update",
        description: "One of your form submissions was reviewed. See it on your Me page in the Taproot channel.",
      }),
    ).catch(() => undefined);
  }
  return updated;
}

export async function deleteSubmission(id: number): Promise<boolean> {
  const s = await submissionById(id);
  if (!s) return false;
  await run("DELETE FROM support_submissions WHERE id = ?", [id]);
  if (s.channel_id && s.message_id) {
    await write("channelMessages.delete", () =>
      rootServer.community.channelMessages.delete({ channelId: s.channel_id as ChannelGuid, id: s.message_id as MessageGuid }),
    ).catch(() => undefined);
  }
  notifyChange("support:submissions");
  return true;
}
