// Pure helpers for channel rules and join protection: nickname patterns,
// account age from a user ID, purge scheduling, the raid and slowmode
// counters, and auto-delete message types. No SDK imports (tests).

import type { AllowType } from "./config";

// --- Autoban ------------------------------------------------------------------

function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/** Case-insensitive "contains" match where * stands for any run of characters. */
export function nameMatches(name: string, pattern: string): boolean {
  // Parts in order, leftmost first. No regex: ".*" chains backtrack badly.
  const parts = fold(pattern).split("*").filter(Boolean);
  if (parts.length === 0) return false;
  const text = fold(name);
  let pos = 0;
  for (const part of parts) {
    const at = text.indexOf(part, pos);
    if (at === -1) return false;
    pos = at + part.length;
  }
  return true;
}

export function firstMatchingPattern(name: string, patterns: string[]): string | undefined {
  return patterns.find((p) => nameMatches(name, p));
}

/**
 * When an account was created, estimated from its user ID. Root GUIDs are
 * time-ordered: the first 6 bytes are milliseconds since 2020-01-01 UTC (the
 * same thing RootGuidUtils.toMilliseconds decodes). A user ID is minted when
 * the account is created, so this is the account's age, not when they joined
 * this community. Returns undefined for anything that doesn't decode to a
 * plausible time (malformed ID, or a date in the future).
 */
export const ROOT_EPOCH_MS = Date.UTC(2020, 0, 1);

export function accountCreatedAt(userId: string, now = Date.now()): number | undefined {
  if (!/^[A-Za-z0-9_-]{22}$/.test(userId)) return undefined;
  const bytes = Buffer.from(userId, "base64url");
  if (bytes.length !== 16) return undefined;
  let ms = 0;
  for (let i = 0; i < 6; i++) ms = ms * 256 + bytes[i];
  const at = ROOT_EPOCH_MS + ms;
  if (at > now + 86_400_000) return undefined;
  return at;
}

export type AutobanHit = { kind: "name"; pattern: string } | { kind: "age"; days: number };

export function autobanReason(
  opts: { nickname: string; userId: string; now?: number },
  rules: { namePatterns: string[]; minAccountDays: number },
): AutobanHit | undefined {
  const pattern = firstMatchingPattern(opts.nickname, rules.namePatterns);
  if (pattern) return { kind: "name", pattern };
  if (rules.minAccountDays > 0) {
    const now = opts.now ?? Date.now();
    const created = accountCreatedAt(opts.userId, now);
    if (created !== undefined) {
      const days = (now - created) / 86_400_000;
      if (days < rules.minAccountDays) return { kind: "age", days };
    }
  }
  return undefined;
}

// --- Auto purge schedule ------------------------------------------------------

export interface PurgeSchedule {
  mode: "interval" | "daily";
  everyHours: number;
  /** Minutes after midnight UTC, for "daily". */
  dailyMinute: number;
}

/** The next run strictly after `after`. Interval runs count from the last run (or creation). */
export function nextPurgeAt(s: PurgeSchedule, after: number, lastRunAt: number | null): number {
  if (s.mode === "interval") {
    const step = s.everyHours * 3_600_000;
    let next = (lastRunAt ?? after) + step;
    // A long outage: skip the missed runs rather than purging back to back.
    if (next <= after) next += Math.floor((after - next) / step + 1) * step;
    return next;
  }
  const d = new Date(after);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + s.dailyMinute * 60_000;
  return today > after ? today : today + 86_400_000;
}

export function formatDailyTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
}

/** "18:30" -> 1110; undefined if invalid. */
export function parseDailyTime(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim().replace(/\s*utc$/i, ""));
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return undefined;
  return h * 60 + mi;
}

// --- Raid detection -----------------------------------------------------------

/** Join timestamps in a sliding window. In memory: a restart just resets it. */
export class JoinTracker {
  private joins: number[] = [];

  /** Records a join and returns how many joins fall inside the window. */
  record(at: number, windowMs: number): number {
    this.joins.push(at);
    this.joins = this.joins.filter((t) => at - t <= windowMs);
    return this.joins.length;
  }

  reset(): void {
    this.joins = [];
  }
}

// --- Slowmode -----------------------------------------------------------------

/** Last accepted message per channel and member. */
export class SlowmodeTracker {
  private last = new Map<string, number>();

  /** Returns 0 when the message may go through (and records it), else seconds left to wait. */
  check(channelId: string, userId: string, at: number, seconds: number): number {
    const key = `${channelId}:${userId}`;
    const prev = this.last.get(key);
    if (prev !== undefined && at - prev < seconds * 1000) return Math.ceil((seconds * 1000 - (at - prev)) / 1000);
    this.last.set(key, at);
    return 0;
  }

  /** Drops entries older than the longest slowmode so memory stays bounded. */
  prune(now: number, maxSeconds: number): void {
    for (const [key, at] of this.last) if (now - at > maxSeconds * 1000) this.last.delete(key);
  }
}

// --- Auto delete --------------------------------------------------------------

export interface MessageShape {
  content: string;
  uris: Array<{ uri: string; attachment?: { mimeType?: string } | undefined }>;
}

const LINK = /https?:\/\/\S+/i;

export function matchesAllowType(msg: MessageShape, allow: AllowType, prefix: string): boolean {
  const attachments = msg.uris.filter((u) => u.attachment);
  const hasLink = msg.uris.some((u) => !u.attachment && /^https?:\/\//i.test(u.uri)) || LINK.test(msg.content);
  switch (allow) {
    case "any":
      return true;
    case "images":
      return (
        attachments.some((a) => /^(image|video)\//i.test(a.attachment?.mimeType ?? "")) ||
        msg.uris.some((u) => /\.(png|jpe?g|gif|webp|mp4|webm|mov)(\?|$)/i.test(u.uri))
      );
    case "attachments":
      return attachments.length > 0;
    case "links":
      return hasLink;
    case "text":
      return attachments.length === 0 && !hasLink && msg.content.trim().length > 0;
    case "commands":
      return msg.content.trimStart().startsWith(prefix);
  }
}

export const ALLOW_LABELS: Record<AllowType, string> = {
  any: "anything",
  images: "images and videos only",
  attachments: "attachments only",
  links: "links only",
  text: "text only",
  commands: "commands only",
};
