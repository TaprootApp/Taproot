import {
  rootServer,
  ChannelOverlayPermission,
  CommunityEvent,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-app";
import { all, get, run } from "../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../jobs";
import { read } from "../lib/api";
import { log, errMessage } from "../lib/log";
import { applyPatch, existingRulesForSubject, MUTE_PATCH, restorePatch } from "../lib/overlays";
import { createCase, ModCase } from "../modlog";
import { memberRoleIds } from "../permissions";
import { notifyChange } from "../services/changes";

// Root has no text timeout. A mute is a member-specific access rule denying
// posting on every channel group the member can see, plus each channel that
// uses its own permissions instead of its group's. Member rules are applied
// after role rules, so no role can override them.
//
// Two traps this avoids:
//   - Any access rule makes its target visible to its subject, so a rule on a
//     private channel would reveal it. Only targets the member can already see
//     (one of their roles, @everyone, or they themself has a rule there) get one.
//   - Members whose roles have Full Control can't be restricted by overlays.

export interface MuteRow {
  id: number;
  user_id: string;
  case_id: number | null;
  expires_at: number | null;
  active: number;
  created_at: number;
}

interface MuteRuleRow {
  mute_id: number;
  target_id: string;
  original_overlay: string | null;
}

export async function activeMutes(): Promise<MuteRow[]> {
  return all<MuteRow>("SELECT * FROM mutes WHERE active = 1 ORDER BY id DESC");
}

export async function activeMute(userId: string): Promise<MuteRow | undefined> {
  return get<MuteRow>("SELECT * FROM mutes WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1", [userId]);
}

/** Channel groups and independent channels the member can currently see. */
async function muteTargets(userId: UserGuid): Promise<string[]> {
  const subjects = new Set<string>([userId, WellKnownRootGuids.CommunityRoles.EveryoneRole]);
  for (const roleId of await memberRoleIds(userId)) subjects.add(roleId);
  const visible = (ids: string[]) => ids.some((id) => subjects.has(id));

  const targets: string[] = [];
  const groups = await read("channelGroups.list", () => rootServer.community.channelGroups.list());
  for (const group of groups) {
    const groupVisible = visible(group.roleOrMemberIds);
    if (groupVisible) targets.push(group.id);
    const channels = await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: group.id }));
    for (const channel of channels) {
      if (!channel.useChannelGroupPermission && visible(channel.roleOrMemberIds)) targets.push(channel.id);
    }
  }
  return targets;
}

export interface MuteResult {
  modCase: ModCase;
  applied: number;
  failed: number;
  extended: boolean;
}

// Mutes and unmutes of one member run one at a time. Two overlapping mutes
// (auto-mod handling a burst of messages at once) would otherwise both see
// "not muted", create two mute rows, and the second would save the first's
// deny rules as the "original" to restore, leaving the member muted forever.
const queues = new Map<string, Promise<unknown>>();

function oneAtATime<T>(userId: string, op: () => Promise<T>): Promise<T> {
  const previous = queues.get(userId) ?? Promise.resolve();
  const result = previous.then(op, op);
  const tail = result.catch(() => undefined);
  queues.set(userId, tail);
  void tail.then(() => {
    if (queues.get(userId) === tail) queues.delete(userId);
  });
  return result;
}

export function muteMember(options: {
  userId: UserGuid;
  moderatorId?: string;
  durationMs?: number;
  reason?: string;
}): Promise<MuteResult> {
  return oneAtATime(options.userId, () => applyMute(options));
}

async function applyMute(options: {
  userId: UserGuid;
  moderatorId?: string;
  durationMs?: number;
  reason?: string;
}): Promise<MuteResult> {
  const { userId, durationMs } = options;
  const expiresAt = durationMs ? Date.now() + durationMs : null;

  const current = await activeMute(userId);
  let muteId: number;
  let applied = 0;
  let failed = 0;
  if (current) {
    // Already muted: change the expiry and top up rules on any new channels.
    muteId = current.id;
    await run("UPDATE mutes SET expires_at = ? WHERE id = ?", [expiresAt, muteId]);
    await cancelJobs("unmute", muteId);
  } else {
    muteId = (await run("INSERT INTO mutes (user_id, expires_at, active, created_at) VALUES (?, ?, 1, ?)", [
      userId,
      expiresAt,
      Date.now(),
    ])).lastID;
  }

  const done = new Set(
    (await all<MuteRuleRow>("SELECT target_id FROM mute_rules WHERE mute_id = ?", [muteId])).map((r) => r.target_id),
  );
  const existing = await existingRulesForSubject(userId);
  for (const targetId of await muteTargets(userId)) {
    if (done.has(targetId)) continue;
    const prior = existing.get(targetId);
    // Record first so a crash mid-mute still leaves enough to undo it.
    await run("INSERT OR REPLACE INTO mute_rules (mute_id, target_id, original_overlay) VALUES (?, ?, ?)", [
      muteId,
      targetId,
      prior ? JSON.stringify(prior.overlay) : null,
    ]);
    try {
      await applyPatch(targetId, userId, MUTE_PATCH, prior);
      applied++;
    } catch (err) {
      failed++;
      await run("DELETE FROM mute_rules WHERE mute_id = ? AND target_id = ?", [muteId, targetId]);
      log("warn", "mute rule failed", { targetId, error: errMessage(err) });
    }
  }

  if (expiresAt) await scheduleOnce("unmute", muteId, expiresAt);

  const modCase = await createCase({
    action: "mute",
    userId,
    moderatorId: options.moderatorId,
    reason: options.reason,
    durationMs,
  });
  await run("UPDATE mutes SET case_id = ? WHERE id = ?", [modCase.id, muteId]);
  notifyChange("cases");
  return { modCase, applied: applied + done.size, failed, extended: Boolean(current) };
}

async function liftMute(mute: MuteRow): Promise<number> {
  const rules = await all<MuteRuleRow>("SELECT * FROM mute_rules WHERE mute_id = ?", [mute.id]);
  let failed = 0;
  for (const rule of rules) {
    try {
      const original = rule.original_overlay ? (JSON.parse(rule.original_overlay) as ChannelOverlayPermission) : null;
      await restorePatch(rule.target_id, mute.user_id, original);
      await run("DELETE FROM mute_rules WHERE mute_id = ? AND target_id = ?", [mute.id, rule.target_id]);
    } catch (err) {
      failed++;
      log("warn", "unmute rule restore failed", { targetId: rule.target_id, error: errMessage(err) });
    }
  }
  // Leave the mute active if anything failed so reconcile retries it.
  if (failed === 0) {
    await run("UPDATE mutes SET active = 0 WHERE id = ?", [mute.id]);
    await cancelJobs("unmute", mute.id);
    notifyChange("cases");
  }
  return failed;
}

/** Returns undefined if the member wasn't muted. */
export function unmuteMember(options: {
  userId: UserGuid;
  moderatorId?: string;
  reason?: string;
}): Promise<{ modCase: ModCase; failed: number } | undefined> {
  return oneAtATime(options.userId, () => liftMemberMute(options));
}

async function liftMemberMute(options: {
  userId: UserGuid;
  moderatorId?: string;
  reason?: string;
}): Promise<{ modCase: ModCase; failed: number } | undefined> {
  const mute = await activeMute(options.userId);
  if (!mute) return undefined;
  const failed = await liftMute(mute);
  const modCase = await createCase({
    action: "unmute",
    userId: options.userId,
    moderatorId: options.moderatorId,
    reason: options.reason,
  });
  return { modCase, failed };
}

async function expire(muteId: number): Promise<void> {
  const mute = await get<MuteRow>("SELECT * FROM mutes WHERE id = ? AND active = 1", [muteId]);
  if (!mute) return;
  // A mute extended past this job's time gets its own later job.
  if (mute.expires_at && mute.expires_at > Date.now() + 60_000) return;
  if ((await liftMute(mute)) === 0) {
    await createCase({ action: "unmute", userId: mute.user_id, reason: "Mute expired" });
  }
}

async function reconcile(): Promise<void> {
  const mutes = await all<MuteRow>("SELECT * FROM mutes WHERE active = 1 AND expires_at IS NOT NULL");
  for (const mute of mutes) {
    if (mute.expires_at! <= Date.now()) await expire(mute.id);
    else if (!(await hasJob("unmute", mute.id))) await scheduleOnce("unmute", mute.id, mute.expires_at!);
  }
}

export function initMutes(): void {
  onJob("unmute", expire);
  onReconcile(reconcile);
  // Leaving and rejoining shouldn't escape a mute: re-apply on return.
  rootServer.community.communities.on(CommunityEvent.CommunityJoined, async (evt) => {
    try {
      const mute = await activeMute(evt.userId);
      if (!mute) return;
      const rules = await all<MuteRuleRow>("SELECT * FROM mute_rules WHERE mute_id = ?", [mute.id]);
      const existing = await existingRulesForSubject(evt.userId);
      for (const rule of rules) {
        if (!existing.has(rule.target_id)) await applyPatch(rule.target_id, evt.userId, MUTE_PATCH, undefined);
      }
    } catch (err) {
      log("warn", "re-applying mute on rejoin failed", { error: errMessage(err) });
    }
  });
}
