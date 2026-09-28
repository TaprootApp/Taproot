// Pure helpers for tickets and forms: channel names, transcripts, form and
// answer validation, message formatting. No SDK imports, so the tests can
// cover them without a Root connection.

// --- Channel names --------------------------------------------------------------

/**
 * Root channel names are 1-100 letters, digits and hyphens, with no leading,
 * trailing or doubled hyphens. Anything else becomes a hyphen; accents are
 * dropped. Undefined when nothing usable is left.
 */
export function sanitizeChannelName(input: string, max = 100): string | undefined {
  const name = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .slice(0, max)
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || undefined;
}

/** "ticket-12-alice", or "ticket-12" when the nickname has no usable letters. */
export function ticketChannelName(id: number, nickname: string): string {
  const base = `ticket-${id}`;
  const slug = sanitizeChannelName(nickname.toLowerCase(), 30);
  return slug ? `${base}-${slug}` : base;
}

// --- Mentions ---------------------------------------------------------------------

/**
 * Turns Root mention links ("[@Ann](root://user/..)") into their plain text so
 * text Taproot re-posts (form answers, transcripts) never pings anyone.
 */
export function defuseMentions(text: string): string {
  return text.replace(/\[([^\]]*)\]\(root:\/\/[^)\s]*\)/g, "$1");
}

// --- Transcripts ------------------------------------------------------------------

export interface TranscriptMessage {
  atMs: number;
  author: string;
  content: string;
  attachments: string[];
  edited: boolean;
}

export interface TranscriptHeader {
  id: number;
  topic: string;
  opener: string;
  openedAtMs: number;
  closedBy: string;
  closedAtMs: number;
  reason: string;
}

/** "2026-09-28 14:03 UTC". */
export function utcStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Longest transcript kept; older messages are cut from the top. */
export const MAX_TRANSCRIPT = 500_000;

export function formatTranscript(header: TranscriptHeader, messages: TranscriptMessage[], truncated = false): string {
  const lines = [
    `Ticket #${header.id}${header.topic ? ` · ${header.topic}` : ""}`,
    `Opened by ${header.opener} · ${utcStamp(header.openedAtMs)}`,
    `Closed by ${header.closedBy} · ${utcStamp(header.closedAtMs)}${header.reason ? ` · ${header.reason}` : ""}`,
    `${messages.length} message${messages.length === 1 ? "" : "s"}${truncated ? " (older messages were not saved)" : ""}`,
    "",
  ];
  for (const m of [...messages].sort((a, b) => a.atMs - b.atMs)) {
    const body = defuseMentions(m.content).trim();
    const extra = m.attachments.map((a) => `[attachment: ${a}]`);
    const text = [body, ...extra].filter(Boolean).join(" ") || "[no text]";
    lines.push(`[${utcStamp(m.atMs)}] ${m.author}${m.edited ? " (edited)" : ""}: ${text}`);
  }
  let out = lines.join("\n");
  if (out.length > MAX_TRANSCRIPT) out = `${out.slice(0, MAX_TRANSCRIPT - 40)}\n[transcript cut off at the size limit]`;
  return out;
}

/**
 * Splits text into chunks of at most `size` characters, breaking at newlines
 * where possible and hard-splitting lines longer than a chunk.
 */
export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const raw of text.split("\n")) {
    let line = raw;
    while (line.length > size) {
      push();
      chunks.push(line.slice(0, size));
      line = line.slice(size);
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > size) {
      push();
      current = line;
    } else {
      current = next;
    }
  }
  push();
  return chunks;
}

/**
 * Transcript text as code-block messages for the log channel. Code blocks
 * keep member formatting inert; backtick fences inside are broken up.
 * Returns undefined when it would take more than `maxMessages`.
 */
export function transcriptMessages(text: string, maxMessage: number, maxMessages: number): string[] | undefined {
  const safe = text.replace(/```/g, "`​``");
  const chunks = chunkText(safe, maxMessage - 20);
  if (chunks.length > maxMessages) return undefined;
  return chunks.map((c) => "```\n" + c + "\n```");
}

// --- Forms ------------------------------------------------------------------------

export type QuestionType = "short" | "long" | "choice";

export interface Question {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  choices: string[];
}

export interface FormInput {
  title: string;
  description: string;
  questions: Array<Partial<Question> & { label: string; type: QuestionType | undefined }>;
}

export const FORM_LIMITS = {
  title: 100,
  description: 1000,
  questions: 25,
  label: 200,
  choices: 20,
  choice: 100,
  short: 200,
  long: 2000,
};

const QUESTION_ID = /^[a-z0-9]{1,16}$/;

/**
 * Checks what the form builder sent and normalizes it. Questions keep their
 * id when it's valid and unique, so existing submissions still line up;
 * new questions get the next free "q<n>".
 */
export function validateForm(input: FormInput): { form: { title: string; description: string; questions: Question[] } } | { problem: string } {
  const title = input.title.trim();
  if (!title) return { problem: "Give the form a title." };
  if (title.length > FORM_LIMITS.title) return { problem: `The title can be up to ${FORM_LIMITS.title} characters.` };
  const description = input.description.trim();
  if (description.length > FORM_LIMITS.description) {
    return { problem: `The description can be up to ${FORM_LIMITS.description} characters.` };
  }
  if (input.questions.length === 0) return { problem: "Add at least one question." };
  if (input.questions.length > FORM_LIMITS.questions) return { problem: `A form can have up to ${FORM_LIMITS.questions} questions.` };

  const used = new Set<string>();
  for (const q of input.questions) if (q.id && QUESTION_ID.test(q.id) && !used.has(q.id)) used.add(q.id);
  const taken = new Set<string>();
  let counter = 1;
  const nextId = () => {
    while (used.has(`q${counter}`) || taken.has(`q${counter}`)) counter++;
    return `q${counter}`;
  };

  const questions: Question[] = [];
  for (const [i, q] of input.questions.entries()) {
    const n = i + 1;
    const label = q.label.trim();
    if (!label) return { problem: `Question ${n} needs some text.` };
    if (label.length > FORM_LIMITS.label) return { problem: `Question ${n} can be up to ${FORM_LIMITS.label} characters.` };
    if (q.type !== "short" && q.type !== "long" && q.type !== "choice") return { problem: `Question ${n} needs a type.` };
    let choices: string[] = [];
    if (q.type === "choice") {
      choices = (q.choices ?? []).map((c) => c.trim()).filter(Boolean);
      if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) {
        return { problem: `Question ${n} has the same choice twice.` };
      }
      if (choices.length < 2) return { problem: `Question ${n} needs at least 2 choices.` };
      if (choices.length > FORM_LIMITS.choices) return { problem: `Question ${n} can have up to ${FORM_LIMITS.choices} choices.` };
      if (choices.some((c) => c.length > FORM_LIMITS.choice)) {
        return { problem: `Choices can be up to ${FORM_LIMITS.choice} characters (question ${n}).` };
      }
    }
    const id = q.id && QUESTION_ID.test(q.id) && !taken.has(q.id) ? q.id : nextId();
    taken.add(id);
    questions.push({ id, label, type: q.type, required: Boolean(q.required), choices });
  }
  return { form: { title, description, questions } };
}

export interface AnsweredQuestion {
  label: string;
  value: string;
}

/**
 * Checks a member's answers against the form's questions. Returns the answers
 * in question order (skipped optional questions left out).
 */
export function validateAnswers(
  questions: Question[],
  answers: Array<{ questionId: string; value: string }>,
): { answers: AnsweredQuestion[] } | { problem: string } {
  const byId = new Map<string, string>();
  for (const a of answers) byId.set(a.questionId, a.value);
  const out: AnsweredQuestion[] = [];
  for (const [i, q] of questions.entries()) {
    const n = i + 1;
    let value = (byId.get(q.id) ?? "").trim();
    if (q.type === "short") value = value.replace(/\s*\n\s*/g, " ");
    if (!value) {
      if (q.required) return { problem: `Question ${n} ("${q.label}") needs an answer.` };
      continue;
    }
    if (q.type === "short" && value.length > FORM_LIMITS.short) {
      return { problem: `The answer to question ${n} can be up to ${FORM_LIMITS.short} characters.` };
    }
    if (q.type === "long" && value.length > FORM_LIMITS.long) {
      return { problem: `The answer to question ${n} can be up to ${FORM_LIMITS.long} characters.` };
    }
    if (q.type === "choice") {
      const match = q.choices.find((c) => c.toLowerCase() === value.toLowerCase());
      if (!match) return { problem: `Pick one of the choices for question ${n}.` };
      value = match;
    }
    out.push({ label: q.label, value });
  }
  if (out.length === 0) return { problem: "Answer at least one question." };
  return { answers: out };
}

export type SubmissionStatus = "pending" | "accepted" | "denied" | "closed";

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  denied: "Denied",
  closed: "Closed",
};

const STATUS_ICON: Record<SubmissionStatus, string> = {
  pending: "🕓",
  accepted: "✅",
  denied: "❌",
  closed: "📁",
};

/** Blockquotes every line so multi-line answers stay grouped under their question. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The message posted to a form's submission channel (and edited on review). */
export function formatSubmission(s: {
  id: number;
  formTitle: string;
  userMention: string;
  answers: AnsweredQuestion[];
  status: SubmissionStatus;
  reviewer?: string;
  note?: string;
  maxLength: number;
}): string {
  const lines = [`📝 **${defuseMentions(s.formTitle)}** · submission #${s.id} from ${s.userMention}`, ""];
  for (const a of s.answers) {
    lines.push(`**${defuseMentions(a.label)}**`, quote(defuseMentions(a.value)), "");
  }
  let status = `${STATUS_ICON[s.status]} **${STATUS_LABEL[s.status]}**`;
  if (s.status !== "pending" && s.reviewer) status += ` by ${s.reviewer}`;
  if (s.note) status += `: ${defuseMentions(s.note)}`;
  lines.push(status);
  const text = lines.join("\n");
  return text.length <= s.maxLength ? text : `${text.slice(0, s.maxLength - 1)}…`;
}
