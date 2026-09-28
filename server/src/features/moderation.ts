import {
  rootServer,
  ChannelGuid,
  ChannelMessage,
  ErrorCodeType,
  MessageDirectionTake,
  MessageType,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-app";
import { all, get, run } from "../db";
import { CommandContext, register, UsageError } from "../commands/registry";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../jobs";
import { errorCode, read } from "../lib/api";
import { log, errMessage } from "../lib/log";
import { applyPatch, existingRule, LOCK_PATCH, restorePatch } from "../lib/overlays";
import { formatDuration, formatUtc, parseDuration } from "../lib/time";
import { channelMention, truncate, userMention } from "../lib/text";
import { nicknameOf } from "../members";
import { deleteMessage, send, sendEphemeral } from "../messaging";
import {
  activeWarnings,
  casesFor,
  clearWarnings,
  createCase,
  formatCase,
  formatCaseLine,
  getCase,
  updateReason,
  voidWarning,
} from "../modlog";
import { canActOn, Level } from "../permissions";
import { setSetting, settings } from "../settings";
import {
  ActionRefused,
  banMember,
  deleteWarnAction,
  kickMember,
  listWarnActions,
  MAX_BAN_REASON,
  muteAction,
  setWarnAction,
  unbanMember,
  unmuteAction,
  warnMember,
} from "./modActions";

/** The target member: a mention, or a raw user ID for people not in the community. */
function takeUser(ctx: CommandContext, required = true): UserGuid | undefined {
  const mention = ctx.args.mention("user");
  if (mention?.id) return mention.id as UserGuid;
  const next = ctx.args.peek();
  if (next?.kind === "word" && isUserId(next.text)) {
    ctx.args.next();
    return next.text as UserGuid;
  }
  if (required) throw new UsageError("Mention the member first.");
  return undefined;
}

function isUserId(text: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(text) === RootGuidType.Person;
  } catch {
    return false;
  }
}

/** Consumes an optional leading duration ("10m", "1d"). */
function takeDuration(ctx: CommandContext): number | undefined {
  const next = ctx.args.peek();
  if (next?.kind !== "word") return undefined;
  const ms = parseDuration(next.text);
  if (ms !== undefined) ctx.args.next();
  return ms;
}

async function checkTarget(ctx: CommandContext, target: UserGuid): Promise<boolean> {
  const problem = await canActOn(ctx.authorId, target);
  if (problem) await ctx.reply(`❌ ${problem}`);
  return !problem;
}

async function mentionFor(userId: UserGuid): Promise<string> {
  return userMention(await nicknameOf(userId), userId);
}

/** Runs a shared action; a rank refusal becomes the usual ❌ reply. */
async function refusable<T>(ctx: CommandContext, op: () => Promise<T>): Promise<T | undefined> {
  try {
    return await op();
  } catch (err) {
    if (!(err instanceof ActionRefused)) throw err;
    await ctx.reply(`❌ ${err.message}`);
    return undefined;
  }
}

// --- Purge -------------------------------------------------------------------

type PurgeFilter = { kind: "all" } | { kind: "user"; userId: string } | { kind: "bots" } | { kind: "links" };

function purgeMatches(msg: ChannelMessage, filter: PurgeFilter): boolean {
  if (msg.messageType === MessageType.System || msg.pinnedAt) return false;
  switch (filter.kind) {
    case "all":
      return true;
    case "user":
      return msg.userId === filter.userId;
    case "bots":
      return RootGuidUtils.toRootGuidType(msg.userId) === RootGuidType.App;
    case "links":
      return msg.messageUris.some((u) => /^https?:\/\//i.test(u.uri));
  }
}

const PURGE_MAX = 200;
const PURGE_SCAN_LIMIT = 1000;

async function purge(channelId: string, before: Date, count: number, filter: PurgeFilter): Promise<number> {
  const toDelete: ChannelMessage[] = [];
  let dateAt = before;
  let scanned = 0;
  while (toDelete.length < count && scanned < PURGE_SCAN_LIMIT) {
    const page = await read("channelMessages.list", () =>
      rootServer.community.channelMessages.list({
        channelId: channelId as ChannelGuid,
        dateAt,
        messageDirectionTake: MessageDirectionTake.Older,
        limit: 50,
      }),
    );
    if (page.messages.length === 0) break;
    scanned += page.messages.length;
    // Pages come oldest first; walk newest first so "purge 10" takes the latest 10.
    for (const msg of [...page.messages].reverse()) {
      if (toDelete.length >= count) break;
      if (purgeMatches(msg, filter)) toDelete.push(msg);
    }
    if (page.oldCount === 0) break;
    dateAt = new Date(RootGuidUtils.toMilliseconds(page.messages[0].id));
  }

  let deleted = 0;
  for (const msg of toDelete) {
    try {
      await deleteMessage(channelId, msg.id);
      deleted++;
    } catch {
      // Already gone or not deletable: keep going.
    }
  }
  return deleted;
}

// --- Locks -------------------------------------------------------------------

/** Rules on a channel that inherits its group's permissions are ignored, so the group is locked. */
async function lockTarget(channelId: string): Promise<{ targetId: string; label: string; isGroup: boolean }> {
  const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
  if (!channel.useChannelGroupPermission) {
    return { targetId: channel.id, label: channelMention(channel.name, channel.id), isGroup: false };
  }
  const group = await read("channelGroups.get", () =>
    rootServer.community.channelGroups.get({ id: channel.channelGroupId }),
  );
  return { targetId: group.id, label: `the **${group.name}** channel group`, isGroup: true };
}

/** Lifts a Taproot lock. Undefined if the channel (or its group) isn't locked by Taproot. */
async function unlockChannel(channelId: string, moderatorId?: string, reason?: string): Promise<{ label: string } | undefined> {
  const { targetId, label } = await lockTarget(channelId);
  const lock = await get<{ original_overlay: string | null }>("SELECT original_overlay FROM locks WHERE target_id = ?", [targetId]);
  if (!lock) return undefined;
  await restorePatch(
    targetId,
    WellKnownRootGuids.CommunityRoles.EveryoneRole,
    lock.original_overlay ? JSON.parse(lock.original_overlay) : null,
  );
  await run("DELETE FROM locks WHERE target_id = ?", [targetId]);
  await clearLockTimer(targetId);
  await createCase({ action: "unlock", userId: targetId, userName: label, moderatorId, reason });
  await send(channelId, "🔓 This channel has been unlocked.");
  return { label };
}

// Timed locks ("lock #channel 1h"): a timer row per locked target, and a job
// that unlocks it. Reconcile catches up on any that came due while offline.

const UNLOCK_JOB = "modtoolsUnlock";
const MAX_LOCK = 365 * 86_400_000;

interface LockTimer {
  id: number;
  target_id: string;
  channel_id: string;
  expires_at: number;
}

async function setLockTimer(targetId: string, channelId: string, expiresAt: number): Promise<void> {
  await clearLockTimer(targetId);
  const { lastID } = await run("INSERT INTO modtools_lock_timers (target_id, channel_id, expires_at) VALUES (?, ?, ?)", [
    targetId,
    channelId,
    expiresAt,
  ]);
  await scheduleOnce(UNLOCK_JOB, lastID, expiresAt);
}

async function clearLockTimer(targetId: string): Promise<void> {
  const timer = await get<LockTimer>("SELECT * FROM modtools_lock_timers WHERE target_id = ?", [targetId]);
  if (!timer) return;
  await run("DELETE FROM modtools_lock_timers WHERE id = ?", [timer.id]);
  await cancelJobs(UNLOCK_JOB, timer.id).catch(() => undefined);
}

async function expireLock(id: number): Promise<void> {
  const timer = await get<LockTimer>("SELECT * FROM modtools_lock_timers WHERE id = ?", [id]);
  if (!timer || timer.expires_at > Date.now() + 60_000) return;
  let done: { label: string } | undefined;
  try {
    done = await unlockChannel(timer.channel_id, undefined, "Lock expired");
  } catch (err) {
    // A deleted channel can't be unlocked; anything else, reconcile retries.
    if (errorCode(err) !== ErrorCodeType.NotFound) throw err;
  }
  // Already unlocked some other way (or gone): just forget the timer.
  if (!done) await run("DELETE FROM modtools_lock_timers WHERE id = ?", [id]);
}

async function reconcileLocks(): Promise<void> {
  for (const timer of await all<LockTimer>("SELECT * FROM modtools_lock_timers")) {
    if (timer.expires_at <= Date.now()) await expireLock(timer.id);
    else if (!(await hasJob(UNLOCK_JOB, timer.id))) await scheduleOnce(UNLOCK_JOB, timer.id, timer.expires_at);
  }
}

async function initLockTimers(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS modtools_lock_timers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL UNIQUE,
    channel_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
}

// --- Commands ----------------------------------------------------------------

export function registerModeration(): void {
  initLockTimers().catch((err) => log("error", "lock timer table failed", { error: errMessage(err) }));
  onJob(UNLOCK_JOB, expireLock);
  onReconcile(reconcileLocks);
  register(
    {
      name: "warn",
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member <reason>",
      description: "Warn a member. Warnings count toward automatic punishments (see warnpunish).",
      async run(ctx) {
        const target = takeUser(ctx)!;
        const reason = ctx.args.rest();
        if (!reason) throw new UsageError("Give a reason for the warning.");
        const result = await refusable(ctx, () => warnMember({ actorId: ctx.authorId, userId: target, reason }));
        if (!result) return;
        const lines = [
          `⚠️ ${await mentionFor(target)} has been warned (case #${result.modCase.id}, warning ${result.count}): ${reason}`,
          ...result.notes,
        ];
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "warnings",
      aliases: ["warns"],
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member",
      description: "List a member's active warnings.",
      async run(ctx) {
        const target = takeUser(ctx)!;
        const warns = await activeWarnings(target);
        const name = await nicknameOf(target);
        if (warns.length === 0) return ctx.reply(`✅ **${name}** has no active warnings.`);
        await ctx.reply([`**${name}** has ${warns.length} active warning(s):`, ...warns.map(formatCaseLine)].join("\n"));
      },
    },
    {
      name: "delwarn",
      category: "Moderation",
      level: Level.Moderator,
      usage: "<case number>",
      description: "Void a warning so it no longer counts.",
      async run(ctx) {
        const id = Number(ctx.args.word());
        const c = Number.isInteger(id) ? await voidWarning(id) : undefined;
        if (!c) return ctx.reply("❌ That case isn't a warning.");
        await ctx.reply(`🗑️ Warning #${id} for **${c.user_name}** voided.`);
      },
    },
    {
      name: "clearwarns",
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member",
      description: "Void all of a member's warnings.",
      async run(ctx) {
        const target = takeUser(ctx)!;
        if (!(await checkTarget(ctx, target))) return;
        const changes = await clearWarnings(target);
        await ctx.reply(`🗑️ Cleared ${changes} warning(s) for **${await nicknameOf(target)}**.`);
      },
    },
    {
      name: "warnpunish",
      category: "Moderation",
      level: Level.Admin,
      usage: "[<count> <mute|kick|ban|none> [duration]]",
      description: "Set what happens automatically when a member reaches a number of warnings.",
      details: ["`warnpunish 3 mute 1h` · `warnpunish 5 kick` · `warnpunish 7 ban 7d` · `warnpunish 3 none` removes it."],
      async run(ctx) {
        if (ctx.args.remaining === 0) {
          const rules = await listWarnActions();
          if (rules.length === 0) return ctx.reply("No warning punishments set.");
          return ctx.reply(
            rules
              .map((r) => `**${r.warn_count} warnings** → ${r.action}${r.duration_ms ? ` for ${formatDuration(r.duration_ms)}` : ""}`)
              .join("\n"),
          );
        }
        const count = Number(ctx.args.word());
        const action = ctx.args.word();
        if (!Number.isInteger(count) || count < 1) throw new UsageError("Count must be a whole number.");
        if (action === "none") {
          await deleteWarnAction(count);
          return ctx.reply(`✅ Removed the punishment at ${count} warnings.`);
        }
        if (action !== "mute" && action !== "kick" && action !== "ban") throw new UsageError("Action must be mute, kick, ban or none.");
        const duration = takeDuration(ctx);
        await setWarnAction(count, action, duration);
        await ctx.reply(`✅ At ${count} warnings: ${action}${duration && action !== "kick" ? ` for ${formatDuration(duration)}` : ""}.`);
      },
    },
    {
      name: "mute",
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member [duration] [reason]",
      description: "Stop a member posting, reacting and talking. Without a duration it lasts until unmute.",
      details: ["Durations look like `10m`, `2h`, `1d`, `1w`.", "Staff whose roles have Full Control can't be muted."],
      async run(ctx) {
        const target = takeUser(ctx)!;
        const duration = takeDuration(ctx);
        const reason = ctx.args.rest();
        const result = await refusable(ctx, () =>
          muteAction({ actorId: ctx.authorId, userId: target, durationMs: duration, reason }),
        );
        if (!result) return;
        const length = duration ? ` for ${formatDuration(duration)}` : "";
        const lines = [
          `🔇 ${await mentionFor(target)} ${result.extended ? "mute updated" : "muted"}${length} (case #${result.modCase.id}).`,
          ...result.notes,
        ];
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "unmute",
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member [reason]",
      description: "Lift a mute.",
      async run(ctx) {
        const target = takeUser(ctx)!;
        const result = await unmuteAction({ actorId: ctx.authorId, userId: target, reason: ctx.args.rest() });
        if (!result) return ctx.reply("That member isn't muted.");
        const warn = result.notes.map((n) => `\n${n}`).join("");
        await ctx.reply(`🔊 ${await mentionFor(target)} unmuted (case #${result.modCase.id}).${warn}`);
      },
    },
    {
      name: "kick",
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member [reason]",
      description: "Remove a member. They can rejoin with an invite.",
      async run(ctx) {
        const target = takeUser(ctx)!;
        const reason = ctx.args.rest();
        const result = await refusable(ctx, () => kickMember({ actorId: ctx.authorId, userId: target, reason }));
        if (!result) return;
        await ctx.reply(`👢 **${result.name}** was kicked (case #${result.modCase.id}).`);
      },
    },
    {
      name: "ban",
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member [duration] [reason]",
      description: "Ban a member. With a duration, Root lifts the ban automatically.",
      details: ["`ban @member 7d spamming` bans for a week. The reason is shown to the member (max 256 characters)."],
      async run(ctx) {
        const target = takeUser(ctx)!;
        const duration = takeDuration(ctx);
        const reason = ctx.args.rest();
        if (reason.length > MAX_BAN_REASON) throw new UsageError(`Ban reasons can be at most ${MAX_BAN_REASON} characters.`);
        const result = await refusable(ctx, () =>
          banMember({ actorId: ctx.authorId, userId: target, durationMs: duration, reason }),
        );
        if (!result) return;
        await ctx.reply(
          `🔨 **${result.name}** was banned${duration ? ` for ${formatDuration(duration)}` : ""} (case #${result.modCase.id}).`,
        );
      },
    },
    {
      name: "unban",
      category: "Moderation",
      level: Level.Moderator,
      usage: "<user ID> [reason]",
      description: "Lift a ban. The member needs a new invite to rejoin. Use `bans` to find IDs.",
      async run(ctx) {
        const target = takeUser(ctx)!;
        const result = await unbanMember({ actorId: ctx.authorId, userId: target, reason: ctx.args.rest() });
        await ctx.reply(`🕊️ **${result.name}** was unbanned (case #${result.modCase.id}).`);
      },
    },
    {
      name: "bans",
      category: "Moderation",
      level: Level.Moderator,
      usage: "",
      description: "List active bans with their user IDs.",
      async run(ctx) {
        const bans = await read("communityMemberBans.list", () => rootServer.community.communityMemberBans.list());
        if (bans.length === 0) return ctx.reply("No active bans.");
        const lines = await Promise.all(
          bans.slice(0, 40).map(async (b) => {
            const name = await nicknameOf(b.userId);
            const until = b.expiresAt ? ` · until ${new Date(b.expiresAt).toISOString().slice(0, 10)}` : "";
            return `**${name}** \`${b.userId}\`${until}${b.reason ? ` · ${truncate(b.reason, 60)}` : ""}`;
          }),
        );
        const more = bans.length > 40 ? `\n…and ${bans.length - 40} more.` : "";
        await ctx.reply(`**Active bans (${bans.length})**\n${lines.join("\n")}${more}`);
      },
    },
    {
      name: "purge",
      aliases: ["clean", "prune"],
      category: "Moderation",
      level: Level.Moderator,
      usage: "<1-200> [@member | bots | links]",
      description: "Bulk delete recent messages in this channel. Pinned messages are kept.",
      details: ["Root deletes one message at a time (about 5 per second), so large purges take a moment."],
      async run(ctx) {
        const count = Number(ctx.args.word());
        if (!Number.isInteger(count) || count < 1 || count > PURGE_MAX) throw new UsageError(`Pick a number from 1 to ${PURGE_MAX}.`);
        let filter: PurgeFilter = { kind: "all" };
        const user = ctx.args.mention("user");
        const word = user ? undefined : ctx.args.word();
        if (user?.id) filter = { kind: "user", userId: user.id };
        else if (word === "bots") filter = { kind: "bots" };
        else if (word === "links") filter = { kind: "links" };
        else if (word) throw new UsageError("Filter must be a member mention, bots or links.");

        const before = new Date(RootGuidUtils.toMilliseconds(ctx.messageId));
        await deleteMessage(ctx.channelId, ctx.messageId).catch(() => undefined);
        const deleted = await purge(ctx.channelId, before, count, filter);
        sendEphemeral(ctx.channelId, `🧹 Deleted ${deleted} message(s).`);
        const channel = await read("channels.get", () => rootServer.community.channels.get({ id: ctx.channelId as ChannelGuid }));
        await createCase({
          action: "purge",
          userId: ctx.channelId,
          userName: channelMention(channel.name, channel.id),
          moderatorId: ctx.authorId,
          reason: `${deleted} message(s)${filter.kind === "all" ? "" : ` (${filter.kind === "user" ? user?.text : filter.kind})`}`,
        });
      },
    },
    {
      name: "lock",
      category: "Moderation",
      level: Level.Moderator,
      usage: "[#channel] [duration] [reason]",
      description: "Stop @everyone posting in a channel (this one by default). With a duration it unlocks itself.",
      details: [
        "`lock #general 1h raid` locks for an hour. Locking an already locked channel with a duration changes when it unlocks.",
        "If the channel shares its group's permissions, the whole group is locked.",
        "Staff roles keep posting only if they have Full Control or their own allow rule on the channel.",
      ],
      async run(ctx) {
        const channelId = ctx.args.mention("channel")?.id ?? ctx.channelId;
        const duration = takeDuration(ctx);
        if (duration !== undefined && duration > MAX_LOCK) throw new UsageError("Locks can last at most a year.");
        const reason = ctx.args.rest();
        const { targetId, label, isGroup } = await lockTarget(channelId);
        const expiresAt = duration ? Date.now() + duration : undefined;
        if (await get("SELECT 1 FROM locks WHERE target_id = ?", [targetId])) {
          if (!expiresAt) return ctx.reply(`${label} is already locked.`);
          await setLockTimer(targetId, channelId, expiresAt);
          return ctx.reply(`🔒 ${label} is already locked; it now unlocks in ${formatDuration(duration!)} (${formatUtc(expiresAt)}).`);
        }
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
        if (expiresAt) await setLockTimer(targetId, channelId, expiresAt);
        await createCase({ action: "lock", userId: targetId, userName: label, moderatorId: ctx.authorId, reason, durationMs: duration });
        const length = duration ? ` for ${formatDuration(duration)}` : "";
        await send(
          channelId,
          `🔒 This ${isGroup ? "channel group" : "channel"} has been locked by staff${length}.${reason ? ` Reason: ${reason}` : ""}`,
        );
        if (channelId !== ctx.channelId) await ctx.reply(`🔒 Locked ${label}${length}.`);
      },
    },
    {
      name: "unlock",
      category: "Moderation",
      level: Level.Moderator,
      usage: "[#channel]",
      description: "Undo a lock.",
      async run(ctx) {
        const channelId = ctx.args.mention("channel")?.id ?? ctx.channelId;
        const done = await unlockChannel(channelId, ctx.authorId);
        if (!done) return ctx.reply(`${(await lockTarget(channelId)).label} isn't locked by Taproot.`);
        if (channelId !== ctx.channelId) await ctx.reply(`🔓 Unlocked ${done.label}.`);
      },
    },
    {
      name: "modlogs",
      aliases: ["history"],
      category: "Moderation",
      level: Level.Moderator,
      usage: "@member",
      description: "Show a member's moderation history.",
      async run(ctx) {
        const target = takeUser(ctx)!;
        const cases = await casesFor(target, 20);
        const name = await nicknameOf(target);
        if (cases.length === 0) return ctx.reply(`**${name}** has a clean record. 🌱`);
        await ctx.reply([`**Moderation history for ${name}** (latest ${cases.length})`, ...cases.map(formatCaseLine)].join("\n"));
      },
    },
    {
      name: "case",
      category: "Moderation",
      level: Level.Moderator,
      usage: "<case number>",
      description: "Show one case in full.",
      async run(ctx) {
        const id = Number(ctx.args.word());
        const c = Number.isInteger(id) ? await getCase(id) : undefined;
        await ctx.reply(c ? formatCase(c) : "❌ No case with that number.");
      },
    },
    {
      name: "reason",
      category: "Moderation",
      level: Level.Moderator,
      usage: "<case number> <new reason>",
      description: "Change the reason on a case.",
      async run(ctx) {
        const id = Number(ctx.args.word());
        const reason = ctx.args.rest();
        if (!Number.isInteger(id) || !reason) throw new UsageError();
        await ctx.reply((await updateReason(id, reason)) ? `✅ Case #${id} updated.` : "❌ No case with that number.");
      },
    },
    {
      name: "modlog",
      category: "Moderation",
      level: Level.Admin,
      usage: "<#channel | off>",
      description: "Choose the channel where every moderation action is logged.",
      details: ["Make it a private staff channel; logs include member IDs and reasons."],
      async run(ctx) {
        const channel = ctx.args.mention("channel");
        if (channel?.id) {
          await setSetting("modLogChannel", channel.id);
          await send(channel.id, "📋 Taproot will log moderation actions here.");
          return ctx.reply(`✅ Mod log set to ${channelMention(channel.text.replace(/^#/, ""), channel.id)}.`);
        }
        if (ctx.args.word() === "off") {
          await setSetting("modLogChannel", null);
          return ctx.reply("✅ Mod log turned off.");
        }
        const current = settings().modLogChannel;
        await ctx.reply(current ? `Mod log channel: ${channelMention("mod-log", current)}` : "No mod log channel set.");
      },
    },
  );
}
