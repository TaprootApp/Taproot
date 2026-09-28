import { rootServer, ChannelGuid, Client, ErrorCodeType, RootGuidType, RootGuidUtils, UserGuid } from "@rootsdk/server-app";
import { EngagementServiceBase } from "@taproot/gen-server";
import {
  EngagementAdjustRequest,
  EngagementBoard,
  EngagementClaimResult,
  EngagementCurrency,
  EngagementEconomySettings,
  EngagementIdRequest,
  EngagementLeaderboard,
  EngagementLeaderboardRequest,
  EngagementLevelsSettings,
  EngagementMe,
  EngagementMemberStats,
  EngagementResetRequest,
  EngagementResetResult,
  EngagementSettings,
  EngagementShopItem,
  EngagementShopList,
} from "@taproot/gen-shared";
import { errorCode, read } from "../../lib/api";
import { isPrivileged, Level, listRoles } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import { adjustMoney, buyItem, claimDaily, claimWork } from "./economy";
import { adjustXp } from "./levels";
import {
  AdjustOp,
  AnnounceMode,
  DAILY_COOLDOWN_MS,
  EconomyConfig,
  LevelsConfig,
  MAX_AMOUNT,
  MAX_SHOP_ITEMS,
  RewardMode,
  WORK_COOLDOWN_MS,
  levelFromXp,
  pageCount,
  progressFromXp,
  validateEconomy,
  validateLevels,
} from "./logic";
import { AREA, config, displayName, notifySoon, saveConfig } from "./runtime";
import * as store from "./store";

// GUI for levels and the economy. Members read their own standing, the
// leaderboards and the shop, and can claim/buy; admins edit the settings and
// shop and adjust balances. Every rule matches the text commands because both
// go through the same functions.

const BOARD_PAGE = 25;

function currency(): EngagementCurrency {
  const { currencyName, currencySymbol } = config().economy;
  return { name: currencyName, symbol: currencySymbol };
}

async function me(userId: string): Promise<EngagementMe> {
  const cfg = config();
  const [xp, wallet] = await Promise.all([store.xpOf(userId), store.walletOf(userId)]);
  const p = progressFromXp(xp);
  const [xpRank, moneyRank] = await Promise.all([store.xpRank(xp), store.moneyRank(wallet.balance)]);
  const now = Date.now();
  const next = (last: number, cooldown: number) => (last > 0 && last + cooldown > now ? last + cooldown : 0);
  return {
    levelsEnabled: cfg.levels.enabled,
    xp,
    level: p.level,
    levelXp: p.into,
    levelXpNeeded: p.needed,
    xpRank,
    economyEnabled: cfg.economy.enabled,
    balance: wallet.balance,
    moneyRank,
    dailyStreak: wallet.daily_streak,
    nextDailyAtMs: next(wallet.last_daily_at, DAILY_COOLDOWN_MS),
    nextWorkAtMs: next(wallet.last_work_at, WORK_COOLDOWN_MS),
    currency: currency(),
  };
}

function toWireLevels(c: LevelsConfig): EngagementLevelsSettings {
  return {
    enabled: c.enabled,
    xpMin: c.xpMin,
    xpMax: c.xpMax,
    cooldownSeconds: c.cooldownSeconds,
    announce: c.announce,
    announceChannelId: c.announceChannel ?? "",
    announceMessage: c.announceMessage,
    rewardMode: c.rewardMode,
    rewards: c.rewards.map((r) => ({ level: r.level, roleId: r.roleId })),
    multipliers: c.multipliers.map((m) => ({ roleId: m.roleId, multiplier: m.multiplier })),
    noXpChannelIds: [...c.noXpChannels],
    noXpRoleIds: [...c.noXpRoles],
  };
}

function toWireEconomy(c: EconomyConfig): EngagementEconomySettings {
  return { ...c };
}

function settingsMessage(): EngagementSettings {
  const cfg = config();
  return { levels: toWireLevels(cfg.levels), economy: toWireEconomy(cfg.economy) };
}

async function shopList(): Promise<EngagementShopList> {
  const [items, roles] = await Promise.all([store.listShop(), listRoles()]);
  return {
    items: items.map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      roleId: i.role_id,
      roleName: roles.find((r) => r.id === i.role_id)?.name ?? "",
      price: i.price,
      limited: i.stock !== null,
      stock: i.stock ?? 0,
    })),
    currency: currency(),
    enabled: config().economy.enabled,
  };
}

async function requireChannel(channelId: string): Promise<void> {
  try {
    await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
  } catch (err) {
    const code = errorCode(err);
    if (code === ErrorCodeType.NotFound || code === ErrorCodeType.RequestValidationFailed) invalid("That channel doesn't exist anymore.");
    await act(() => Promise.reject(err));
  }
}

function isBot(userId: string): boolean {
  return RootGuidUtils.toRootGuidType(userId as UserGuid) === RootGuidType.App;
}

function wholeInRange(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}

class EngagementService extends EngagementServiceBase {
  // --- Everyone ---

  async getMe(client: Client): Promise<EngagementMe> {
    await requireLevel(client, Level.Member);
    return me(client.userId);
  }

  async getLeaderboard(request: EngagementLeaderboardRequest, client: Client): Promise<EngagementLeaderboard> {
    await requireLevel(client, Level.Member);
    const levels = request.board !== EngagementBoard.MONEY;
    const page = wholeInRange(request.page, 1, 100_000) ? request.page : 1;
    const offset = (page - 1) * BOARD_PAGE;
    const enabled = levels ? config().levels.enabled : config().economy.enabled;
    const board = levels ? await store.xpBoard(offset, BOARD_PAGE) : await store.moneyBoard(offset, BOARD_PAGE);
    const entries = await Promise.all(
      board.rows.map(async (row, i) => {
        const xp = "xp" in row ? row.xp : 0;
        const balance = "balance" in row ? row.balance : 0;
        return {
          position: offset + i + 1,
          userId: row.user_id,
          name: await displayName(row.user_id),
          xp,
          level: levelFromXp(xp),
          balance,
        };
      }),
    );
    return {
      board: levels ? EngagementBoard.LEVELS : EngagementBoard.MONEY,
      page,
      pages: pageCount(board.total, BOARD_PAGE),
      total: board.total,
      entries,
      currency: currency(),
      enabled,
    };
  }

  async listShop(client: Client): Promise<EngagementShopList> {
    await requireLevel(client, Level.Member);
    return shopList();
  }

  async buy(request: EngagementIdRequest, client: Client): Promise<EngagementMe> {
    await requireLevel(client, Level.Member);
    if (!config().economy.enabled) invalid("The economy is turned off.");
    const item = (await store.shopItem(request.id)) ?? notFound("That item isn't in the shop anymore.");
    const result = await buyItem(client.userId, item);
    if ("error" in result) invalid(result.error.replace(/\*\*/g, ""));
    return me(client.userId);
  }

  async claimDaily(client: Client): Promise<EngagementClaimResult> {
    await requireLevel(client, Level.Member);
    if (!config().economy.enabled) invalid("The economy is turned off.");
    const result = await claimDaily(client.userId);
    if (!result.ok) invalid("You already collected your daily reward. Come back later.");
    return { amount: result.amount, me: await me(client.userId) };
  }

  async work(client: Client): Promise<EngagementClaimResult> {
    await requireLevel(client, Level.Member);
    if (!config().economy.enabled) invalid("The economy is turned off.");
    const result = await claimWork(client.userId);
    if (!result.ok) invalid("You worked recently. Try again later.");
    return { amount: result.amount, me: await me(client.userId) };
  }

  // --- Admins ---

  async getSettings(client: Client): Promise<EngagementSettings> {
    await requireLevel(client, Level.Admin);
    return settingsMessage();
  }

  async saveLevels(request: EngagementLevelsSettings, client: Client): Promise<EngagementSettings> {
    await requireLevel(client, Level.Admin);
    const cleaned = validateLevels({
      enabled: request.enabled,
      xpMin: request.xpMin,
      xpMax: request.xpMax,
      cooldownSeconds: request.cooldownSeconds,
      announce: request.announce as AnnounceMode,
      announceChannel: request.announceChannelId || null,
      announceMessage: request.announceMessage,
      rewardMode: request.rewardMode as RewardMode,
      rewards: request.rewards.map((r) => ({ level: r.level, roleId: r.roleId })),
      multipliers: request.multipliers.map((m) => ({ roleId: m.roleId, multiplier: m.multiplier })),
      noXpChannels: request.noXpChannelIds,
      noXpRoles: request.noXpRoleIds,
    });
    if (typeof cleaned === "string") invalid(cleaned);
    const roles = await act(() => listRoles());
    for (const r of cleaned.rewards) {
      const role = roles.find((x) => x.id === r.roleId);
      if (!role) invalid("A reward role doesn't exist anymore. Pick another.");
      if (isPrivileged(role)) invalid(`${role.name} has staff permissions, so it can't be a reward.`);
    }
    for (const m of cleaned.multipliers) {
      if (!roles.some((x) => x.id === m.roleId)) invalid("A multiplier role doesn't exist anymore. Pick another.");
    }
    if (cleaned.announce === "channel" && cleaned.announceChannel) await requireChannel(cleaned.announceChannel);
    await saveConfig({ ...config(), levels: cleaned });
    return settingsMessage();
  }

  async saveEconomy(request: EngagementEconomySettings, client: Client): Promise<EngagementSettings> {
    await requireLevel(client, Level.Admin);
    const cleaned = validateEconomy({ ...request });
    if (typeof cleaned === "string") invalid(cleaned);
    await saveConfig({ ...config(), economy: cleaned });
    return settingsMessage();
  }

  async saveShopItem(request: EngagementShopItem, client: Client): Promise<EngagementShopList> {
    await requireLevel(client, Level.Admin);
    const name = request.name.trim();
    const description = request.description.trim();
    if (!name || name.length > 64) invalid("The item name must be 1 to 64 characters.");
    if (description.length > 200) invalid("The description can be up to 200 characters.");
    if (!wholeInRange(request.price, 0, MAX_AMOUNT)) invalid("The price must be a whole number from 0 to 1,000,000,000.");
    if (request.limited && !wholeInRange(request.stock, 0, 1_000_000)) invalid("Stock must be a whole number from 0 to 1,000,000.");
    const role = (await act(() => listRoles())).find((r) => r.id === request.roleId);
    if (!role) invalid("Pick the role this item gives.");
    if (isPrivileged(role)) invalid(`${role.name} has staff permissions, so it can't be sold.`);
    const item = {
      name,
      description,
      role_id: role.id,
      price: request.price,
      stock: request.limited ? request.stock : null,
    };
    if (request.id > 0) {
      if (!(await store.updateShopItem({ id: request.id, ...item }))) notFound("That item isn't in the shop anymore.");
    } else {
      if ((await store.countShop()) >= MAX_SHOP_ITEMS) invalid(`The shop holds up to ${MAX_SHOP_ITEMS} items.`);
      await store.insertShopItem(item);
    }
    notifySoon(AREA.shop);
    return shopList();
  }

  async deleteShopItem(request: EngagementIdRequest, client: Client): Promise<EngagementShopList> {
    await requireLevel(client, Level.Admin);
    if (!(await store.deleteShopItem(request.id))) notFound("That item isn't in the shop anymore.");
    notifySoon(AREA.shop);
    return shopList();
  }

  async adjust(request: EngagementAdjustRequest, client: Client): Promise<EngagementMemberStats> {
    await requireLevel(client, Level.Admin);
    const op = request.op as AdjustOp;
    if (!["give", "take", "set", "reset"].includes(op)) invalid("Pick give, take, set or reset.");
    if (!request.userId) invalid("Pick a member.");
    if (isBot(request.userId)) invalid("Bots don't earn XP or money.");
    const min = op === "give" || op === "take" ? 1 : 0;
    if (op !== "reset" && !wholeInRange(request.amount, min, MAX_AMOUNT)) {
      invalid(`The amount must be a whole number from ${min} to 1,000,000,000.`);
    }
    const userId = request.userId as UserGuid;
    if (request.board === EngagementBoard.MONEY) await adjustMoney(userId, op, request.amount);
    else await adjustXp(userId, op, request.amount);
    const [xp, wallet, name] = await Promise.all([store.xpOf(userId), store.walletOf(userId), displayName(userId)]);
    return { userId, name, xp, level: levelFromXp(xp), balance: wallet.balance };
  }

  async resetBoard(request: EngagementResetRequest, client: Client): Promise<EngagementResetResult> {
    await requireLevel(client, Level.Admin);
    const money = request.board === EngagementBoard.MONEY;
    const cleared = money ? await store.resetAllMoney() : await store.resetAllXp();
    notifySoon(money ? AREA.money : AREA.xp);
    return { cleared };
  }
}

export const engagementService = new EngagementService();

onChange((area) => {
  if (area.startsWith("engagement:")) engagementService.broadcastEngagementChanged({ area }, "all");
});
