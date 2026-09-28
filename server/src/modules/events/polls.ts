import { UsageError, register } from "../../commands/registry";
import { all, get, run } from "../../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { log, errMessage } from "../../lib/log";
import { formatUtc } from "../../lib/time";
import { reply, send } from "../../messaging";
import { Level } from "../../permissions";
import { notifyChange } from "../../services/changes";
import {
  KeyedThrottle,
  latestVotes,
  NUMBER_SHORTCODES,
  optionForShortcode,
  parsePollInput,
  plainMentions,
  POLL_LIVE_INTERVAL_MS,
  PollReaction,
  tally,
} from "./logic";
import { renderPoll } from "./render";
import { AREA_POLLS, editMessage, fetchMessage, isBot, seedReaction } from "./shared";

// Reaction polls: numbered options, one vote per member. Taproot can't
// remove other people's reactions, so every reaction is stored with the time
// it arrived and a member's vote is their latest reaction that still stands.
// Timed polls close from a job and post their results. While open, the
// message shows live results, edited at most once per 15 seconds per poll so
// a busy poll can't use up the shared write budget.

const JOB = "eventsPoll";

export interface Poll {
  id: number;
  channel_id: string;
  message_id: string;
  question: string;
  /** JSON string array. */
  options: string;
  created_by: string;
  ends_at: number | null;
  closed: number;
  created_at: number;
  closed_at: number | null;
}

export async function initPollTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS events_polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    created_by TEXT NOT NULL,
    ends_at INTEGER,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_polls_message ON events_polls (message_id)`);
  await run(`CREATE TABLE IF NOT EXISTS events_poll_reactions (
    poll_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    option INTEGER NOT NULL,
    reacted_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id, option)
  )`);
}

export function optionsOf(p: Poll): string[] {
  try {
    const parsed = JSON.parse(p.options) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function pollById(id: number): Promise<Poll | undefined> {
  return Number.isInteger(id) ? get<Poll>("SELECT * FROM events_polls WHERE id = ?", [id]) : undefined;
}

export async function listPolls(limit = 50): Promise<Poll[]> {
  return all<Poll>("SELECT * FROM events_polls ORDER BY closed ASC, id DESC LIMIT ?", [limit]);
}

/** Votes per option right now. */
export async function pollCounts(p: Poll): Promise<number[]> {
  const rows = await all<PollReaction>("SELECT user_id, option, reacted_at FROM events_poll_reactions WHERE poll_id = ?", [p.id]);
  return tally(optionsOf(p).length, latestVotes(rows).values());
}

function text(p: Poll, counts?: number[]): string {
  return renderPoll({ id: p.id, question: p.question, options: optionsOf(p), endsAt: p.ends_at, closed: Boolean(p.closed), counts });
}

// --- Live results ----------------------------------------------------------------

/** The text last written to each open poll's message, so unchanged renders skip the edit. In memory only. */
const lastLive = new Map<number, string>();

/** Edits an open poll's message to its current counts, unless nothing changed. */
async function liveRefresh(id: number): Promise<void> {
  const p = await pollById(id);
  if (!p || p.closed || !p.message_id) return;
  const content = text(p, await pollCounts(p));
  if (lastLive.get(id) === content) return;
  // editMessage logs and returns false on failure; the edit is dropped and the next vote retries.
  if (await editMessage(p.channel_id, p.message_id, content)) lastLive.set(id, content);
}

const live = new KeyedThrottle<number>(POLL_LIVE_INTERVAL_MS, liveRefresh, (id, err) =>
  log("warn", "live poll refresh failed", { id, error: errMessage(err) }),
);

/** Stops live edits for a poll and waits for one in flight, so it can't land after the closed rendering. */
async function stopLive(id: number): Promise<void> {
  await live.cancel(id);
  lastLive.delete(id);
}

export interface NewPoll {
  channelId: string;
  question: string;
  options: string[];
  durationMs?: number;
  createdBy: string;
}

/** Posts the poll and seeds the number reactions. Callers validate first. */
export async function createPoll(input: NewPoll): Promise<{ poll: Poll; seeded: boolean }> {
  const now = Date.now();
  const options = input.options.map((o) => plainMentions(o.trim()));
  const { lastID } = await run(
    "INSERT INTO events_polls (channel_id, question, options, created_by, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.channelId, plainMentions(input.question.trim()), JSON.stringify(options), input.createdBy, input.durationMs ? now + input.durationMs : null, now],
  );
  let poll = (await pollById(lastID))!;
  try {
    const content = text(poll);
    const msg = await send(poll.channel_id, content);
    lastLive.set(poll.id, content);
    await run("UPDATE events_polls SET message_id = ? WHERE id = ?", [msg.id, poll.id]);
    poll = { ...poll, message_id: msg.id };
  } catch (err) {
    await run("DELETE FROM events_polls WHERE id = ?", [poll.id]);
    throw err;
  }
  let seeded = true;
  for (let i = 0; i < options.length; i++) {
    if (!(await seedReaction(poll.channel_id, poll.message_id, NUMBER_SHORTCODES[i]))) seeded = false;
  }
  if (poll.ends_at) await scheduleOnce(JOB, poll.id, poll.ends_at);
  notifyChange(AREA_POLLS);
  return { poll, seeded };
}

/** Re-renders the poll's own message in place (live results while open, final once closed). The rendered text is returned. */
export async function refreshPoll(p: Poll): Promise<string> {
  const content = text(p, await pollCounts(p));
  if (p.message_id && (await editMessage(p.channel_id, p.message_id, content)) && !p.closed) lastLive.set(p.id, content);
  return content;
}

/** Records reactions that are on the message but whose events we missed. */
async function syncReactions(p: Poll): Promise<void> {
  if (!p.message_id) return;
  const msg = await fetchMessage(p.channel_id, p.message_id);
  if (!msg) return;
  const count = optionsOf(p).length;
  for (const r of msg.reactions ?? []) {
    const option = optionForShortcode(r.shortcode);
    if (option === undefined || option >= count || isBot(r.userId)) continue;
    // Time unknown: 0 ranks it below every reaction we saw arrive.
    await run("INSERT OR IGNORE INTO events_poll_reactions (poll_id, user_id, option, reacted_at) VALUES (?, ?, ?, 0)", [
      p.id,
      r.userId,
      option,
    ]);
  }
}

/** Closes a poll, edits it to show the results and posts them. */
export async function closePoll(id: number): Promise<Poll | string> {
  const p = await pollById(id);
  if (!p) return "No poll with that number.";
  if (p.closed) return `Poll #${id} is already closed.`;
  await syncReactions(p).catch((err) => log("warn", "poll reaction sync failed", { error: errMessage(err) }));
  const { changes } = await run("UPDATE events_polls SET closed = 1, closed_at = ? WHERE id = ? AND closed = 0", [Date.now(), id]);
  if (!changes) return `Poll #${id} is already closed.`;
  await cancelJobs(JOB, id).catch(() => undefined);
  await stopLive(id);
  const closed = (await pollById(id))!;
  const counts = await pollCounts(closed);
  const results = text(closed, counts);
  if (closed.message_id) {
    await editMessage(closed.channel_id, closed.message_id, results);
    const posted = `📊 **Poll #${id} results**\n\n${results}`;
    // The reply target may be gone; fall back to a plain post.
    await reply(closed.channel_id, closed.message_id, posted)
      .catch(() => send(closed.channel_id, posted))
      .catch((err) => log("warn", "poll results post failed", { error: errMessage(err) }));
  }
  notifyChange(AREA_POLLS);
  return closed;
}

// --- Events --------------------------------------------------------------------

export async function onPollReaction(messageId: string, userId: string, shortcode: string, added: boolean): Promise<void> {
  if (isBot(userId)) return;
  const option = optionForShortcode(shortcode);
  if (option === undefined) return;
  const p = await get<Poll>("SELECT * FROM events_polls WHERE message_id = ? AND closed = 0", [messageId]);
  if (!p || option >= optionsOf(p).length) return;
  if (added) {
    await run(
      `INSERT INTO events_poll_reactions (poll_id, user_id, option, reacted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(poll_id, user_id, option) DO UPDATE SET reacted_at = excluded.reacted_at`,
      [p.id, userId, option, Date.now()],
    );
  } else {
    await run("DELETE FROM events_poll_reactions WHERE poll_id = ? AND user_id = ? AND option = ?", [p.id, userId, option]);
  }
  live.schedule(p.id);
  notifyChange(AREA_POLLS);
}

/** A poll whose message was deleted is closed quietly. */
export async function onPollMessageDeleted(messageId: string): Promise<void> {
  const p = await get<Poll>("SELECT * FROM events_polls WHERE message_id = ?", [messageId]);
  if (!p) return;
  await run("UPDATE events_polls SET closed = 1, closed_at = COALESCE(closed_at, ?), message_id = '' WHERE id = ?", [Date.now(), p.id]);
  await cancelJobs(JOB, p.id).catch(() => undefined);
  await stopLive(p.id);
  notifyChange(AREA_POLLS);
}

async function reconcile(): Promise<void> {
  for (const p of await all<Poll>("SELECT * FROM events_polls WHERE closed = 0")) {
    if (p.ends_at !== null && p.ends_at <= Date.now()) {
      const result = await closePoll(p.id).catch((err) => errMessage(err));
      if (typeof result === "string") log("warn", "late poll close failed", { id: p.id, reason: result });
      continue;
    }
    // Live edits are in memory: catch up on votes that changed while offline (a no-op once current).
    live.schedule(p.id);
    if (p.ends_at !== null && !(await hasJob(JOB, p.id))) await scheduleOnce(JOB, p.id, p.ends_at);
  }
}

// --- Commands ----------------------------------------------------------------

export function registerPolls(): void {
  onJob(JOB, async (id) => {
    const result = await closePoll(id);
    if (typeof result === "string") log("info", "poll job skipped", { id, reason: result });
  });
  onReconcile(reconcile);

  register({
    name: "poll",
    aliases: ["polls"],
    category: "Polls",
    level: Level.Moderator,
    usage: "[#channel] [duration] <question> | <option> | <option> ... · end <id> · list",
    description: "Start a reaction poll with 2 to 10 options.",
    details: [
      "`poll Pizza tonight? | Yes | No` posts here; members vote with the number reactions.",
      "`poll #events 1h Next game? | Chess | Go | Poker` closes after an hour and posts the results.",
      "One vote per member: if someone reacts more than once, their latest reaction counts.",
      "`poll end 3` closes poll 3 now. `poll list` shows open polls.",
    ],
    async run(ctx) {
      const channel = ctx.args.mention("channel");
      const raw = ctx.args.rest();
      const sub = /^(end|close|list)(?:\s+(\S+))?\s*$/i.exec(raw);
      if (!channel && (!raw || (sub && !raw.includes("|")))) {
        const action = sub?.[1].toLowerCase() ?? "list";
        if (action === "list") {
          const open = (await listPolls()).filter((p) => !p.closed);
          if (open.length === 0) return ctx.reply("No polls are open.");
          const lines = open.map((p) => `#${p.id} · **${p.question}**${p.ends_at ? ` · closes ${formatUtc(p.ends_at)}` : ""}`);
          return ctx.reply(`**Open polls**\n${lines.join("\n")}`);
        }
        const id = Number(sub?.[2]);
        if (!Number.isInteger(id)) throw new UsageError("Give the poll number. See `poll list`.");
        const result = await closePoll(id);
        if (typeof result === "string") return ctx.reply(`❌ ${result}`);
        if (result.channel_id !== ctx.channelId) return ctx.reply(`✅ Poll #${id} closed.`);
        return;
      }
      const parsed = parsePollInput(raw);
      if (typeof parsed === "string") return ctx.reply(`❌ ${parsed}`);
      const { poll, seeded } = await createPoll({
        channelId: channel?.id ?? ctx.channelId,
        question: parsed.question,
        options: parsed.options,
        durationMs: parsed.durationMs,
        createdBy: ctx.authorId,
      });
      const hint = seeded ? "" : "\n⚠️ I couldn't add every number reaction; members can still add them themselves.";
      if (channel?.id && channel.id !== ctx.channelId) return ctx.reply(`✅ Poll **#${poll.id}** posted in ${channel.text}.${hint}`);
      if (hint) return ctx.reply(hint.trim());
    },
  });
}
