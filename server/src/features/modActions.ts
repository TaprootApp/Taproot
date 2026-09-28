import { rootServer, CommunityMemberBan, UserGuid } from "@rootsdk/server-app";
import { all, get, run } from "../db";
import { describeError, read, write } from "../lib/api";
import { formatDuration } from "../lib/time";
import { nicknameOf } from "../members";
import { activeWarnings, createCase, ModCase } from "../modlog";
import { canActOn } from "../permissions";
import { notifyChange } from "../services/changes";
import { muteMember, unmuteMember } from "./mute";

// The moderation actions themselves, shared by the text commands and the GUI
// so both apply the same checks, create the same cases and report the same
// follow-ups. Callers format the headline; `notes` are extra lines (partial
// failures, automatic punishments) written to read well in chat and the GUI.

export const MAX_BAN_REASON = 256;

/** The actor isn't allowed to act on the target (see canActOn). */
export class ActionRefused extends Error {}

export interface ActionOutcome {
  modCase: ModCase;
  /** The target's nickname when the action was taken. */
  name: string;
  notes: string[];
}

async function ensureCanAct(actorId: UserGuid, target: UserGuid): Promise<void> {
  const problem = await canActOn(actorId, target);
  if (problem) throw new ActionRefused(problem);
}

// --- Ban list ----------------------------------------------------------------

// The GUI's overview reads the ban list on every case broadcast, from every
// open staff client, so it's cached briefly. Bans made through Taproot clear
// it at once; ones made in Root's own UI show up within the TTL.
const BANS_TTL = 10_000;
let bansCache: { at: number; bans: Promise<CommunityMemberBan[]> } | undefined;

export function listBans(): Promise<CommunityMemberBan[]> {
  if (bansCache && Date.now() - bansCache.at < BANS_TTL) return bansCache.bans;
  const bans = read("communityMemberBans.list", () => rootServer.community.communityMemberBans.list());
  bansCache = { at: Date.now(), bans };
  // Don't cache a failure.
  bans.catch(() => {
    if (bansCache?.bans === bans) bansCache = undefined;
  });
  return bans;
}

function forgetBans(): void {
  bansCache = undefined;
}

// --- Warn thresholds ---------------------------------------------------------

export interface WarnAction {
  warn_count: number;
  action: "mute" | "kick" | "ban";
  duration_ms: number | null;
}

export async function listWarnActions(): Promise<WarnAction[]> {
  return all<WarnAction>("SELECT * FROM warn_actions ORDER BY warn_count");
}

export async function setWarnAction(count: number, action: WarnAction["action"], durationMs?: number): Promise<void> {
  await run("INSERT OR REPLACE INTO warn_actions (warn_count, action, duration_ms) VALUES (?, ?, ?)", [
    count,
    action,
    action === "kick" ? null : durationMs ?? null,
  ]);
  notifyChange("punishments");
}

export async function deleteWarnAction(count: number): Promise<void> {
  await run("DELETE FROM warn_actions WHERE warn_count = ?", [count]);
  notifyChange("punishments");
}

async function applyWarnThreshold(userId: UserGuid, count: number): Promise<string | undefined> {
  const rule = await get<WarnAction>("SELECT * FROM warn_actions WHERE warn_count = ?", [count]);
  if (!rule) return undefined;
  const reason = `Reached ${count} warnings`;
  const duration = rule.duration_ms ?? undefined;
  switch (rule.action) {
    case "mute":
      await muteMember({ userId, reason, durationMs: duration });
      return `🔇 Automatically muted${duration ? ` for ${formatDuration(duration)}` : ""} (${reason.toLowerCase()}).`;
    case "kick":
      await write("communityMemberBans.kick", () => rootServer.community.communityMemberBans.kick({ userId }));
      await createCase({ action: "kick", userId, reason });
      return `👢 Automatically kicked (${reason.toLowerCase()}).`;
    case "ban":
      await write("communityMemberBans.create", () =>
        rootServer.community.communityMemberBans.create({
          userId,
          reason,
          expiresAt: duration ? new Date(Date.now() + duration) : undefined,
        }),
      );
      forgetBans();
      await createCase({ action: "ban", userId, reason, durationMs: duration });
      return `🔨 Automatically banned${duration ? ` for ${formatDuration(duration)}` : ""} (${reason.toLowerCase()}).`;
  }
}

// --- Actions -----------------------------------------------------------------

export async function warnMember(opts: {
  actorId: UserGuid;
  userId: UserGuid;
  reason: string;
}): Promise<ActionOutcome & { count: number }> {
  await ensureCanAct(opts.actorId, opts.userId);
  const modCase = await createCase({ action: "warn", userId: opts.userId, moderatorId: opts.actorId, reason: opts.reason });
  const count = (await activeWarnings(opts.userId)).length;
  const notes: string[] = [];
  const auto = await applyWarnThreshold(opts.userId, count).catch((err) => `⚠️ Auto-punishment failed: ${describeError(err)}`);
  if (auto) notes.push(auto);
  return { modCase, name: modCase.user_name, notes, count };
}

export async function muteAction(opts: {
  actorId: UserGuid;
  userId: UserGuid;
  durationMs?: number;
  reason?: string;
}): Promise<ActionOutcome & { extended: boolean }> {
  await ensureCanAct(opts.actorId, opts.userId);
  const result = await muteMember({
    userId: opts.userId,
    moderatorId: opts.actorId,
    durationMs: opts.durationMs,
    reason: opts.reason,
  });
  const notes: string[] = [];
  if (result.applied === 0) notes.push("⚠️ I couldn't restrict any channels. Check that Taproot has Full Control on your channels.");
  else if (result.failed > 0) notes.push(`⚠️ ${result.failed} channel(s) couldn't be restricted.`);
  return { modCase: result.modCase, name: result.modCase.user_name, notes, extended: result.extended };
}

/** Like the unmute command, this doesn't check rank. Undefined if the member wasn't muted. */
export async function unmuteAction(opts: {
  actorId: UserGuid;
  userId: UserGuid;
  reason?: string;
}): Promise<ActionOutcome | undefined> {
  const result = await unmuteMember({ userId: opts.userId, moderatorId: opts.actorId, reason: opts.reason });
  if (!result) return undefined;
  const notes = result.failed ? [`⚠️ ${result.failed} channel(s) couldn't be restored; I'll retry automatically.`] : [];
  return { modCase: result.modCase, name: result.modCase.user_name, notes };
}

export async function kickMember(opts: { actorId: UserGuid; userId: UserGuid; reason?: string }): Promise<ActionOutcome> {
  await ensureCanAct(opts.actorId, opts.userId);
  // Read the name first: Root may not return the member once they're gone.
  const name = await nicknameOf(opts.userId);
  await write("communityMemberBans.kick", () => rootServer.community.communityMemberBans.kick({ userId: opts.userId }));
  const modCase = await createCase({
    action: "kick",
    userId: opts.userId,
    userName: name,
    moderatorId: opts.actorId,
    reason: opts.reason,
  });
  return { modCase, name, notes: [] };
}

export async function banMember(opts: {
  actorId: UserGuid;
  userId: UserGuid;
  durationMs?: number;
  reason?: string;
}): Promise<ActionOutcome> {
  const reason = opts.reason ?? "";
  if (reason.length > MAX_BAN_REASON) throw new ActionRefused(`Ban reasons can be at most ${MAX_BAN_REASON} characters.`);
  await ensureCanAct(opts.actorId, opts.userId);
  const name = await nicknameOf(opts.userId);
  await write("communityMemberBans.create", () =>
    rootServer.community.communityMemberBans.create({
      userId: opts.userId,
      reason: reason || undefined,
      expiresAt: opts.durationMs ? new Date(Date.now() + opts.durationMs) : undefined,
    }),
  );
  forgetBans();
  const modCase = await createCase({
    action: "ban",
    userId: opts.userId,
    userName: name,
    moderatorId: opts.actorId,
    reason,
    durationMs: opts.durationMs,
  });
  return { modCase, name, notes: [] };
}

/** Like the unban command, this doesn't check rank (the member has left). */
export async function unbanMember(opts: { actorId: UserGuid; userId: UserGuid; reason?: string }): Promise<ActionOutcome> {
  await write("communityMemberBans.delete", () => rootServer.community.communityMemberBans.delete({ userId: opts.userId }));
  forgetBans();
  const modCase = await createCase({ action: "unban", userId: opts.userId, moderatorId: opts.actorId, reason: opts.reason });
  return { modCase, name: modCase.user_name, notes: [] };
}
