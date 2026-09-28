import { emojiKey } from "../../features/emoji";

export { emojiDisplay } from "../../features/emoji";
import { parseDuration } from "../../lib/time";

// Pure helpers for giveaways, polls and the starboard: parsing, tallies,
// winner draws and mention-safe excerpts. No SDK imports, so the tests can
// cover them without a Root connection.

// --- Limits ------------------------------------------------------------------

export const GIVEAWAY_MIN_MS = 60_000;
export const GIVEAWAY_MAX_MS = 90 * 86_400_000;
export const MAX_WINNERS = 50;
export const MAX_PRIZE = 200;

export const POLL_MIN_MS = 60_000;
export const POLL_MAX_MS = 30 * 86_400_000;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const MAX_QUESTION = 300;
export const MAX_OPTION = 100;

export const STAR_THRESHOLD_MAX = 100;

// --- Emoji -------------------------------------------------------------------

/** Giveaway entry reaction. */
export const ENTER_SHORTCODE = ":tada:";

/** How the option numbers are shown in message text. */
export const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** Reaction shortcodes for the option numbers (iamcal emoji-data names). */
export const NUMBER_SHORTCODES = [":one:", ":two:", ":three:", ":four:", ":five:", ":six:", ":seven:", ":eight:", ":nine:", ":keycap_ten:"];

// Alternative names clients may report for the same keycaps.
const NUMBER_ALIASES: Record<string, number> = { ten: 9 };

/** Option index (0-based) for a reaction shortcode, or undefined. */
export function optionForShortcode(shortcode: string): number | undefined {
  const key = emojiKey(shortcode);
  const index = NUMBER_SHORTCODES.findIndex((s) => emojiKey(s) === key);
  if (index >= 0) return index;
  return NUMBER_ALIASES[key];
}

/** Normalizes a typed emoji to ":name:" form, or undefined if it isn't one. */
export function normalizeShortcode(raw: string): string | undefined {
  const text = raw.trim();
  if (!/^:[^:\s]+:(\S*:)?$/.test(text)) return undefined;
  return text;
}

// --- Polls -------------------------------------------------------------------

export interface PollInput {
  durationMs?: number;
  question: string;
  options: string[];
}

/**
 * Parses "[duration] Question | option | option ...". Returns the poll or a
 * sentence explaining what's wrong.
 */
export function parsePollInput(text: string): PollInput | string {
  let body = text.trim();
  let durationMs: number | undefined;
  const first = /^(\S+)\s+/.exec(body);
  if (first && body.includes("|")) {
    const ms = parseDuration(first[1]);
    if (ms !== undefined) {
      durationMs = ms;
      body = body.slice(first[0].length);
    }
  }
  const parts = body.split("|").map((p) => p.trim());
  const question = parts.shift() ?? "";
  const options = parts.filter(Boolean);
  const problem = pollProblem(question, options, durationMs ?? 0);
  return problem ?? { durationMs, question, options };
}

/** Why a poll can't be created, or undefined. Shared with the GUI service. */
export function pollProblem(question: string, options: string[], durationMs: number): string | undefined {
  if (!question) return "Write a question before the first `|`.";
  if (question.length > MAX_QUESTION) return `Keep the question under ${MAX_QUESTION} characters.`;
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    return `Give ${POLL_MIN_OPTIONS} to ${POLL_MAX_OPTIONS} options, separated by \`|\`.`;
  }
  if (options.some((o) => !o.trim())) return "Options can't be empty.";
  if (options.some((o) => o.length > MAX_OPTION)) return `Keep each option under ${MAX_OPTION} characters.`;
  if (durationMs && (durationMs < POLL_MIN_MS || durationMs > POLL_MAX_MS)) return "A poll can run from 1 minute to 30 days.";
  return undefined;
}

export interface PollReaction {
  user_id: string;
  option: number;
  /** When the reaction arrived; 0 when only found on the message later. */
  reacted_at: number;
}

/**
 * One vote per member: their most recent reaction that still stands. Ties
 * (reactions only found at close time) go to the lowest option number.
 */
export function latestVotes(reactions: PollReaction[]): Map<string, number> {
  const best = new Map<string, PollReaction>();
  for (const r of reactions) {
    const current = best.get(r.user_id);
    if (!current || r.reacted_at > current.reacted_at || (r.reacted_at === current.reacted_at && r.option < current.option)) {
      best.set(r.user_id, r);
    }
  }
  return new Map([...best].map(([user, r]) => [user, r.option]));
}

/** Votes per option (options outside the range are ignored). */
export function tally(optionCount: number, votes: Iterable<number>): number[] {
  const counts = new Array<number>(optionCount).fill(0);
  for (const v of votes) if (v >= 0 && v < optionCount) counts[v]++;
  return counts;
}

/** Whole percentages that add up to 100 (largest remainder). All zero with no votes. */
export function percentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/** A 10-cell bar for a percentage, in emoji squares (Root's chat font lacks block characters). */
export function bar(percent: number, width = 10, fill = "🟩"): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return fill.repeat(filled) + "⬜".repeat(width - filled);
}

/** Open polls' live bars are blue, so they read differently from the final (green) results. */
export const LIVE_FILL = "🟦";

/** The minimum gap between live edits of one poll's message. */
export const POLL_LIVE_INTERVAL_MS = 15_000;

export interface ThrottleClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Per-key trailing throttle: `run(key)` starts at most once per `intervalMs`
 * for each key. Scheduling while a run is already queued does nothing, since
 * the queued run reads the latest state; scheduling after a recent run queues
 * one trailing run for when the interval is up. `run` failures go to
 * `onError` and never escape a timer.
 */
export class KeyedThrottle<K> {
  private readonly timers = new Map<K, unknown>();
  private readonly lastRun = new Map<K, number>();
  private readonly running = new Map<K, Promise<void>>();

  constructor(
    private readonly intervalMs: number,
    private readonly run: (key: K) => Promise<void>,
    private readonly onError: (key: K, err: unknown) => void,
    private readonly clock: ThrottleClock = realClock,
  ) {}

  schedule(key: K): void {
    if (this.timers.has(key)) return;
    const last = this.lastRun.get(key);
    const delay = last === undefined ? 0 : Math.max(0, last + this.intervalMs - this.clock.now());
    this.timers.set(key, this.clock.setTimeout(() => this.fire(key), delay));
  }

  isPending(key: K): boolean {
    return this.timers.has(key);
  }

  /** Drops a queued run and waits for one in flight, so nothing for this key lands afterwards. */
  async cancel(key: K): Promise<void> {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(key);
    this.lastRun.delete(key);
    await this.running.get(key);
  }

  private fire(key: K): void {
    this.timers.delete(key);
    this.lastRun.set(key, this.clock.now());
    let done: Promise<void>;
    try {
      done = this.run(key).catch((err) => this.onError(key, err));
    } catch (err) {
      this.onError(key, err);
      return;
    }
    const tracked = done.finally(() => {
      if (this.running.get(key) === tracked) this.running.delete(key);
    });
    this.running.set(key, tracked);
  }
}

// --- Giveaways ---------------------------------------------------------------

/** Fisher-Yates on a copy. `randomInt(n)` returns an integer in [0, n). */
export function shuffle<T>(items: readonly T[], randomInt: (n: number) => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Parses a winner count ("3"), within 1..MAX_WINNERS. */
export function parseWinnerCount(text: string | undefined): number | undefined {
  if (!text || !/^\d{1,3}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= MAX_WINNERS ? n : undefined;
}

// --- Starboard ---------------------------------------------------------------

export interface Reaction {
  shortcode: string;
  userId: string;
}

/**
 * Distinct members who reacted with the starboard emoji, across the original
 * and Taproot's starboard copy. Bots never count; the author only with
 * self-star on.
 */
export function starrers(
  reactions: Reaction[],
  emoji: string,
  authorId: string,
  selfStar: boolean,
  isBot: (userId: string) => boolean,
): Set<string> {
  const key = emojiKey(emoji);
  const out = new Set<string>();
  for (const r of reactions) {
    if (emojiKey(r.shortcode) !== key) continue;
    if (isBot(r.userId)) continue;
    if (!selfStar && r.userId === authorId) continue;
    out.add(r.userId);
  }
  return out;
}

export type StarAction = "create" | "update" | "remove" | "none";

/** What to do with a message's starboard post for a new count. */
export function starAction(count: number, threshold: number, hasPost: boolean, removeBelow: boolean): StarAction {
  if (count >= threshold) return hasPost ? "update" : "create";
  if (hasPost) return removeBelow ? "remove" : "update";
  return "none";
}

/**
 * Turns user and role mention links (including @all and @here) into plain
 * names, optionally bold, so reposted or echoed text never pings anyone.
 */
export function plainMentions(text: string, bold = false): string {
  return text.replace(/\[([^\]]*)\]\(root:\/\/(user|role)\/[^)\s]*\)/g, (_all, name: string) => (bold ? `**${name}**` : name));
}

/**
 * Message text safe to repost: user and role mentions (including @all and
 * @here) become plain bold names so the starboard never pings anyone, and
 * every line is quoted.
 */
export function quoteExcerpt(content: string, max = 1500): string {
  let text = plainMentions(content, true).trim();
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  if (!text) return "";
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
