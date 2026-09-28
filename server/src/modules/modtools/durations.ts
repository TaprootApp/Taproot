import { rootServer, CommunityMemberBan, ErrorCodeType, UserGuid } from "@rootsdk/server-app";
import { run } from "../../db";
import { activeMute } from "../../features/mute";
import { cancelJobs, scheduleOnce } from "../../jobs";
import { errorCode, read, write } from "../../lib/api";
import { formatDuration, formatUtc } from "../../lib/time";
import { nicknameOf } from "../../members";
import { getCase, modLogNotice } from "../../modlog";
import { canActOn } from "../../permissions";
import { notifyChange } from "../../services/changes";
import { MAX_CHANGED_DURATION, totalAfterChange } from "./logic";

// "duration <case> <length>": change how long an active mute or temp ban has
// left. Mutes move their unmute job (features/mute.ts's expire skips a job
// that fires early). Root can't edit a ban, so a ban is lifted and placed
// again with the new end and the same reason.

export class DurationRefused extends Error {}

/** `remainingMs` 0 means no end. Returns a sentence describing the change. */
export async function changeDuration(actorId: UserGuid, caseId: number, remainingMs: number): Promise<string> {
  if (!Number.isFinite(remainingMs) || remainingMs < 0 || remainingMs > MAX_CHANGED_DURATION) {
    throw new DurationRefused("That duration isn't valid.");
  }
  const c = await getCase(caseId);
  if (!c) throw new DurationRefused("No case with that number.");
  if (c.action !== "mute" && c.action !== "ban") throw new DurationRefused("Only mute and ban cases have a duration to change.");
  const userId = c.user_id as UserGuid;
  const problem = await canActOn(actorId, userId);
  if (problem) throw new DurationRefused(problem);

  const now = Date.now();
  const expiresAt = remainingMs > 0 ? now + remainingMs : undefined;
  const name = c.user_name || (await nicknameOf(userId));
  let headline: string;

  if (c.action === "mute") {
    const mute = await activeMute(userId);
    if (!mute) throw new DurationRefused(`${name} isn't muted any more.`);
    await run("UPDATE mutes SET expires_at = ? WHERE id = ?", [expiresAt ?? null, mute.id]);
    await cancelJobs("unmute", mute.id).catch(() => undefined);
    if (expiresAt) await scheduleOnce("unmute", mute.id, expiresAt);
    headline = expiresAt
      ? `${name}'s mute now ends in ${formatDuration(remainingMs)} (${formatUtc(expiresAt)}).`
      : `${name} is now muted indefinitely.`;
  } else {
    let ban: CommunityMemberBan;
    try {
      ban = await read("communityMemberBans.get", () => rootServer.community.communityMemberBans.get({ userId }));
    } catch (err) {
      if (errorCode(err) === ErrorCodeType.NotFound) throw new DurationRefused(`${name} isn't banned any more.`);
      throw err;
    }
    await reban(userId, ban, expiresAt);
    headline = expiresAt
      ? `${name}'s ban now ends in ${formatDuration(remainingMs)} (${formatUtc(expiresAt)}).`
      : `${name} is now banned permanently.`;
  }

  await run("UPDATE mod_cases SET duration_ms = ? WHERE id = ?", [totalAfterChange(c.created_at, now, remainingMs) || null, c.id]);
  notifyChange("cases");
  await modLogNotice(`⏱️ **Duration changed** · Case #${c.id} · ${headline} · by ${await nicknameOf(actorId)}`);
  return headline;
}

/** Replaces a ban with one ending at `expiresAt`, putting the old one back if that fails. */
async function reban(userId: UserGuid, old: CommunityMemberBan, expiresAt: number | undefined): Promise<void> {
  const bans = rootServer.community.communityMemberBans;
  await write("communityMemberBans.delete", () => bans.delete({ userId }));
  try {
    await write("communityMemberBans.create", () =>
      bans.create({ userId, reason: old.reason || undefined, expiresAt: expiresAt ? new Date(expiresAt) : undefined }),
    );
  } catch (err) {
    try {
      await write("communityMemberBans.create", () =>
        bans.create({ userId, reason: old.reason || undefined, expiresAt: old.expiresAt ? new Date(old.expiresAt) : undefined }),
      );
    } catch {
      throw new Error("Root lifted the old ban but refused the new one, and putting the old one back failed. Ban them again.");
    }
    throw err;
  }
}
