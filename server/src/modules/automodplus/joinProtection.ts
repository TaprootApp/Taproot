import {
  rootServer,
  ChannelGuid,
  ChannelOverlayPermission,
  CommunityEvent,
  CommunityJoinThrottle,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-app";
import { register, UsageError } from "../../commands/registry";
import { get, run } from "../../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { applyPatch, existingRule, LOCK_PATCH, restorePatch } from "../../lib/overlays";
import { channelMention, truncate } from "../../lib/text";
import { formatDuration, formatUtc } from "../../lib/time";
import { nicknameOf } from "../../members";
import { send } from "../../messaging";
import { createCase, modLogNotice } from "../../modlog";
import { isOwner, Level } from "../../permissions";
import { notifyChange } from "../../services/changes";
import { MAX_BAN_REASON } from "../../features/modActions";
import { checkInt, cleanPatterns, LIMITS } from "./config";
import { noteJoin } from "./joinTimes";
import { autobanReason, JoinTracker } from "./logic";
import { AREA, plusConfig, updatePlus } from "./state";

// Join protection: Dyno's Autoban (rules applied when someone joins) and raid
// protection. A raid is more than N joins in M seconds; raid mode can lock
// chosen channels (the same @everyone rule !lock uses, recorded in the same
// locks table so !unlock also works) and tighten Root's join throttle. It
// ends with "raid off", or automatically after a set time.

const RAID_KIND = "automodplusRaid";
const joins = new JoinTracker();

// --- Autoban ------------------------------------------------------------------

async function applyAutoban(userId: UserGuid): Promise<boolean> {
  const rules = plusConfig().autoban;
  if (!rules.enabled || (rules.namePatterns.length === 0 && rules.minAccountDays <= 0)) return false;
  const nickname = await nicknameOf(userId);
  const hit = autobanReason({ nickname, userId }, rules);
  if (!hit) return false;
  const why = hit.kind === "name" ? `name matches "${hit.pattern}"` : `account is ${hit.days < 1 ? "under a day" : `${Math.floor(hit.days)} day(s)`} old`;
  const reason = truncate(`${rules.reason || "Autoban"} (${why})`, MAX_BAN_REASON);
  if (rules.action === "ban") {
    await write("communityMemberBans.create", () => rootServer.community.communityMemberBans.create({ userId, reason }));
  } else {
    await write("communityMemberBans.kick", () => rootServer.community.communityMemberBans.kick({ userId }));
  }
  await createCase({ action: rules.action, userId, userName: nickname, reason: `Autoban: ${why}` });
  return true;
}

// --- Raid mode ----------------------------------------------------------------

interface RaidRow {
  started_at: number;
  ends_at: number | null;
  prior_throttle: string | null;
  throttled: number;
  locked: string;
  reason: string;
}

export interface RaidStatus {
  active: boolean;
  startedAt?: number;
  endsAt?: number;
  lockedCount: number;
  throttled: boolean;
  reason?: string;
}

export async function raidStatus(): Promise<RaidStatus> {
  const row = await get<RaidRow>("SELECT * FROM automodplus_raid WHERE id = 1");
  if (!row) return { active: false, lockedCount: 0, throttled: false };
  return {
    active: true,
    startedAt: row.started_at,
    endsAt: row.ends_at ?? undefined,
    lockedCount: (JSON.parse(row.locked) as unknown[]).length,
    throttled: row.throttled === 1,
    reason: row.reason,
  };
}

/** Channel groups take the rule when the channel shares their permissions (same as !lock). */
async function lockTargetOf(channelId: string): Promise<{ targetId: string; label: string }> {
  const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
  if (!channel.useChannelGroupPermission) return { targetId: channel.id, label: channelMention(channel.name, channel.id) };
  const group = await read("channelGroups.get", () => rootServer.community.channelGroups.get({ id: channel.channelGroupId }));
  return { targetId: group.id, label: `the **${group.name}** channel group` };
}

/** Community edits replace every field, so the current values are read and sent back with the change. */
async function setJoinThrottle(throttle: CommunityJoinThrottle | undefined): Promise<void> {
  const c = await read("communities.get", () => rootServer.community.communities.get());
  await write("communities.edit", () =>
    rootServer.community.communities.edit({
      name: c.name,
      pictureHex: c.pictureHex,
      updatePicture: false,
      defaultChannelId: c.defaultChannelId,
      rejectUnverifiedEmail: c.rejectUnverifiedEmail,
      joinThrottle: throttle,
      description: c.description,
      isAgeRestricted: c.isAgeRestricted,
    }),
  );
}

let starting = false;

export async function startRaid(opts: { reason: string; moderatorId?: string }): Promise<string[]> {
  if (starting || (await raidStatus()).active) throw new UsageError("Raid mode is already on.");
  starting = true;
  try {
    const cfg = plusConfig().raid;
    const now = Date.now();
    const endsAt = cfg.autoEndMinutes > 0 ? now + cfg.autoEndMinutes * 60_000 : null;
    await run(
      "INSERT INTO automodplus_raid (id, started_at, ends_at, prior_throttle, throttled, locked, reason) VALUES (1, ?, ?, NULL, 0, '[]', ?)",
      [now, endsAt, truncate(opts.reason, 200)],
    );
    const notes: string[] = [];

    const locked: Array<{ targetId: string; label: string }> = [];
    for (const channelId of cfg.lockChannels) {
      try {
        const { targetId, label } = await lockTargetOf(channelId);
        if (locked.some((l) => l.targetId === targetId) || (await get("SELECT 1 FROM locks WHERE target_id = ?", [targetId]))) continue;
        const everyone = WellKnownRootGuids.CommunityRoles.EveryoneRole;
        const prior = await existingRule(targetId, everyone);
        await run("INSERT INTO locks (target_id, original_overlay, created_at) VALUES (?, ?, ?)", [
          targetId,
          prior ? JSON.stringify(prior.overlay) : null,
          Date.now(),
        ]);
        try {
          await applyPatch(targetId, everyone, LOCK_PATCH, prior);
        } catch (err) {
          await run("DELETE FROM locks WHERE target_id = ?", [targetId]);
          throw err;
        }
        locked.push({ targetId, label });
        await run("UPDATE automodplus_raid SET locked = ? WHERE id = 1", [JSON.stringify(locked)]);
        await createCase({ action: "lock", userId: targetId, userName: label, moderatorId: opts.moderatorId, reason: "Raid mode" });
        await send(channelId, "🔒 This channel is locked while staff deal with a raid.").catch(() => undefined);
      } catch (err) {
        notes.push(`⚠️ Couldn't lock ${channelMention("channel", channelId)}: ${errMessage(err)}`);
      }
    }
    if (locked.length) notes.push(`🔒 Locked ${locked.length} channel(s) or group(s).`);

    if (cfg.throttle.enabled) {
      try {
        const c = await read("communities.get", () => rootServer.community.communities.get());
        await run("UPDATE automodplus_raid SET prior_throttle = ? WHERE id = 1", [JSON.stringify(c.joinThrottle ?? null)]);
        await setJoinThrottle({ refillCount: cfg.throttle.refillCount, windowInMinutes: cfg.throttle.windowMinutes });
        await run("UPDATE automodplus_raid SET throttled = 1 WHERE id = 1");
        notes.push(`🚦 Joins limited to ${cfg.throttle.refillCount} every ${cfg.throttle.windowMinutes} min.`);
      } catch (err) {
        notes.push(`⚠️ Couldn't set the join throttle: ${errMessage(err)}`);
      }
    }

    if (endsAt) {
      await scheduleOnce(RAID_KIND, 1, endsAt).catch((err) => log("warn", "scheduling raid end failed", { error: errMessage(err) }));
      notes.push(`⏱️ Raid mode ends automatically ${formatUtc(endsAt)}.`);
    }
    notifyChange(AREA.join);
    await modLogNotice(
      [`🚨 **Raid mode ON** · ${opts.reason}`, ...notes, `End it with \`raid off\` or on the Join protection page.`].join("\n"),
    );
    return notes;
  } finally {
    starting = false;
  }
}

export async function endRaid(opts: { moderatorId?: string; automatic?: boolean }): Promise<string[] | undefined> {
  const row = await get<RaidRow>("SELECT * FROM automodplus_raid WHERE id = 1");
  if (!row) return undefined;
  const notes: string[] = [];
  const everyone = WellKnownRootGuids.CommunityRoles.EveryoneRole;
  let unlocked = 0;
  for (const { targetId, label } of JSON.parse(row.locked) as Array<{ targetId: string; label: string }>) {
    // Someone may have already run !unlock on it.
    const lock = await get<{ original_overlay: string | null }>("SELECT original_overlay FROM locks WHERE target_id = ?", [targetId]);
    if (!lock) continue;
    try {
      await restorePatch(targetId, everyone, lock.original_overlay ? (JSON.parse(lock.original_overlay) as ChannelOverlayPermission) : null);
      await run("DELETE FROM locks WHERE target_id = ?", [targetId]);
      await createCase({ action: "unlock", userId: targetId, userName: label, moderatorId: opts.moderatorId, reason: "Raid over" });
      unlocked++;
    } catch (err) {
      notes.push(`⚠️ Couldn't unlock one channel: ${errMessage(err)}. Use \`unlock\` there.`);
    }
  }
  if (unlocked) notes.push(`🔓 Unlocked ${unlocked} channel(s) or group(s).`);
  if (row.throttled) {
    try {
      const prior = row.prior_throttle ? (JSON.parse(row.prior_throttle) as CommunityJoinThrottle | null) : null;
      await setJoinThrottle(prior ?? undefined);
      notes.push("🚦 Join throttle restored.");
    } catch (err) {
      notes.push(`⚠️ Couldn't restore the join throttle: ${errMessage(err)}. Check it in Root's community settings.`);
    }
  }
  await run("DELETE FROM automodplus_raid WHERE id = 1");
  await cancelJobs(RAID_KIND, 1).catch(() => undefined);
  joins.reset();
  notifyChange(AREA.join);
  await modLogNotice([`✅ **Raid mode OFF**${opts.automatic ? " (timed out)" : ""}`, ...notes].join("\n"));
  return notes;
}

// --- Join handling ------------------------------------------------------------

async function onJoin(userId: UserGuid): Promise<void> {
  if (RootGuidUtils.toRootGuidType(userId) !== RootGuidType.Person || isOwner(userId)) return;
  noteJoin(userId);
  if (await applyAutoban(userId).catch((err) => (log("warn", "autoban failed", { error: errMessage(err) }), false))) return;

  const cfg = plusConfig().raid;
  if (!cfg.enabled) return;
  const count = joins.record(Date.now(), cfg.seconds * 1000);
  if (count > cfg.joins && !starting && !(await raidStatus()).active) {
    await startRaid({ reason: `${count} joins in ${cfg.seconds}s` }).catch((err) => {
      if (!(err instanceof UsageError)) log("error", "starting raid mode failed", { error: errMessage(err) });
    });
  }
}

// --- Commands -----------------------------------------------------------------

function describeAutoban(): string {
  const a = plusConfig().autoban;
  return [
    `**Autoban is ${a.enabled ? "ON" : "OFF"}** · action: ${a.action} · reason: ${a.reason || "Autoban"}`,
    `**Names:** ${a.namePatterns.length ? a.namePatterns.map((p) => `\`${p}\``).join(", ") : "none"}`,
    `**Account age:** ${a.minAccountDays > 0 ? `younger than ${a.minAccountDays} day(s)` : "off"}`,
  ].join("\n");
}

async function describeRaid(): Promise<string> {
  const r = plusConfig().raid;
  const status = await raidStatus();
  return [
    status.active
      ? `🚨 **Raid mode is ON** since ${formatUtc(status.startedAt!)}${status.endsAt ? `, ends ${formatUtc(status.endsAt)}` : ""} · ${status.reason}`
      : "Raid mode is off.",
    `**Detection:** ${r.enabled ? "on" : "off"} · more than ${r.joins} joins in ${r.seconds}s`,
    `**Lock:** ${r.lockChannels.length ? r.lockChannels.map((id) => channelMention("channel", id)).join(", ") : "nothing"}`,
    `**Join throttle:** ${r.throttle.enabled ? `${r.throttle.refillCount} join(s) every ${r.throttle.windowMinutes} min` : "unchanged"}`,
    `**Ends:** ${r.autoEndMinutes > 0 ? `after ${formatDuration(r.autoEndMinutes * 60_000)}` : "only with raid off"}`,
  ].join("\n");
}

function int(value: string | undefined, range: readonly [number, number], name: string): number {
  const n = Number(value);
  const err = checkInt(n, range, name);
  if (err) throw new UsageError(err);
  return n;
}

function registerCommands(): void {
  register(
    {
      name: "autoban",
      category: "Auto-mod",
      level: Level.Admin,
      usage: "[on|off | name add|remove <pattern> | age <days|off> | action kick|ban | reason <text>]",
      description: "Kick or ban new members automatically by name or account age.",
      details: [
        "`autoban name add *free*nitro*` catches names containing free…nitro (* is a wildcard, case doesn't matter).",
        "`autoban age 3` removes accounts younger than 3 days. Root user IDs carry their creation time, so this is the account's age, not when they joined.",
        "Every autoban is a case in the mod log.",
      ],
      async run(ctx) {
        const sub = ctx.args.word();
        if (!sub) return ctx.reply(describeAutoban());
        if (sub === "on" || sub === "off") {
          await updatePlus(AREA.join, (p) => (p.autoban.enabled = sub === "on"));
        } else if (sub === "name") {
          const op = ctx.args.word();
          const pattern = ctx.args.rest().toLowerCase().trim();
          if ((op !== "add" && op !== "remove") || !pattern) throw new UsageError();
          const cleaned = cleanPatterns([pattern]);
          if (typeof cleaned === "string") throw new UsageError(cleaned);
          const current = plusConfig().autoban.namePatterns;
          if (op === "add" && current.length >= LIMITS.namePatterns) throw new UsageError(`At most ${LIMITS.namePatterns} patterns.`);
          await updatePlus(AREA.join, (p) => {
            const rest = p.autoban.namePatterns.filter((x) => x !== cleaned[0]);
            p.autoban.namePatterns = op === "add" ? [...rest, cleaned[0]] : rest;
          });
        } else if (sub === "age") {
          const value = ctx.args.word();
          const days = value === "off" ? 0 : int(value?.replace(/d$/, ""), LIMITS.accountDays, "Days");
          await updatePlus(AREA.join, (p) => (p.autoban.minAccountDays = days));
        } else if (sub === "action") {
          const action = ctx.args.word();
          if (action !== "kick" && action !== "ban") throw new UsageError("Say kick or ban.");
          await updatePlus(AREA.join, (p) => (p.autoban.action = action));
        } else if (sub === "reason") {
          const reason = ctx.args.rest();
          if (!reason || reason.length > 200) throw new UsageError("Give a reason of up to 200 characters.");
          await updatePlus(AREA.join, (p) => (p.autoban.reason = reason));
        } else throw new UsageError();
        await ctx.reply(`✅ Saved.\n${describeAutoban()}`);
      },
    },
    {
      name: "raid",
      category: "Auto-mod",
      level: Level.Moderator,
      usage: "[on [reason] | off | detect on|off | set <joins> <seconds> | lock add|remove #channel | throttle on|off [joins] [minutes] | autoend <minutes|off>]",
      description: "Raid protection: lock channels and slow joins when many members join at once.",
      details: [
        "`raid on` / `raid off` start and end raid mode by hand (moderators).",
        "Admins set it up: `raid detect on`, `raid set 10 10` (more than 10 joins in 10 seconds), `raid lock add #general`, `raid throttle on 1 5` (1 join every 5 minutes), `raid autoend 30`.",
      ],
      async run(ctx) {
        const sub = ctx.args.word();
        if (!sub) return ctx.reply(await describeRaid());
        if (sub === "on") {
          const notes = await startRaid({ reason: ctx.args.rest() || "Started by staff", moderatorId: ctx.authorId });
          return ctx.reply(["🚨 Raid mode is **on**.", ...notes].join("\n"));
        }
        if (sub === "off") {
          const notes = await endRaid({ moderatorId: ctx.authorId });
          if (!notes) return ctx.reply("Raid mode isn't on.");
          return ctx.reply(["✅ Raid mode is **off**.", ...notes].join("\n"));
        }
        if (ctx.level < Level.Admin) return ctx.reply("❌ Only admins can change raid settings.");
        if (sub === "detect") {
          const state = ctx.args.word();
          if (state !== "on" && state !== "off") throw new UsageError("Say on or off.");
          await updatePlus(AREA.join, (p) => (p.raid.enabled = state === "on"));
        } else if (sub === "set") {
          const count = int(ctx.args.word(), LIMITS.raidJoins, "Joins");
          const seconds = int(ctx.args.word(), LIMITS.raidSeconds, "Seconds");
          await updatePlus(AREA.join, (p) => Object.assign(p.raid, { joins: count, seconds }));
        } else if (sub === "lock") {
          const op = ctx.args.word();
          const channel = ctx.args.mention("channel");
          if ((op !== "add" && op !== "remove") || !channel?.id) throw new UsageError("Say `raid lock add #channel` or `raid lock remove #channel`.");
          if (op === "add" && plusConfig().raid.lockChannels.length >= LIMITS.lockChannels) throw new UsageError(`At most ${LIMITS.lockChannels} channels.`);
          await updatePlus(AREA.join, (p) => {
            const rest = p.raid.lockChannels.filter((id) => id !== channel.id);
            p.raid.lockChannels = op === "add" ? [...rest, channel.id!] : rest;
          });
        } else if (sub === "throttle") {
          const state = ctx.args.word();
          if (state !== "on" && state !== "off") throw new UsageError("Say on or off.");
          const a = ctx.args.word();
          const b = ctx.args.word();
          const current = plusConfig().raid.throttle;
          const refillCount = a ? int(a, LIMITS.throttleCount, "Joins") : current.refillCount;
          const windowMinutes = b ? int(b, LIMITS.throttleWindow, "Minutes") : current.windowMinutes;
          await updatePlus(AREA.join, (p) => (p.raid.throttle = { enabled: state === "on", refillCount, windowMinutes }));
        } else if (sub === "autoend") {
          const value = ctx.args.word();
          const minutes = value === "off" ? 0 : int(value, LIMITS.autoEndMinutes, "Minutes");
          await updatePlus(AREA.join, (p) => (p.raid.autoEndMinutes = minutes));
        } else throw new UsageError();
        await ctx.reply(`✅ Saved.\n${await describeRaid()}`);
      },
    },
  );
}

// --- Setup --------------------------------------------------------------------

export async function initJoinProtection(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS automodplus_raid (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at INTEGER NOT NULL,
    ends_at INTEGER,
    prior_throttle TEXT,
    throttled INTEGER NOT NULL DEFAULT 0,
    locked TEXT NOT NULL DEFAULT '[]',
    reason TEXT NOT NULL DEFAULT ''
  )`);

  rootServer.community.communities.on(CommunityEvent.CommunityJoined, (evt) => {
    onJoin(evt.userId).catch((err) => log("error", "join protection failed", { error: errMessage(err) }));
  });
  onJob(RAID_KIND, async () => {
    await endRaid({ automatic: true });
  });
  onReconcile(async () => {
    const row = await get<RaidRow>("SELECT ends_at FROM automodplus_raid WHERE id = 1");
    if (!row?.ends_at) return;
    if (row.ends_at < Date.now()) await endRaid({ automatic: true });
    // A lost job would otherwise leave channels locked until the next daily sweep.
    else if (!(await hasJob(RAID_KIND, 1))) await scheduleOnce(RAID_KIND, 1, row.ends_at);
  });

  registerCommands();
}
