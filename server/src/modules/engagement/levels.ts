import {
  rootServer,
  ChannelMessageCreatedEvent,
  CommunityRoleGuid,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { CommandContext, register, UsageError } from "../../commands/registry";
import { describeError, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { fillTemplate, roleMention, userMention } from "../../lib/text";
import { send } from "../../messaging";
import { modLogNotice } from "../../modlog";
import { forgetMember, isPrivileged, Level, listRoles, memberRoleIds } from "../../permissions";
import {
  AdjustOp,
  LevelReward,
  MAX_LEVEL,
  MAX_REWARDS,
  levelFromXp,
  pageCount,
  parseAmount,
  progressBar,
  progressFromXp,
  rewardChanges,
  rollXp,
} from "./logic";
import { AREA, config, displayName, notifySoon, saveConfig } from "./runtime";
import * as store from "./store";

// Levels: members earn XP for chatting (once per cooldown), level up on the
// 5L² + 50L + 100 curve, get announced and receive reward roles.

export const PAGE_SIZE = 10;

// In-memory copy of each member's last XP time, so most messages inside the
// cooldown are skipped without a database write. The database stays the
// source of truth (awardXp re-checks the cooldown atomically).
const lastXpAt = new Map<string, number>();

function isBot(userId: string): boolean {
  return RootGuidUtils.toRootGuidType(userId as UserGuid) === RootGuidType.App;
}

export async function onMessageForXp(evt: ChannelMessageCreatedEvent, wasCommand: boolean): Promise<void> {
  const cfg = config().levels;
  if (!cfg.enabled || wasCommand || isBot(evt.userId)) return;
  if (cfg.noXpChannels.includes(evt.channelId)) return;

  const now = Date.now();
  const cooldownMs = cfg.cooldownSeconds * 1000;
  const last = lastXpAt.get(evt.userId);
  if (last !== undefined && now - last < cooldownMs) return;
  if (lastXpAt.size > 10_000) lastXpAt.clear();
  lastXpAt.set(evt.userId, now);

  const roleIds = await memberRoleIds(evt.userId);
  if (roleIds.some((id) => cfg.noXpRoles.includes(id))) return;

  const gain = rollXp(cfg, roleIds);
  const after = await store.awardXp(evt.userId, gain, now, cooldownMs);
  if (after === undefined) return;
  notifySoon(AREA.xp);

  const before = levelFromXp(Math.max(0, after - gain));
  const level = levelFromXp(after);
  if (level > before) await onLevelUp(evt.userId, level, evt.channelId, roleIds);
}

async function onLevelUp(userId: UserGuid, level: number, channelId: string, roleIds: string[]): Promise<void> {
  const cfg = config().levels;
  const gained = await syncRewards(userId, level, roleIds);
  if (cfg.announce === "off") return;
  const target = cfg.announce === "channel" ? cfg.announceChannel : channelId;
  if (!target) return;
  const name = await displayName(userId);
  let text = fillTemplate(cfg.announceMessage, {
    user: userMention(name, userId),
    "user.name": name,
    level: String(level),
  });
  if (gained.length) text += `\n🎁 New role${gained.length > 1 ? "s" : ""}: ${gained.map((r) => `**${r}**`).join(", ")}`;
  await send(target, text).catch((err) => log("warn", "level-up announcement failed", { error: errMessage(err) }));
}

/**
 * Gives and removes reward roles so they match `level`. Roles that were
 * deleted or have since gained staff permissions are skipped. Failures go to
 * the mod log rather than failing the caller. Returns names of roles given.
 */
export async function syncRewards(userId: UserGuid, level: number, currentRoleIds?: string[]): Promise<string[]> {
  const cfg = config().levels;
  if (cfg.rewards.length === 0) return [];
  if (!currentRoleIds) forgetMember(userId);
  const current = currentRoleIds ?? (await memberRoleIds(userId));
  const { add, remove } = rewardChanges(cfg.rewards, level, cfg.rewardMode, current);
  if (add.length === 0 && remove.length === 0) return [];
  const roles = await listRoles();
  const given: string[] = [];
  const change = async (roleId: string, adding: boolean) => {
    const role = roles.find((r) => r.id === roleId);
    if (!role || (adding && isPrivileged(role))) return;
    const req = { communityRoleId: roleId as CommunityRoleGuid, userIds: [userId] };
    try {
      if (adding) await write("communityMemberRoles.add", () => rootServer.community.communityMemberRoles.add(req));
      else await write("communityMemberRoles.remove", () => rootServer.community.communityMemberRoles.remove(req));
      if (adding) given.push(role.name);
    } catch (err) {
      log("warn", "level reward role change failed", { error: errMessage(err) });
      await modLogNotice(
        `⚠️ Level reward ${roleMention(role.name, role.id)} couldn't be ${adding ? "given to" : "removed from"} **${await displayName(userId)}**: ${describeError(err)}`,
      ).catch(() => undefined);
    }
  };
  for (const id of add) await change(id, true);
  for (const id of remove) await change(id, false);
  forgetMember(userId);
  return given;
}

/** Applies an admin XP change and brings reward roles in line. Returns [before, after]. */
export async function adjustXp(userId: UserGuid, op: AdjustOp, amount: number): Promise<[number, number]> {
  const result = await store.adjustXp(userId, op, amount);
  notifySoon(AREA.xp);
  if (levelFromXp(result[0]) !== levelFromXp(result[1])) {
    await syncRewards(userId, levelFromXp(result[1])).catch((err) => log("warn", "reward sync failed", { error: errMessage(err) }));
  }
  return result;
}

// --- Commands ----------------------------------------------------------------

function disabledNotice(ctx: CommandContext): string {
  return ctx.level >= Level.Admin
    ? "📴 Levels are off. Turn them on in the Taproot channel under **Settings › Levels**."
    : "📴 Levels aren't turned on in this community.";
}

/** Reads an optional page number argument. */
function pageArg(ctx: CommandContext): number {
  const word = ctx.args.word();
  const page = word ? Number(word) : 1;
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export function rewardLine(r: LevelReward, roleName: string | undefined): string {
  return `Level **${r.level}** → ${roleName ? `**${roleName}**` : "*deleted role*"}`;
}

export function registerLevelCommands(): void {
  register(
    {
      name: "rank",
      category: "Levels",
      level: Level.Member,
      usage: "[@member]",
      description: "Show your level, XP and rank (or another member's).",
      async run(ctx) {
        if (!config().levels.enabled) return ctx.reply(disabledNotice(ctx));
        const mention = ctx.args.mention("user");
        const userId = (mention?.id ?? ctx.authorId) as UserGuid;
        const xp = await store.xpOf(userId);
        const p = progressFromXp(xp);
        const rank = await store.xpRank(xp);
        const name = await displayName(userId);
        await ctx.reply(
          [
            `🏅 **${name}** · Level **${p.level}** · ${rank ? `Rank **#${rank}**` : "Unranked"}`,
            `${progressBar(p.into, p.needed)} ${p.into.toLocaleString("en-US")} / ${p.needed.toLocaleString("en-US")} XP to level ${p.level + 1}`,
            `Total: ${xp.toLocaleString("en-US")} XP`,
          ].join("\n"),
        );
      },
    },
    {
      name: "levels",
      category: "Levels",
      level: Level.Member,
      usage: "[page]",
      description: "The XP leaderboard, 10 members per page.",
      async run(ctx) {
        if (!config().levels.enabled) return ctx.reply(disabledNotice(ctx));
        const page = pageArg(ctx);
        const { total, rows } = await store.xpBoard((page - 1) * PAGE_SIZE, PAGE_SIZE);
        const pages = pageCount(total, PAGE_SIZE);
        if (rows.length === 0) return ctx.reply(total ? `There are only ${pages} page(s).` : "Nobody has earned XP yet.");
        const lines = await Promise.all(
          rows.map(async (r, i) => {
            const pos = (page - 1) * PAGE_SIZE + i + 1;
            const medal = ["🥇", "🥈", "🥉"][pos - 1] ?? `**${pos}.**`;
            return `${medal} ${await displayName(r.user_id)} · Level ${levelFromXp(r.xp)} · ${r.xp.toLocaleString("en-US")} XP`;
          }),
        );
        const footer = pages > 1 ? `\n*Page ${page} of ${pages}. \`${ctx.prefix}levels ${Math.min(page + 1, pages)}\` for more.*` : "";
        await ctx.reply(`🏆 **Levels leaderboard**\n${lines.join("\n")}${footer}`);
      },
    },
    {
      name: "xp",
      category: "Levels",
      level: Level.Admin,
      usage: "<give|take|set> @member <amount> | reset <@member|all>",
      description: "Change a member's XP. Reward roles follow the new level.",
      details: ["`xp reset all` clears everyone's XP (reward roles already given stay)."],
      async run(ctx) {
        const op = ctx.args.word() as AdjustOp | undefined;
        if (!op || !["give", "take", "set", "reset"].includes(op)) throw new UsageError();
        if (op === "reset" && ctx.args.peek()?.text.toLowerCase() === "all") {
          const n = await store.resetAllXp();
          notifySoon(AREA.xp);
          return ctx.reply(`🧹 Cleared XP for ${n} member(s).`);
        }
        const mention = ctx.args.mention("user");
        if (!mention?.id) throw new UsageError("Mention the member.");
        let amount = 0;
        if (op !== "reset") {
          const text = ctx.args.word();
          const parsed = op === "set" && text === "0" ? 0 : parseAmount(text);
          if (parsed === undefined) throw new UsageError("Give a whole number from 1 to 1,000,000,000.");
          amount = parsed;
        }
        const userId = mention.id as UserGuid;
        if (isBot(userId)) return ctx.reply("❌ Bots don't earn XP.");
        const [before, after] = await adjustXp(userId, op, amount);
        const name = await displayName(userId);
        await ctx.reply(
          `✅ **${name}**: ${before.toLocaleString("en-US")} → **${after.toLocaleString("en-US")} XP** (level ${levelFromXp(before)} → ${levelFromXp(after)}).`,
        );
      },
    },
    {
      name: "levelrewards",
      category: "Levels",
      level: Level.Member,
      usage: "[add <level> @role | remove <level> [@role]]",
      description: "List the roles members earn by levelling up. Admins can add or remove them.",
      details: ["Rewards either stack or keep only the highest, set on the Levels settings page."],
      async run(ctx) {
        const action = ctx.args.word();
        const cfg = config();
        const roles = await listRoles();
        if (!action || action === "list") {
          if (cfg.levels.rewards.length === 0) return ctx.reply("No level rewards yet.");
          const lines = cfg.levels.rewards.map((r) => rewardLine(r, roles.find((x) => x.id === r.roleId)?.name));
          const mode = cfg.levels.rewardMode === "stack" ? "Rewards stack." : "Only the highest reward is kept.";
          return ctx.reply(`🎁 **Level rewards**\n${lines.join("\n")}\n*${mode}*`);
        }
        if (ctx.level < Level.Admin) return ctx.reply("🔒 Only admins can change level rewards.");
        const level = Number(ctx.args.word());
        if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL) throw new UsageError(`Levels are 1 to ${MAX_LEVEL}.`);
        const mention = ctx.args.mention("role");
        const role = mention?.id ? roles.find((r) => r.id === mention.id) : undefined;
        if (action === "add") {
          if (!role) throw new UsageError("Mention the role after the level.");
          if (isPrivileged(role)) return ctx.reply("❌ That role has staff permissions, so it can't be a reward.");
          if (cfg.levels.rewards.some((r) => r.level === level && r.roleId === role.id)) return ctx.reply("That reward already exists.");
          if (cfg.levels.rewards.length >= MAX_REWARDS) return ctx.reply(`❌ Up to ${MAX_REWARDS} rewards.`);
          const rewards = [...cfg.levels.rewards, { level, roleId: role.id }].sort((a, b) => a.level - b.level);
          await saveConfig({ ...cfg, levels: { ...cfg.levels, rewards } });
          return ctx.reply(`✅ Members reaching level **${level}** get **${role.name}**. Existing members get it on their next level-up.`);
        }
        if (action === "remove") {
          const rewards = cfg.levels.rewards.filter((r) => !(r.level === level && (!role || r.roleId === role.id)));
          if (rewards.length === cfg.levels.rewards.length) return ctx.reply("❌ No reward matches that.");
          await saveConfig({ ...cfg, levels: { ...cfg.levels, rewards } });
          return ctx.reply(`✅ Removed. Members keep roles they already have.`);
        }
        throw new UsageError();
      },
    },
  );
}
