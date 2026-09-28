import { UserGuid } from "@rootsdk/server-app";
import { all, get, run } from "./db";
import { log, errMessage } from "./lib/log";
import { formatDuration, formatUtc } from "./lib/time";
import { truncate } from "./lib/text";
import { nicknameOf } from "./members";
import { send } from "./messaging";
import { notifyChange } from "./services/changes";
import { settings } from "./settings";

// Every moderation action becomes a numbered case, stored in SQLite and posted
// to the mod-log channel. Bots can't write Root's built-in community log, so
// the channel is the audit trail staff read. Every change to a case also
// tells the GUI to refetch (see services/changes.ts).

export type CaseAction =
  | "warn"
  | "mute"
  | "unmute"
  | "kick"
  | "ban"
  | "unban"
  | "purge"
  | "lock"
  | "unlock"
  | "automod";

export interface ModCase {
  id: number;
  action: CaseAction;
  user_id: string;
  user_name: string;
  moderator_id: string;
  moderator_name: string;
  reason: string;
  duration_ms: number | null;
  voided: number;
  created_at: number;
}

const ICONS: Record<CaseAction, string> = {
  warn: "⚠️",
  mute: "🔇",
  unmute: "🔊",
  kick: "👢",
  ban: "🔨",
  unban: "🕊️",
  purge: "🧹",
  lock: "🔒",
  unlock: "🔓",
  automod: "🤖",
};

const TITLES: Record<CaseAction, string> = {
  warn: "Warning",
  mute: "Mute",
  unmute: "Unmute",
  kick: "Kick",
  ban: "Ban",
  unban: "Unban",
  purge: "Purge",
  lock: "Channel locked",
  unlock: "Channel unlocked",
  automod: "Auto-mod",
};

export const AUTOMOD_ACTOR = "Taproot auto-mod";

export interface NewCase {
  action: CaseAction;
  /** The affected member; for channel actions, the channel ID. */
  userId: string;
  /** Display name override for userId (used for channel actions). */
  userName?: string;
  /** Empty for automatic actions. */
  moderatorId?: string;
  reason?: string;
  durationMs?: number;
}

export async function createCase(input: NewCase): Promise<ModCase> {
  const userName = input.userName ?? (await nicknameOf(input.userId as UserGuid));
  const moderatorName = input.moderatorId ? await nicknameOf(input.moderatorId as UserGuid) : AUTOMOD_ACTOR;
  const now = Date.now();
  const { lastID } = await run(
    `INSERT INTO mod_cases (action, user_id, user_name, moderator_id, moderator_name, reason, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.action,
      input.userId,
      userName,
      input.moderatorId ?? "",
      moderatorName,
      truncate(input.reason ?? "", 500),
      input.durationMs ?? null,
      now,
    ],
  );
  const modCase = (await getCase(lastID))!;
  notifyChange("cases");
  await postToModLog(modCase);
  return modCase;
}

export async function getCase(id: number): Promise<ModCase | undefined> {
  return get<ModCase>("SELECT * FROM mod_cases WHERE id = ?", [id]);
}

export async function casesFor(userId: string, limit = 15): Promise<ModCase[]> {
  return all<ModCase>("SELECT * FROM mod_cases WHERE user_id = ? ORDER BY id DESC LIMIT ?", [userId, limit]);
}

export async function activeWarnings(userId: string): Promise<ModCase[]> {
  return all<ModCase>("SELECT * FROM mod_cases WHERE user_id = ? AND action = 'warn' AND voided = 0 ORDER BY id DESC", [
    userId,
  ]);
}

export async function updateReason(id: number, reason: string): Promise<boolean> {
  const { changes } = await run("UPDATE mod_cases SET reason = ? WHERE id = ?", [truncate(reason, 500), id]);
  if (changes > 0) notifyChange("cases");
  return changes > 0;
}

/** Voids one warning. Returns the updated case, or undefined if it isn't a warning. */
export async function voidWarning(id: number): Promise<ModCase | undefined> {
  const c = await getCase(id);
  if (!c || c.action !== "warn") return undefined;
  await run("UPDATE mod_cases SET voided = 1 WHERE id = ?", [id]);
  notifyChange("cases");
  return { ...c, voided: 1 };
}

/** Voids all of a member's active warnings; returns how many. */
export async function clearWarnings(userId: string): Promise<number> {
  const { changes } = await run("UPDATE mod_cases SET voided = 1 WHERE user_id = ? AND action = 'warn' AND voided = 0", [
    userId,
  ]);
  if (changes > 0) notifyChange("cases");
  return changes;
}

export interface CaseQuery {
  userId?: string;
  action?: CaseAction;
  /** Only cases with a lower ID (paging backwards). */
  beforeId?: number;
  limit: number;
}

/** Newest first. */
export async function queryCases(q: CaseQuery): Promise<ModCase[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId) {
    where.push("user_id = ?");
    params.push(q.userId);
  }
  if (q.action) {
    where.push("action = ?");
    params.push(q.action);
  }
  if (q.beforeId) {
    where.push("id < ?");
    params.push(q.beforeId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return all<ModCase>(`SELECT * FROM mod_cases ${clause} ORDER BY id DESC LIMIT ?`, [...params, q.limit]);
}

export function formatCase(c: ModCase, options: { full?: boolean } = {}): string {
  const lines = [`${ICONS[c.action]} **${TITLES[c.action]}** · Case #${c.id}${c.voided ? " · ~~voided~~" : ""}`];
  const isChannel = c.action === "lock" || c.action === "unlock" || c.action === "purge";
  lines.push(`**${isChannel ? "Channel" : "Member"}:** ${c.user_name}${isChannel ? "" : ` \`${c.user_id}\``}`);
  lines.push(`**Moderator:** ${c.moderator_name}`);
  if (c.reason) lines.push(`**Reason:** ${c.reason}`);
  if (c.duration_ms) lines.push(`**Duration:** ${formatDuration(c.duration_ms)}`);
  if (options.full !== false) lines.push(`*${formatUtc(c.created_at)}*`);
  return lines.join("\n");
}

/** One-line summary for lists. */
export function formatCaseLine(c: ModCase): string {
  const duration = c.duration_ms ? ` (${formatDuration(c.duration_ms)})` : "";
  const reason = c.reason ? ` · ${truncate(c.reason, 80)}` : "";
  const text = `#${c.id} ${ICONS[c.action]} ${TITLES[c.action]}${duration}${reason} · by ${c.moderator_name} · ${formatUtc(c.created_at)}`;
  return c.voided ? `~~${text}~~` : text;
}

async function postToModLog(c: ModCase): Promise<void> {
  const channelId = settings().modLogChannel;
  if (!channelId) return;
  try {
    await send(channelId, formatCase(c));
  } catch (err) {
    log("warn", "posting to mod log failed", { error: errMessage(err), caseId: c.id });
  }
}

/** Plain notices (config changes, errors worth staff attention). */
export async function modLogNotice(content: string): Promise<void> {
  const channelId = settings().modLogChannel;
  if (!channelId) return;
  await send(channelId, content).catch((err) => log("warn", "mod log notice failed", { error: errMessage(err) }));
}
