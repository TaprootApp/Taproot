// Pure helpers for the mod tools module (no SDK imports), so the tests can
// cover them without a Root connection.

export const MINUTE = 60_000;
export const DAY = 86_400_000;

/** Longest note a moderator can write. */
export const MAX_NOTE = 1000;
/** Temp roles last from one minute (job precision) to a year. */
export const MIN_TEMP_ROLE = MINUTE;
export const MAX_TEMP_ROLE = 365 * DAY;
/** Timed autoroles: at most this many rules, each 1 minute to 90 days after joining. */
export const MAX_TIMED_AUTOROLES = 10;
export const MIN_AUTOROLE_DELAY = MINUTE;
export const MAX_AUTOROLE_DELAY = 90 * DAY;
/** New mute/ban length set by "duration"; matches the moderation GUI's cap. */
export const MAX_CHANGED_DURATION = 5 * 365 * DAY;

export type NotifyAction = "warn" | "mute" | "kick" | "ban";
export const NOTIFY_ACTIONS: NotifyAction[] = ["warn", "mute", "kick", "ban"];

export interface TimedAutorole {
  roleId: string;
  delayMs: number;
}

export interface ModtoolsConfig {
  timedAutoroles: TimedAutorole[];
  /** Member push notifications per action. Off by default. */
  notify: Record<NotifyAction, boolean>;
}

export const DEFAULT_CONFIG: ModtoolsConfig = {
  timedAutoroles: [],
  notify: { warn: false, mute: false, kick: false, ban: false },
};

/**
 * Checks and normalizes a timed autorole list: whole-minute delays in range,
 * no role twice, at most MAX_TIMED_AUTOROLES. Returns the list or an error.
 */
export function normalizeTimedAutoroles(list: TimedAutorole[]): TimedAutorole[] | string {
  if (list.length > MAX_TIMED_AUTOROLES) return `You can have at most ${MAX_TIMED_AUTOROLES} timed autoroles.`;
  const seen = new Set<string>();
  const out: TimedAutorole[] = [];
  for (const entry of list) {
    const roleId = entry.roleId.trim();
    if (!roleId) return "Pick a role for every timed autorole.";
    if (seen.has(roleId)) return "Each role can only be a timed autorole once.";
    seen.add(roleId);
    if (!Number.isFinite(entry.delayMs)) return "That delay isn't valid.";
    const delayMs = Math.round(entry.delayMs / MINUTE) * MINUTE;
    if (delayMs < MIN_AUTOROLE_DELAY) return "Timed autoroles need a delay of at least 1 minute.";
    if (delayMs > MAX_AUTOROLE_DELAY) return "Timed autoroles can wait at most 90 days.";
    out.push({ roleId, delayMs });
  }
  return out.sort((a, b) => a.delayMs - b.delayMs);
}

// Notifications show on lock screens, so they never carry the reason or who
// acted: only that something happened, and where. Root caps the title at 50
// characters and the description at 150.
const NOTIFY_TITLE = 50;
const NOTIFY_DESCRIPTION = 150;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function notificationFor(action: NotifyAction, community: string): { title: string; description: string } {
  const where = community.trim() || "the community";
  const lines: Record<NotifyAction, [string, string]> = {
    warn: ["You received a warning", `You received a warning in ${where}.`],
    mute: ["You were muted", `You were muted in ${where}.`],
    kick: ["You were removed", `You were kicked from ${where}.`],
    ban: ["You were banned", `You were banned from ${where}.`],
  };
  const [title, description] = lines[action];
  return { title: clip(title, NOTIFY_TITLE), description: clip(description, NOTIFY_DESCRIPTION) };
}

/** "perm", "permanent", "forever", "off" or "0" mean no end; else a duration string parsed by `parse`. */
export function parseNewDuration(text: string, parse: (s: string) => number | undefined): number | undefined {
  const word = text.trim().toLowerCase();
  if (["perm", "permanent", "forever", "indefinite", "off", "0"].includes(word)) return 0;
  return parse(word);
}

/**
 * The case's total length after changing what's left: time already served
 * plus the new remainder. 0 (no end) stays 0.
 */
export function totalAfterChange(createdAt: number, now: number, remainingMs: number): number {
  if (remainingMs <= 0) return 0;
  return Math.max(0, now - createdAt) + remainingMs;
}

/** Root channel types are bit flags; voice is 4. */
export function isVoiceChannelType(channelType: number): boolean {
  return (channelType & 4) !== 0;
}

/** Members who joined after the watermark (ms), for catching up on joins missed while offline. */
export function joinedSince<T extends { joinedAtMs: number }>(members: T[], watermark: number): T[] {
  return members.filter((m) => m.joinedAtMs > watermark);
}

/** When each timed autorole comes due for a member who joined at `joinedAt`. */
export function autoroleSchedule(rules: TimedAutorole[], joinedAt: number): { roleId: string; dueAt: number }[] {
  return rules.map((r) => ({ roleId: r.roleId, dueAt: joinedAt + r.delayMs }));
}
