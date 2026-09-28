import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkText,
  defuseMentions,
  formatSubmission,
  formatTranscript,
  sanitizeChannelName,
  ticketChannelName,
  transcriptMessages,
  validateAnswers,
  validateForm,
  Question,
} from "../src/modules/support/logic";

test("channel names follow Root's rules", () => {
  assert.equal(sanitizeChannelName("  Billing help!! "), "Billing-help");
  assert.equal(sanitizeChannelName("--a---b--"), "a-b");
  assert.equal(sanitizeChannelName("Café Olé"), "Cafe-Ole");
  assert.equal(sanitizeChannelName("🎉🎉"), undefined);
  assert.equal(sanitizeChannelName("x".repeat(150))!.length, 100);
  // A cut that lands on a hyphen doesn't leave it trailing.
  assert.equal(sanitizeChannelName("ab cd", 3), "ab");
});

test("ticket channel names", () => {
  assert.equal(ticketChannelName(12, "Alice W."), "ticket-12-alice-w");
  assert.equal(ticketChannelName(3, "日本"), "ticket-3");
});

test("defuseMentions keeps the text but drops Root links", () => {
  assert.equal(defuseMentions("hi [@Ann](root://user/u1) and [@All](root://role/all)"), "hi @Ann and @All");
  assert.equal(defuseMentions("[site](https://x.com)"), "[site](https://x.com)");
});

test("chunkText breaks on lines and splits long lines", () => {
  assert.deepEqual(chunkText("aa\nbb\ncc", 5), ["aa\nbb", "cc"]);
  assert.deepEqual(chunkText("abcdefgh", 3), ["abc", "def", "gh"]);
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkText(text, 50);
  assert.ok(chunks.every((c) => c.length <= 50));
  assert.equal(chunks.join("\n"), text);
});

test("transcript formatting sorts by time and defuses mentions", () => {
  const text = formatTranscript(
    { id: 7, topic: "Refund", opener: "Ann", openedAtMs: 0, closedBy: "Mod", closedAtMs: 60_000, reason: "done" },
    [
      { atMs: 2000, author: "Mod", content: "hello [@Ann](root://user/u1)", attachments: [], edited: false },
      { atMs: 1000, author: "Ann", content: "", attachments: ["a.png"], edited: true },
    ],
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "Ticket #7 · Refund");
  assert.match(text, /Closed by Mod · 1970-01-01 00:01 UTC · done/);
  assert.equal(lines[5], "[1970-01-01 00:00 UTC] Ann (edited): [attachment: a.png]");
  assert.equal(lines[6], "[1970-01-01 00:00 UTC] Mod: hello @Ann");
});

test("transcriptMessages wraps in code blocks and gives up when too long", () => {
  const parts = transcriptMessages("a ``` b", 100, 5)!;
  assert.equal(parts.length, 1);
  assert.ok(parts[0].startsWith("```\n") && parts[0].endsWith("\n```"));
  assert.ok(!parts[0].slice(3, -3).includes("```"));
  assert.equal(transcriptMessages("x\n".repeat(1000), 100, 5), undefined);
});

test("validateForm normalizes and assigns stable question ids", () => {
  const result = validateForm({
    title: "  Staff application ",
    description: "",
    questions: [
      { id: "q2", label: "Why?", type: "long", required: true },
      { label: "Age", type: "short" },
      { id: "q2", label: "Dupe id", type: "short" },
      { label: "Region", type: "choice", choices: ["EU", " NA ", ""] },
    ],
  });
  assert.ok("form" in result);
  assert.equal(result.form.title, "Staff application");
  assert.deepEqual(
    result.form.questions.map((q) => q.id),
    ["q2", "q1", "q3", "q4"],
  );
  assert.deepEqual(result.form.questions[3].choices, ["EU", "NA"]);
  assert.equal(result.form.questions[1].required, false);
});

test("validateForm rejects bad forms", () => {
  const base = { title: "T", description: "" };
  assert.ok("problem" in validateForm({ ...base, title: " ", questions: [{ label: "a", type: "short" }] }));
  assert.ok("problem" in validateForm({ ...base, questions: [] }));
  assert.ok("problem" in validateForm({ ...base, questions: [{ label: "a", type: undefined }] }));
  assert.ok("problem" in validateForm({ ...base, questions: [{ label: "a", type: "choice", choices: ["one"] }] }));
  assert.ok("problem" in validateForm({ ...base, questions: [{ label: "a", type: "choice", choices: ["x", "X"] }] }));
  assert.ok("problem" in validateForm({ ...base, questions: Array.from({ length: 26 }, () => ({ label: "a", type: "short" as const })) }));
});

const QUESTIONS: Question[] = [
  { id: "q1", label: "Name", type: "short", required: true, choices: [] },
  { id: "q2", label: "Story", type: "long", required: false, choices: [] },
  { id: "q3", label: "Region", type: "choice", required: true, choices: ["EU", "NA"] },
];

test("validateAnswers checks required, lengths and choices", () => {
  const ok = validateAnswers(QUESTIONS, [
    { questionId: "q1", value: " Ann \n Lee " },
    { questionId: "q3", value: "eu" },
    { questionId: "zz", value: "ignored" },
  ]);
  assert.ok("answers" in ok);
  assert.deepEqual(ok.answers, [
    { label: "Name", value: "Ann Lee" },
    { label: "Region", value: "EU" },
  ]);
  assert.ok("problem" in validateAnswers(QUESTIONS, [{ questionId: "q3", value: "EU" }]));
  assert.ok("problem" in validateAnswers(QUESTIONS, [{ questionId: "q1", value: "A" }, { questionId: "q3", value: "Asia" }]));
  assert.ok(
    "problem" in
      validateAnswers(QUESTIONS, [
        { questionId: "q1", value: "x".repeat(201) },
        { questionId: "q3", value: "EU" },
      ]),
  );
});

test("formatSubmission quotes answers, defuses mentions and shows status", () => {
  const text = formatSubmission({
    id: 4,
    formTitle: "Appeal",
    userMention: "[@Ann](root://user/u1)",
    answers: [{ label: "Why", value: "line one\n[@All](root://role/all)" }],
    status: "accepted",
    reviewer: "Mod",
    note: "ok",
    maxLength: 9500,
  });
  assert.match(text, /submission #4 from \[@Ann\]\(root:\/\/user\/u1\)/);
  assert.match(text, /> line one\n> @All/);
  assert.match(text, /✅ \*\*Accepted\*\* by Mod: ok$/);
  assert.equal(formatSubmission({ id: 1, formTitle: "x", userMention: "u", answers: [{ label: "a", value: "b".repeat(100) }], status: "pending", maxLength: 50 }).length, 50);
});
