import { rootServer, CommunityRoleGuid, ErrorCodeType, UserGuid, WellKnownRootGuids } from "@rootsdk/server-app";
import { all, get, run } from "../../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { errorCode, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { formatDuration } from "../../lib/time";
import { nicknameOf } from "../../members";
import { modLogNotice } from "../../modlog";
import { canActOn, forgetMember, isPrivileged, Level, listRoles, memberRoleIds } from "../../permissions";
import { notifyChange } from "../../services/changes";
import { MAX_TEMP_ROLE, MIN_TEMP_ROLE } from "./logic";
import { changed } from "./store";

// Temp roles: a role given now and taken back by a job later. The row is the
// record of what Taproot has to undo; it's deleted once the role is removed.

const JOB = "modtoolsTempRole";

export interface TempRoleRow {
  id: number;
  user_id: string;
  role_id: string;
  role_name: string;
  expires_at: number;
  added_by: string;
  added_by_name: string;
  created_at: number;
}

/** A refusal worded for the moderator (rank, staff role, bad input). */
export class TempRoleRefused extends Error {}

export async function activeTempRoles(userId?: string): Promise<TempRoleRow[]> {
  return userId
    ? all<TempRoleRow>("SELECT * FROM modtools_temp_roles WHERE user_id = ? ORDER BY expires_at", [userId])
    : all<TempRoleRow>("SELECT * FROM modtools_temp_roles ORDER BY expires_at");
}

export async function giveTempRole(opts: {
  actorId: UserGuid;
  actorLevel: Level;
  userId: UserGuid;
  roleId: string;
  durationMs: number;
}): Promise<{ row: TempRoleRow; extended: boolean; name: string }> {
  const { actorId, userId, roleId, durationMs } = opts;
  if (!(durationMs >= MIN_TEMP_ROLE && durationMs <= MAX_TEMP_ROLE)) {
    throw new TempRoleRefused("Temp roles last from 1 minute to 1 year.");
  }
  const role = (await listRoles()).find((r) => r.id === roleId);
  if (!role || role.id === WellKnownRootGuids.CommunityRoles.EveryoneRole) throw new TempRoleRefused("I couldn't find that role.");
  if (isPrivileged(role) && opts.actorLevel < Level.Admin) throw new TempRoleRefused("Only admins can hand out staff roles.");
  if (userId !== actorId) {
    const problem = await canActOn(actorId, userId);
    if (problem) throw new TempRoleRefused(problem);
  }

  const expiresAt = Date.now() + durationMs;
  const existing = await get<TempRoleRow>("SELECT * FROM modtools_temp_roles WHERE user_id = ? AND role_id = ?", [userId, roleId]);
  forgetMember(userId);
  let roleIds: string[];
  try {
    roleIds = await memberRoleIds(userId);
  } catch {
    throw new TempRoleRefused("That member isn't in the community.");
  }
  // Taking a permanent role away later would be a surprise, so refuse.
  if (!existing && roleIds.includes(roleId)) {
    throw new TempRoleRefused(`They already have **${role.name}** permanently. Remove it first to make it temporary.`);
  }

  let id: number;
  if (existing) {
    id = existing.id;
    await run("UPDATE modtools_temp_roles SET expires_at = ? WHERE id = ?", [expiresAt, id]);
    await cancelJobs(JOB, id).catch(() => undefined);
  } else {
    id = (
      await run(
        `INSERT INTO modtools_temp_roles (user_id, role_id, role_name, expires_at, added_by, added_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, roleId, role.name, expiresAt, actorId, await nicknameOf(actorId), Date.now()],
      )
    ).lastID;
  }
  if (!roleIds.includes(roleId)) {
    try {
      await write("communityMemberRoles.add", () =>
        rootServer.community.communityMemberRoles.add({ communityRoleId: roleId as CommunityRoleGuid, userIds: [userId] }),
      );
    } catch (err) {
      if (!existing) await run("DELETE FROM modtools_temp_roles WHERE id = ?", [id]);
      throw err;
    }
    forgetMember(userId);
    notifyChange("selfroles");
  }
  await scheduleOnce(JOB, id, expiresAt);
  changed("temproles");

  const name = await nicknameOf(userId);
  const actor = await nicknameOf(actorId);
  await modLogNotice(
    `⏳ **Temp role** · **${name}** \`${userId}\` ${existing ? "keeps" : "was given"} **${role.name}** for ${formatDuration(durationMs)} · by ${actor}`,
  );
  const row = (await get<TempRoleRow>("SELECT * FROM modtools_temp_roles WHERE id = ?", [id]))!;
  return { row, extended: Boolean(existing), name };
}

/** Takes the role back now. `false` if removal failed and will be retried. */
async function takeBack(row: TempRoleRow): Promise<boolean> {
  try {
    await write("communityMemberRoles.remove", () =>
      rootServer.community.communityMemberRoles.remove({
        communityRoleId: row.role_id as CommunityRoleGuid,
        userIds: [row.user_id as UserGuid],
      }),
    );
    forgetMember(row.user_id as UserGuid);
    notifyChange("selfroles");
  } catch (err) {
    // The member left or the role was deleted: nothing left to undo.
    if (errorCode(err) !== ErrorCodeType.NotFound) {
      log("warn", "temp role removal failed", { id: row.id, error: errMessage(err) });
      return false;
    }
  }
  await run("DELETE FROM modtools_temp_roles WHERE id = ?", [row.id]);
  await cancelJobs(JOB, row.id).catch(() => undefined);
  changed("temproles");
  return true;
}

/** Ends a temp role early. Undefined if there's no such temp role. */
export async function endTempRole(id: number, actorId: UserGuid): Promise<TempRoleRow | undefined> {
  const row = await get<TempRoleRow>("SELECT * FROM modtools_temp_roles WHERE id = ?", [id]);
  if (!row) return undefined;
  if (!(await takeBack(row))) throw new Error("Root refused to remove the role. Check Taproot's role permissions.");
  const name = await nicknameOf(row.user_id as UserGuid);
  await modLogNotice(`⌛ **Temp role ended** · **${name}** lost **${row.role_name}** · by ${await nicknameOf(actorId)}`);
  return row;
}

async function expire(id: number): Promise<void> {
  const row = await get<TempRoleRow>("SELECT * FROM modtools_temp_roles WHERE id = ?", [id]);
  // Extended past this job's time: its own later job handles it.
  if (!row || row.expires_at > Date.now() + 60_000) return;
  await takeBack(row);
}

async function reconcile(): Promise<void> {
  for (const row of await activeTempRoles()) {
    if (row.expires_at <= Date.now()) await expire(row.id);
    else if (!(await hasJob(JOB, row.id))) await scheduleOnce(JOB, row.id, row.expires_at);
  }
}

export function initTempRoles(): void {
  onJob(JOB, expire);
  onReconcile(reconcile);
}
