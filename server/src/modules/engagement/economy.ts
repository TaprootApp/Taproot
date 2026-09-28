import { rootServer, CommunityRoleGuid, RootGuidType, RootGuidUtils, UserGuid } from "@rootsdk/server-app";
import { CommandContext, register, UsageError } from "../../commands/registry";
import { describeError, write } from "../../lib/api";
import { formatDuration } from "../../lib/time";
import { truncate, userMention } from "../../lib/text";
import { forgetMember, isPrivileged, Level, listRoles, memberRoleIds } from "../../permissions";
import {
  AdjustOp,
  MAX_AMOUNT,
  MAX_SHOP_ITEMS,
  WORK_COOLDOWN_MS,
  dailyOutcome,
  formatMoney,
  pageCount,
  parseAmount,
  randomBetween,
} from "./logic";
import { AREA, config, displayName, notifySoon } from "./runtime";
import * as store from "./store";

// The community currency: daily and work payouts, member-to-member payments,
// a leaderboard and a role shop. Every balance change is a conditional
// single-statement update in store.ts, so racing commands can't double-spend.

const PAGE_SIZE = 10;

const WORK_LINES = [
  "You tended the community garden 🌱",
  "You helped a newcomer find the rules 📜",
  "You fixed a typo in the announcements ✏️",
  "You moderated a heated debate about pineapple on pizza 🍕",
  "You organised the emoji collection 🗂️",
  "You watered the Taproot 💧",
  "You wrote a very helpful guide 📘",
  "You hosted a trivia night 🎲",
];

function isBot(userId: string): boolean {
  return RootGuidUtils.toRootGuidType(userId as UserGuid) === RootGuidType.App;
}

export function money(amount: number): string {
  return formatMoney(config().economy, amount);
}

export type ClaimResult = { ok: true; amount: number; balance: number; streak: number } | { ok: false; waitMs: number };

export async function claimDaily(userId: string, now = Date.now()): Promise<ClaimResult> {
  const cfg = config().economy;
  // Two tries: a failed compare-and-set means another claim won the race,
  // and re-reading shows the cooldown it started.
  for (let attempt = 0; attempt < 2; attempt++) {
    const wallet = await store.walletOf(userId);
    const outcome = dailyOutcome(cfg, wallet.last_daily_at, wallet.daily_streak, now);
    if (!outcome.ok) return { ok: false, waitMs: outcome.waitMs };
    const balance = await store.claimDaily(userId, wallet.last_daily_at, outcome.amount, outcome.streak, now);
    if (balance !== undefined) {
      notifySoon(AREA.money);
      return { ok: true, amount: outcome.amount, balance, streak: outcome.streak };
    }
  }
  return { ok: false, waitMs: 60_000 };
}

export async function claimWork(userId: string, now = Date.now()): Promise<ClaimResult> {
  const cfg = config().economy;
  for (let attempt = 0; attempt < 2; attempt++) {
    const wallet = await store.walletOf(userId);
    if (wallet.last_work_at > 0 && now - wallet.last_work_at < WORK_COOLDOWN_MS) {
      return { ok: false, waitMs: wallet.last_work_at + WORK_COOLDOWN_MS - now };
    }
    const amount = randomBetween(cfg.workMin, cfg.workMax);
    const balance = await store.claimWork(userId, wallet.last_work_at, amount, now);
    if (balance !== undefined) {
      notifySoon(AREA.money);
      return { ok: true, amount, balance, streak: 0 };
    }
  }
  return { ok: false, waitMs: 60_000 };
}

/**
 * Buys a shop item: reserves stock, takes the price, then gives the role.
 * If the role can't be given, the price and the stock are put back.
 * Returns why it failed, or the new balance.
 */
export async function buyItem(userId: UserGuid, item: store.ShopItem): Promise<{ error: string } | { balance: number }> {
  const role = (await listRoles()).find((r) => r.id === item.role_id);
  if (!role) return { error: "That item's role no longer exists. Ask an admin to fix the shop." };
  if (isPrivileged(role)) return { error: "That item's role now has staff permissions, so it can't be sold." };
  forgetMember(userId);
  if ((await memberRoleIds(userId)).includes(role.id)) return { error: `You already have **${role.name}**.` };

  if (!(await store.takeStock(item.id))) return { error: `**${item.name}** is sold out.` };
  const balance = await store.debit(userId, item.price);
  if (balance === undefined) {
    await store.returnStock(item.id);
    return { error: `You need ${money(item.price)} for **${item.name}**.` };
  }
  try {
    await write("communityMemberRoles.add", () =>
      rootServer.community.communityMemberRoles.add({ communityRoleId: role.id as CommunityRoleGuid, userIds: [userId] }),
    );
  } catch (err) {
    await store.credit(userId, item.price);
    await store.returnStock(item.id);
    notifySoon(AREA.money);
    return { error: `I couldn't give you the role, so you weren't charged. ${describeError(err)}` };
  }
  forgetMember(userId);
  notifySoon(AREA.money);
  if (item.stock !== null) notifySoon(AREA.shop);
  return { balance };
}

/** Applies an admin balance change. Returns [before, after]. */
export async function adjustMoney(userId: string, op: AdjustOp, amount: number): Promise<[number, number]> {
  const result = await store.adjustBalance(userId, op, amount);
  notifySoon(AREA.money);
  return result;
}

// --- Commands ----------------------------------------------------------------

function disabledNotice(ctx: CommandContext): string {
  return ctx.level >= Level.Admin
    ? "📴 The economy is off. Turn it on in the Taproot channel under **Settings › Economy**."
    : "📴 The economy isn't turned on in this community.";
}

function wait(ms: number): string {
  return formatDuration(Math.max(60_000, ms));
}

function stockText(item: store.ShopItem): string {
  return item.stock === null ? "" : item.stock > 0 ? ` · ${item.stock} left` : " · **sold out**";
}

export function registerEconomyCommands(): void {
  const enabled = () => config().economy.enabled;

  register(
    {
      name: "balance",
      aliases: ["bal"],
      category: "Economy",
      level: Level.Member,
      usage: "[@member]",
      description: "Show your balance (or another member's).",
      async run(ctx) {
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const mention = ctx.args.mention("user");
        const userId = mention?.id ?? ctx.authorId;
        const wallet = await store.walletOf(userId);
        const rank = await store.moneyRank(wallet.balance);
        const who = userId === ctx.authorId ? "You have" : `**${await displayName(userId)}** has`;
        const streak = wallet.daily_streak > 1 && userId === ctx.authorId ? ` · 🔥 ${wallet.daily_streak}-day streak` : "";
        await ctx.reply(`👛 ${who} ${money(wallet.balance)}${rank ? ` · Rank **#${rank}**` : ""}${streak}`);
      },
    },
    {
      name: "daily",
      category: "Economy",
      level: Level.Member,
      usage: "",
      description: "Collect your daily reward. Come back every day for a streak bonus.",
      details: ["You can claim every 20 hours. Missing more than 48 hours resets the streak."],
      async run(ctx) {
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const result = await claimDaily(ctx.authorId);
        if (!result.ok) return ctx.reply(`⏳ You already collected today. Come back in **${wait(result.waitMs)}**.`);
        const streak = result.streak > 1 ? ` 🔥 ${result.streak}-day streak!` : "";
        await ctx.reply(`🎁 You collected ${money(result.amount)}.${streak} Balance: ${money(result.balance)}`);
      },
    },
    {
      name: "work",
      category: "Economy",
      level: Level.Member,
      usage: "",
      description: "Do some work for a random payout, once an hour.",
      async run(ctx) {
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const result = await claimWork(ctx.authorId);
        if (!result.ok) return ctx.reply(`⏳ You're tired. You can work again in **${wait(result.waitMs)}**.`);
        const line = WORK_LINES[Math.floor(Math.random() * WORK_LINES.length)];
        await ctx.reply(`💼 ${line} and earned ${money(result.amount)}. Balance: ${money(result.balance)}`);
      },
    },
    {
      name: "pay",
      category: "Economy",
      level: Level.Member,
      usage: "@member <amount|all>",
      description: "Give some of your money to another member.",
      async run(ctx) {
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const mention = ctx.args.mention("user");
        if (!mention?.id) throw new UsageError("Mention who to pay.");
        const to = mention.id as UserGuid;
        if (to === ctx.authorId) return ctx.reply("❌ You can't pay yourself.");
        if (isBot(to)) return ctx.reply("❌ Bots don't need money.");
        const have = (await store.walletOf(ctx.authorId)).balance;
        const amount = parseAmount(ctx.args.word(), have);
        if (amount === undefined) throw new UsageError("Give a whole number above 0, or `all`.");
        const left = await store.transfer(ctx.authorId, to, amount);
        if (left === undefined) return ctx.reply(`❌ You only have ${money(have)}.`);
        notifySoon(AREA.money);
        const name = await displayName(to);
        await ctx.reply(`💸 You paid ${userMention(name, to)} ${money(amount)}. You have ${money(left)} left.`);
      },
    },
    {
      name: "rich",
      category: "Economy",
      level: Level.Member,
      usage: "[page]",
      description: "The richest members, 10 per page.",
      async run(ctx) {
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const word = ctx.args.word();
        const page = word && Number.isInteger(Number(word)) && Number(word) >= 1 ? Number(word) : 1;
        const { total, rows } = await store.moneyBoard((page - 1) * PAGE_SIZE, PAGE_SIZE);
        const pages = pageCount(total, PAGE_SIZE);
        if (rows.length === 0) return ctx.reply(total ? `There are only ${pages} page(s).` : "Nobody has any money yet.");
        const lines = await Promise.all(
          rows.map(async (r, i) => {
            const pos = (page - 1) * PAGE_SIZE + i + 1;
            const medal = ["🥇", "🥈", "🥉"][pos - 1] ?? `**${pos}.**`;
            return `${medal} ${await displayName(r.user_id)} · ${money(r.balance)}`;
          }),
        );
        const footer = pages > 1 ? `\n*Page ${page} of ${pages}. \`${ctx.prefix}rich ${Math.min(page + 1, pages)}\` for more.*` : "";
        await ctx.reply(`💰 **Richest members**\n${lines.join("\n")}${footer}`);
      },
    },
    {
      name: "shop",
      category: "Economy",
      level: Level.Member,
      usage: "[add <price> @role [name] | remove <item>]",
      description: "See what's for sale. Admins can add and remove role items.",
      details: ["Stock limits and descriptions are set on the Economy settings page."],
      async run(ctx) {
        const action = ctx.args.word();
        if (action === "add" || action === "remove") {
          if (ctx.level < Level.Admin) return ctx.reply("🔒 Only admins can change the shop.");
          if (action === "remove") {
            const item = await store.findShopItem(ctx.args.rest());
            if (!item) return ctx.reply("❌ No item with that number or name.");
            await store.deleteShopItem(item.id);
            notifySoon(AREA.shop);
            return ctx.reply(`🗑️ Removed **${item.name}** from the shop.`);
          }
          const priceText = ctx.args.word();
          const price = priceText === "0" ? 0 : parseAmount(priceText);
          if (price === undefined) throw new UsageError("Give the price as a whole number.");
          const mention = ctx.args.mention("role");
          const role = mention?.id ? (await listRoles()).find((r) => r.id === mention.id) : undefined;
          if (!role) throw new UsageError("Mention the role to sell.");
          if (isPrivileged(role)) return ctx.reply("❌ That role has staff permissions, so it can't be sold.");
          if ((await store.countShop()) >= MAX_SHOP_ITEMS) return ctx.reply(`❌ The shop holds up to ${MAX_SHOP_ITEMS} items.`);
          const name = truncate(ctx.args.rest() || role.name, 64);
          const id = await store.insertShopItem({ name, description: "", role_id: role.id, price, stock: null });
          notifySoon(AREA.shop);
          return ctx.reply(`✅ Added **${name}** (#${id}) for ${money(price)}. Members buy it with \`${ctx.prefix}buy ${id}\`.`);
        }
        if (action) throw new UsageError();
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const items = await store.listShop();
        if (items.length === 0) return ctx.reply("🛒 The shop is empty.");
        const roles = await listRoles();
        const lines = items.map((item) => {
          const role = roles.find((r) => r.id === item.role_id);
          const desc = item.description ? ` · ${item.description}` : "";
          return `**#${item.id} ${item.name}** · ${money(item.price)} · role **${role?.name ?? "deleted"}**${stockText(item)}${desc}`;
        });
        await ctx.reply(`🛒 **Shop**\n${lines.join("\n")}\n*Buy with \`${ctx.prefix}buy <number or name>\`.*`);
      },
    },
    {
      name: "buy",
      category: "Economy",
      level: Level.Member,
      usage: "<item number or name>",
      description: "Buy an item from the shop.",
      async run(ctx) {
        if (!enabled()) return ctx.reply(disabledNotice(ctx));
        const text = ctx.args.rest();
        if (!text) throw new UsageError();
        const item = await store.findShopItem(text);
        if (!item) return ctx.reply(`❌ No item called that. See \`${ctx.prefix}shop\`.`);
        const result = await buyItem(ctx.authorId, item);
        if ("error" in result) return ctx.reply(`❌ ${result.error}`);
        await ctx.reply(`🛍️ You bought **${item.name}** for ${money(item.price)}. Balance: ${money(result.balance)}`);
      },
    },
    {
      name: "eco",
      category: "Economy",
      level: Level.Admin,
      usage: "<give|take|set> @member <amount> | reset <@member|all>",
      description: "Change a member's balance.",
      details: ["`eco reset all` clears every balance, streak and cooldown."],
      async run(ctx) {
        const op = ctx.args.word() as AdjustOp | undefined;
        if (!op || !["give", "take", "set", "reset"].includes(op)) throw new UsageError();
        if (op === "reset" && ctx.args.peek()?.text.toLowerCase() === "all") {
          const n = await store.resetAllMoney();
          notifySoon(AREA.money);
          return ctx.reply(`🧹 Cleared ${n} wallet(s).`);
        }
        const mention = ctx.args.mention("user");
        if (!mention?.id) throw new UsageError("Mention the member.");
        if (isBot(mention.id)) return ctx.reply("❌ Bots don't have wallets.");
        let amount = 0;
        if (op !== "reset") {
          const text = ctx.args.word();
          const parsed = op === "set" && text === "0" ? 0 : parseAmount(text);
          if (parsed === undefined) throw new UsageError(`Give a whole number up to ${MAX_AMOUNT.toLocaleString("en-US")}.`);
          amount = parsed;
        }
        const [before, after] = await adjustMoney(mention.id, op, amount);
        await ctx.reply(`✅ **${await displayName(mention.id)}**: ${before.toLocaleString("en-US")} → ${money(after)}`);
      },
    },
  );
}
