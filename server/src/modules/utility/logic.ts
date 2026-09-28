// Pure logic for the utility module: autoresponder matching, highlight
// keyword matching and throttles, channel visibility, AFK text and the fun
// commands. No SDK imports, so server/test/utility.test.ts can cover it.

// --- Text --------------------------------------------------------------------

const ROOT_LINK = /\[([^\]]*)\]\(root:\/\/[a-z]+\/[^)\s]*\)/gi;

/**
 * Turns Root mention links into their plain text ("[@Alice](root://user/1)"
 * -> "@Alice"). Used on member-written text Taproot repeats, so an AFK
 * message can't smuggle in an @All ping, and before keyword matching so a
 * keyword never matches inside a link target.
 */
export function plainMentions(text: string): string {
  return text.replace(ROOT_LINK, "$1");
}

/** Lowercase, mention links flattened, whitespace collapsed. */
export function normalizeText(text: string): string {
  return plainMentions(text).toLowerCase().replace(/\s+/g, " ").trim();
}

// --- Autoresponders ----------------------------------------------------------

export type MatchMode = "exact" | "contains" | "starts" | "wildcard";
export const MATCH_MODES: MatchMode[] = ["exact", "contains", "starts", "wildcard"];

export const MAX_AUTORESPONDERS = 100;
export const MAX_TRIGGER = 200;
export const MAX_RESPONSE = 2000;
export const MAX_COOLDOWN_SECONDS = 86_400;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Whether a message matches a trigger. Case-insensitive, whitespace-insensitive.
 * "contains" needs whole words at the trigger's edges ("hi" doesn't match
 * "this"); "wildcard" treats * as any text and must match the whole message.
 */
export function matchesTrigger(content: string, trigger: string, mode: MatchMode): boolean {
  const text = normalizeText(content);
  const t = normalizeText(trigger);
  if (!text || !t) return false;
  switch (mode) {
    case "exact":
      return text === t;
    case "starts":
      return text.startsWith(t) && (text.length === t.length || !WORD_CHAR.test(t[t.length - 1]) || !WORD_CHAR.test(text[t.length]));
    case "contains": {
      const before = WORD_CHAR.test(t[0]) ? "(?<![\\p{L}\\p{N}_])" : "";
      const after = WORD_CHAR.test(t[t.length - 1]) ? "(?![\\p{L}\\p{N}_])" : "";
      return new RegExp(`${before}${escapeRegex(t)}${after}`, "u").test(text);
    }
    case "wildcard":
      return wildcardMatch(text, t);
  }
}

/**
 * Whole-text match where * stands for any run of characters. Done by hand
 * rather than as a ".*" regex: with several stars a regex backtracks
 * polynomially, and one long message could stall the whole server.
 */
export function wildcardMatch(text: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return text === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (text.length < first.length + last.length || !text.startsWith(first) || !text.endsWith(last)) return false;
  // Middle parts in order, leftmost first, between the fixed prefix and suffix.
  let pos = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const at = text.indexOf(part, pos);
    if (at === -1 || at + part.length > end) return false;
    pos = at + part.length;
  }
  return true;
}

/** "Allowed" check for a trigger typed by staff; returns a problem or undefined. */
export function triggerProblem(trigger: string, mode: MatchMode): string | undefined {
  const t = trigger.trim();
  if (!t) return "Give the trigger text.";
  if (t.length > MAX_TRIGGER) return `Triggers can be up to ${MAX_TRIGGER} characters.`;
  if (mode === "wildcard" && !t.replace(/\*/g, "").trim()) return "A wildcard trigger needs some text besides *.";
  return undefined;
}

/** Per-trigger cooldowns (in memory; a restart just resets them). */
export class Cooldowns {
  private readonly last = new Map<string, number>();

  /** True (and starts the cooldown) if `key` is free at `now`. */
  take(key: string, seconds: number, now = Date.now()): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < seconds * 1000) return false;
    this.last.set(key, now);
    if (this.last.size > 5000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    // Longest cooldown is a day; anything older can't block.
    for (const [k, at] of this.last) if (now - at > MAX_COOLDOWN_SECONDS * 1000) this.last.delete(k);
  }
}

// --- Highlights --------------------------------------------------------------

export const MAX_HIGHLIGHTS = 25;
export const MIN_KEYWORD = 2;
export const MAX_KEYWORD = 50;
export const HIGHLIGHT_WINDOW_MS = 5 * 60_000;

const WORDS = /[\p{L}\p{N}_']+/gu;

function words(text: string): string[] {
  return (plainMentions(text).toLowerCase().match(WORDS) ?? []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
}

/** The stored form of a keyword (lowercase words joined by spaces), or a problem. */
export function normalizeKeyword(raw: string): { keyword: string } | { problem: string } {
  const keyword = words(raw).join(" ");
  if (keyword.length < MIN_KEYWORD) return { problem: `Keywords need at least ${MIN_KEYWORD} letters or numbers.` };
  if (keyword.length > MAX_KEYWORD) return { problem: `Keywords can be up to ${MAX_KEYWORD} characters.` };
  return { keyword };
}

/**
 * Which of `keywords` (stored form) appear in the message as whole words or
 * whole-word phrases.
 */
export function findKeywords(content: string, keywords: Iterable<string>): string[] {
  const list = words(content);
  if (list.length === 0) return [];
  const single = new Set(list);
  const joined = ` ${list.join(" ")} `;
  const found: string[] = [];
  for (const k of keywords) {
    if (k.includes(" ") ? joined.includes(` ${k} `) : single.has(k)) found.push(k);
  }
  return found;
}

/**
 * Who is active where, and who was pinged where, for the highlight rules:
 * no ping when the subscriber posted in the channel recently, and at most
 * one ping per member per channel per window.
 */
export class HighlightThrottle {
  private readonly posted = new Map<string, number>();
  private readonly pinged = new Map<string, number>();

  constructor(private readonly windowMs = HIGHLIGHT_WINDOW_MS) {}

  notePost(channelId: string, userId: string, now = Date.now()): void {
    this.posted.set(`${channelId}:${userId}`, now);
    this.prune(now);
  }

  /** True (and records the ping) if `userId` may be pinged for `channelId`. */
  take(channelId: string, userId: string, now = Date.now()): boolean {
    const key = `${channelId}:${userId}`;
    const posted = this.posted.get(key);
    if (posted !== undefined && now - posted < this.windowMs) return false;
    const pinged = this.pinged.get(key);
    if (pinged !== undefined && now - pinged < this.windowMs) return false;
    this.pinged.set(key, now);
    return true;
  }

  private prune(now: number): void {
    if (this.posted.size + this.pinged.size < 10_000) return;
    for (const map of [this.posted, this.pinged]) {
      for (const [k, at] of map) if (now - at >= this.windowMs) map.delete(k);
    }
  }
}

export interface RuleView {
  subjectId: string;
  /** The rule's channelView overlay: true, false, or undefined (inherit). */
  view: boolean | undefined;
}

/**
 * Whether a member can see a channel, from the access rules on the channel
 * (or its group, when it uses the group's permissions). Like mute targets in
 * features/mute.ts: a rule for the member, one of their roles or @everyone
 * makes it visible, except that an explicit "can't view" is honored, with the
 * member's own rule winning over role rules. Full Control sees everything.
 */
export function canSeeChannel(rules: RuleView[], userId: string, subjectIds: Set<string>, fullControl: boolean): boolean {
  if (fullControl) return true;
  const own = rules.find((r) => r.subjectId === userId);
  if (own && own.view !== undefined) return own.view;
  const mine = rules.filter((r) => subjectIds.has(r.subjectId));
  if (mine.some((r) => r.view === true)) return true;
  if (mine.length === 0) return false;
  return !mine.every((r) => r.view === false);
}

// --- AFK ---------------------------------------------------------------------

export const MAX_AFK_MESSAGE = 200;
export const AFK_NOTICE_WINDOW_MS = 2 * 60_000;

/** Cleans a member's AFK message: plain mentions, one line, capped. */
export function cleanAfkMessage(raw: string): string {
  const text = plainMentions(raw).replace(/\s+/g, " ").trim();
  if (!text) return "AFK";
  return text.length <= MAX_AFK_MESSAGE ? text : `${text.slice(0, MAX_AFK_MESSAGE - 1)}…`;
}

// --- Fun ---------------------------------------------------------------------

export const EIGHT_BALL = [
  "It is certain.",
  "It is decidedly so.",
  "Without a doubt.",
  "Yes, definitely.",
  "You may rely on it.",
  "As I see it, yes.",
  "Most likely.",
  "Outlook good.",
  "Yes.",
  "Signs point to yes.",
  "Reply hazy, try again.",
  "Ask again later.",
  "Better not tell you now.",
  "Cannot predict now.",
  "Concentrate and ask again.",
  "Don't count on it.",
  "My reply is no.",
  "My sources say no.",
  "Outlook not so good.",
  "Very doubtful.",
];

export type Rng = () => number;

export function pick<T>(list: readonly T[], rng: Rng = Math.random): T {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

export const MAX_DICE = 100;
export const MAX_SIDES = 1000;

export interface Dice {
  count: number;
  sides: number;
  modifier: number;
}

/** Parses "d20", "2d6", "3d8+2"; empty means 1d6. Returns a problem string when out of range. */
export function parseDice(input: string | undefined): Dice | { problem: string } {
  const text = (input ?? "").trim().toLowerCase();
  if (!text) return { count: 1, sides: 6, modifier: 0 };
  const m = /^(\d*)d(\d+)([+-]\d+)?$/.exec(text) ?? /^()(\d+)()$/.exec(text);
  if (!m) return { problem: "Write dice like `2d6`, `d20` or `3d8+2`." };
  const count = m[1] ? Number(m[1]) : 1;
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3]) : 0;
  if (count < 1 || count > MAX_DICE) return { problem: `Roll between 1 and ${MAX_DICE} dice.` };
  if (sides < 2 || sides > MAX_SIDES) return { problem: `Dice can have 2 to ${MAX_SIDES} sides.` };
  if (Math.abs(modifier) > 10_000) return { problem: "That modifier is too big." };
  return { count, sides, modifier };
}

export function rollDice(dice: Dice, rng: Rng = Math.random): { rolls: number[]; total: number } {
  const rolls = Array.from({ length: dice.count }, () => 1 + Math.min(dice.sides - 1, Math.floor(rng() * dice.sides)));
  return { rolls, total: rolls.reduce((a, b) => a + b, 0) + dice.modifier };
}

/** Splits "a | b | c" (or "a, b, c" when there's no |) into options. */
export function splitChoices(input: string): string[] {
  const sep = input.includes("|") ? "|" : ",";
  return input
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Rps = "rock" | "paper" | "scissors";
export const RPS: Rps[] = ["rock", "paper", "scissors"];

export function parseRps(input: string | undefined): Rps | undefined {
  const t = (input ?? "").trim().toLowerCase();
  if (t === "r" || t === "rock") return "rock";
  if (t === "p" || t === "paper") return "paper";
  if (t === "s" || t === "scissors" || t === "scissor") return "scissors";
  return undefined;
}

/** "win" when `a` beats `b`. */
export function rpsOutcome(a: Rps, b: Rps): "win" | "lose" | "draw" {
  if (a === b) return "draw";
  const beats: Record<Rps, Rps> = { rock: "scissors", paper: "rock", scissors: "paper" };
  return beats[a] === b ? "win" : "lose";
}
