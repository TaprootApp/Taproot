import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bar,
  KeyedThrottle,
  latestVotes,
  normalizeShortcode,
  optionForShortcode,
  parsePollInput,
  parseWinnerCount,
  percentages,
  plainMentions,
  quoteExcerpt,
  shuffle,
  starAction,
  starrers,
  tally,
  ThrottleClock,
} from "../src/modules/events/logic";
import { renderGiveaway, renderPoll, renderStarPost, renderWinners } from "../src/modules/events/render";

test("parsePollInput reads question, options and an optional duration", () => {
  assert.deepEqual(parsePollInput("Pizza? | Yes | No"), { durationMs: undefined, question: "Pizza?", options: ["Yes", "No"] });
  assert.deepEqual(parsePollInput("1h Next game? | Chess | Go | Poker"), {
    durationMs: 3_600_000,
    question: "Next game?",
    options: ["Chess", "Go", "Poker"],
  });
  // A leading word that isn't a duration stays in the question.
  const plain = parsePollInput("Lunch at 1pm? | a | b");
  assert.equal(typeof plain !== "string" && plain.question, "Lunch at 1pm?");
  assert.equal(typeof parsePollInput("Only one | a"), "string");
  assert.equal(typeof parsePollInput("| a | b"), "string");
  assert.equal(typeof parsePollInput(`Q | ${Array.from({ length: 11 }, (_, i) => `o${i}`).join(" | ")}`), "string");
  assert.equal(typeof parsePollInput("45d Too long? | a | b"), "string");
});

test("optionForShortcode maps number reactions to options", () => {
  assert.equal(optionForShortcode(":one:"), 0);
  assert.equal(optionForShortcode(":nine:"), 8);
  assert.equal(optionForShortcode(":keycap_ten:"), 9);
  assert.equal(optionForShortcode(":ten:"), 9);
  assert.equal(optionForShortcode(":star:"), undefined);
});

test("latestVotes keeps each member's most recent standing reaction", () => {
  const votes = latestVotes([
    { user_id: "a", option: 0, reacted_at: 10 },
    { user_id: "a", option: 2, reacted_at: 20 },
    { user_id: "b", option: 1, reacted_at: 0 },
    { user_id: "c", option: 1, reacted_at: 0 },
    { user_id: "c", option: 0, reacted_at: 0 },
  ]);
  assert.equal(votes.get("a"), 2);
  assert.equal(votes.get("b"), 1);
  assert.equal(votes.get("c"), 0);
  assert.deepEqual(tally(3, votes.values()), [1, 1, 1]);
  assert.deepEqual(tally(2, [0, 5, -1, 1]), [1, 1]);
});

test("percentages add up to 100", () => {
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(percentages([0, 0]), [0, 0]);
  assert.deepEqual(percentages([3, 1]), [75, 25]);
  assert.equal(bar(50), "🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜");
  assert.equal(bar(0), "⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜");
  assert.equal(bar(100), "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩");
});

test("shuffle is a permutation and parseWinnerCount has limits", () => {
  const items = [1, 2, 3, 4, 5];
  const out = shuffle(items, (n) => n - 1);
  assert.deepEqual([...out].sort(), items);
  assert.deepEqual(items, [1, 2, 3, 4, 5]);
  assert.equal(parseWinnerCount("3"), 3);
  assert.equal(parseWinnerCount("0"), undefined);
  assert.equal(parseWinnerCount("51"), undefined);
  assert.equal(parseWinnerCount("2w"), undefined);
});

test("starrers counts distinct members, skipping bots and optionally the author", () => {
  const reactions = [
    { shortcode: ":star:", userId: "author" },
    { shortcode: ":star:", userId: "u1" },
    { shortcode: ":star:", userId: "u1" },
    { shortcode: ":star:", userId: "bot" },
    { shortcode: ":heart:", userId: "u2" },
  ];
  const isBot = (id: string) => id === "bot";
  assert.equal(starrers(reactions, ":star:", "author", false, isBot).size, 1);
  assert.equal(starrers(reactions, ":star:", "author", true, isBot).size, 2);
  assert.equal(starrers([{ shortcode: ":party:abc123:", userId: "u" }], ":party:", "x", false, isBot).size, 1);
});

test("starAction decides create/update/remove", () => {
  assert.equal(starAction(3, 3, false, true), "create");
  assert.equal(starAction(4, 3, true, true), "update");
  assert.equal(starAction(2, 3, true, true), "remove");
  assert.equal(starAction(2, 3, true, false), "update");
  assert.equal(starAction(2, 3, false, true), "none");
});

test("mentions are neutralized in reposted text", () => {
  assert.equal(plainMentions("hi [@Bob](root://user/123) and [@all](root://role/all)"), "hi @Bob and @all");
  assert.equal(quoteExcerpt("a [@Bob](root://user/1)\nb"), "> a **@Bob**\n> b");
  assert.equal(quoteExcerpt("   "), "");
  assert.ok(quoteExcerpt("x".repeat(2000)).length < 1510);
  assert.equal(normalizeShortcode(":star:"), ":star:");
  assert.equal(normalizeShortcode("star"), undefined);
});

test("render: giveaways, polls and starboard posts", () => {
  const running = renderGiveaway({
    id: 3,
    prize: "Steam key",
    winnerCount: 2,
    hostName: "Ann",
    endsAt: Date.UTC(2026, 9, 1, 18, 0),
    state: "running",
    entries: 0,
    winners: [],
    roleName: "VIP",
  });
  assert.match(running, /React with 🎉/);
  assert.match(running, /2026-10-01 18:00 UTC/);
  assert.match(running, /Required role:\*\* VIP/);
  assert.doesNotMatch(running, /root:\/\/user/);
  const ended = renderGiveaway({ id: 3, prize: "Key", winnerCount: 1, hostName: "Ann", endsAt: 0, state: "ended", entries: 0, winners: [] });
  assert.match(ended, /nobody entered/);
  assert.match(renderWinners("Key", [{ id: "u1", name: "Bo" }], 5, false), /\[@Bo\]\(root:\/\/user\/u1\)/);
  assert.match(renderWinners("Key", [], 0, true), /No one else/);

  const open = renderPoll({ id: 1, question: "Q?", options: ["A", "B"], endsAt: null, closed: false });
  assert.match(open, /1️⃣ A\n⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜\n/);
  assert.match(open, /No votes yet · live results/);
  assert.match(open, /React with a number/);
  const live = renderPoll({ id: 1, question: "Q?", options: ["A", "B"], endsAt: Date.UTC(2026, 9, 1, 18, 0), closed: false, counts: [3, 1] });
  assert.match(live, /1️⃣ A · \*\*75%\*\* \(3\)\n🟦🟦🟦🟦🟦🟦🟦🟦⬜⬜\n/);
  assert.match(live, /\*\*4\*\* votes so far · live results/);
  assert.match(live, /Closes 2026-10-01 18:00 UTC/);
  assert.doesNotMatch(live, /closed|🏆|🟩/);
  const closed = renderPoll({ id: 1, question: "Q?", options: ["A", "B"], endsAt: null, closed: true, counts: [3, 1] });
  assert.match(closed, /75%/);
  assert.match(closed, /4 votes/);
  assert.match(closed, /\n🟩🟩🟩🟩🟩🟩🟩🟩⬜⬜\n/);

  const post = renderStarPost({
    emoji: ":star:",
    count: 5,
    channelId: "c1",
    channelName: "general",
    authorName: "Ann",
    content: "hello [@Bo](root://user/u1)",
    attachments: ["cat.png"],
  });
  assert.match(post, /^⭐ \*\*5\*\* · \[#general\]\(root:\/\/channel\/c1\)/);
  assert.match(post, /> hello \*\*@Bo\*\*/);
  assert.match(post, /📎 cat\.png/);
});

function fakeClock(): ThrottleClock & { advance(ms: number): void } {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 0;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++next;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

test("KeyedThrottle: one run per interval per key, with a trailing run", async () => {
  const clock = fakeClock();
  const runs: Array<[number, number]> = [];
  const t = new KeyedThrottle<number>(15_000, async (k) => void runs.push([k, clock.now()]), () => undefined, clock);

  t.schedule(1);
  t.schedule(1);
  t.schedule(2);
  clock.advance(0);
  assert.deepEqual(runs, [[1, 0], [2, 0]]); // leading run, bursts batched, keys independent

  clock.advance(1_000);
  t.schedule(1);
  t.schedule(1);
  assert.ok(t.isPending(1));
  clock.advance(13_999);
  assert.equal(runs.length, 2); // still inside the 15 s window
  clock.advance(1);
  assert.deepEqual(runs[2], [1, 15_000]); // one trailing run for the burst
  assert.ok(!t.isPending(1));

  clock.advance(60_000);
  t.schedule(1);
  clock.advance(0);
  assert.deepEqual(runs[3], [1, 75_000]); // idle long enough: runs right away
});

test("KeyedThrottle: cancel drops the queued run and waits for one in flight", async () => {
  const clock = fakeClock();
  const runs: number[] = [];
  let release!: () => void;
  const t = new KeyedThrottle<number>(
    15_000,
    (k) => new Promise<void>((resolve) => { runs.push(k); release = resolve; }),
    () => undefined,
    clock,
  );
  t.schedule(1);
  clock.advance(0);
  t.schedule(1);
  let cancelled = false;
  const done = t.cancel(1).then(() => (cancelled = true));
  await Promise.resolve();
  assert.equal(cancelled, false); // the in-flight run hasn't finished
  release();
  await done;
  assert.ok(!t.isPending(1));
  clock.advance(60_000);
  assert.deepEqual(runs, [1]); // the trailing run never happened
});

test("KeyedThrottle: failures are reported, never thrown", async () => {
  const clock = fakeClock();
  const errors: string[] = [];
  let calls = 0;
  const t = new KeyedThrottle<number>(
    15_000,
    async () => {
      calls++;
      throw new Error("message deleted");
    },
    (_k, err) => errors.push((err as Error).message),
    clock,
  );
  t.schedule(7);
  assert.doesNotThrow(() => clock.advance(0));
  await t.cancel(7);
  assert.deepEqual(errors, ["message deleted"]);
  t.schedule(7);
  clock.advance(0);
  await t.cancel(7);
  assert.equal(calls, 2); // a later vote still gets its edit
});
