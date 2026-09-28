import {
  rootServer,
  CommunityEvent,
  CommunityJoinedEvent,
  CommunityRoleGuid,
  ErrorCodeType,
  UserGuid,
} from "@rootsdk/server-app";
import { all, get, run } from "../../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { errorCode, read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { forgetMember, isPrivileged, listRoles } from "../../permissions";
import { notifyChange } from "../../services/changes";
import { autoroleSchedule, joinedSince } from "./logic";
import { config } from "./store";

// Timed autoroles (Dyno): roles given some time after a member joins, e.g.
// "Regular" after a day. Each pending grant is a row plus a one-time job.
// Joins that happened while Taproot was offline are caught by comparing
// members' join times with a watermark (the latest join already handled).

const JOB = "modtoolsAutorole";
const WATERMARK = "autoroleWatermark";

interface PendingRow {
  id: number;
  user_id: string;
  role_id: string;
  due_at: number;
  created_at: number;
}

async function watermark(): Promise<number | undefined> {
  const row = await get<{ value: string }>("SELECT value FROM modtools_state WHERE key = ?", [WATERMARK]);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

async function raiseWatermark(at: number): Promise<void> {
  await run(
    `INSERT INTO modtools_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CASE WHEN CAST(value AS INTEGER) < CAST(excluded.value AS INTEGER) THEN excluded.value ELSE value END`,
    [WATERMARK, String(at)],
  );
}

async function schedule(userId: string, joinedAt: number): Promise<void> {
  for (const { roleId, dueAt } of autoroleSchedule(config().timedAutoroles, joinedAt)) {
    const { lastID } = await run("INSERT INTO modtools_pending_roles (user_id, role_id, due_at, created_at) VALUES (?, ?, ?, ?)", [
      userId,
      roleId,
      dueAt,
      Date.now(),
    ]);
    await scheduleOnce(JOB, lastID, dueAt);
  }
}

async function onJoin(evt: CommunityJoinedEvent): Promise<void> {
  const now = Date.now();
  // A little past now absorbs clock skew with Root's join time, so catch-up
  // never schedules a member this event already handled.
  await raiseWatermark(now + 60_000);
  if (config().timedAutoroles.length === 0) return;
  // A member who leaves and rejoins starts over.
  await forgetPending(evt.userId);
  await schedule(evt.userId, now);
}

async function forgetPending(userId: string): Promise<void> {
  const rows = await all<PendingRow>("SELECT * FROM modtools_pending_roles WHERE user_id = ?", [userId]);
  for (const row of rows) {
    await run("DELETE FROM modtools_pending_roles WHERE id = ?", [row.id]);
    await cancelJobs(JOB, row.id).catch(() => undefined);
  }
}

async function grant(id: number): Promise<void> {
  const row = await get<PendingRow>("SELECT * FROM modtools_pending_roles WHERE id = ?", [id]);
  if (!row || row.due_at > Date.now() + 60_000) return;
  const done = () => run("DELETE FROM modtools_pending_roles WHERE id = ?", [id]);

  // The rule may have been removed since the member joined.
  if (!config().timedAutoroles.some((r) => r.roleId === row.role_id)) return void (await done());
  const role = (await listRoles()).find((r) => r.id === row.role_id);
  // Deleted, or gained staff permissions since it was configured.
  if (!role || isPrivileged(role)) return void (await done());

  let roleIds: string[];
  try {
    const member = await read("communityMembers.get", () =>
      rootServer.community.communityMembers.get({ userId: row.user_id as UserGuid }),
    );
    roleIds = member.communityRoleIds;
  } catch (err) {
    // Left the community: skip. Anything else, reconcile retries.
    if (errorCode(err) === ErrorCodeType.NotFound) await done();
    else log("warn", "timed autorole member lookup failed", { error: errMessage(err) });
    return;
  }
  if (!roleIds.includes(row.role_id)) {
    await write("communityMemberRoles.add", () =>
      rootServer.community.communityMemberRoles.add({
        communityRoleId: row.role_id as CommunityRoleGuid,
        userIds: [row.user_id as UserGuid],
      }),
    );
    forgetMember(row.user_id as UserGuid);
    notifyChange("selfroles");
  }
  await done();
}

async function catchUpJoins(): Promise<void> {
  const mark = await watermark();
  if (mark === undefined) {
    // First run: only members joining from now on get timed autoroles.
    await raiseWatermark(Date.now());
    return;
  }
  if (config().timedAutoroles.length === 0) {
    await raiseWatermark(Date.now());
    return;
  }
  const members = await read("communityMembers.listAll", () => rootServer.community.communityMembers.listAll());
  const withTimes = members.map((m) => ({ userId: m.userId, joinedAtMs: m.joinedAt ? new Date(m.joinedAt).getTime() : 0 }));
  let latest = mark;
  for (const m of joinedSince(withTimes, mark)) {
    const pending = await get("SELECT 1 FROM modtools_pending_roles WHERE user_id = ?", [m.userId]);
    if (!pending) await schedule(m.userId, m.joinedAtMs);
    latest = Math.max(latest, m.joinedAtMs);
  }
  await raiseWatermark(latest);
}

async function reconcile(): Promise<void> {
  await catchUpJoins();
  for (const row of await all<PendingRow>("SELECT * FROM modtools_pending_roles")) {
    if (row.due_at <= Date.now()) await grant(row.id);
    else if (!(await hasJob(JOB, row.id))) await scheduleOnce(JOB, row.id, row.due_at);
  }
}

export function initTimedAutoroles(): void {
  onJob(JOB, grant);
  onReconcile(reconcile);
  const communities = rootServer.community.communities;
  communities.on(CommunityEvent.CommunityJoined, (evt) => {
    onJoin(evt).catch((err) => log("warn", "timed autorole scheduling failed", { error: errMessage(err) }));
  });
  communities.on(CommunityEvent.CommunityLeave, (evt) => {
    forgetPending(evt.userId).catch((err) => log("warn", "timed autorole cleanup failed", { error: errMessage(err) }));
  });
}
