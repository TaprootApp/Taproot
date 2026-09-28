// Levels and economy math. Pure: no SDK or database imports, so the tests can
// cover every rule the commands and the GUI rely on.

// --- Config ---------------------------------------------------------------------

export type AnnounceMode = "off" | "current" | "channel";
export type RewardMode = "stack" | "highest";

export interface LevelReward {
  level: number;
  roleId: string;
}

export interface XpMultiplier {
  roleId: string;
  /** 0.1 to 10; the highest one among a member's roles applies. */
  multiplier: number;
}

export interface LevelsConfig {
  enabled: boolean;
  xpMin: number;
  xpMax: number;
  cooldownSeconds: number;
  announce: AnnounceMode;
  announceChannel: string | null;
  announceMessage: string;
  rewardMode: RewardMode;
  rewards: LevelReward[];
  multipliers: XpMultiplier[];
  noXpChannels: string[];
  noXpRoles: string[];
}

export interface EconomyConfig {
  enabled: boolean;
  currencyName: string;
  currencySymbol: string;
  dailyAmount: number;
  /** Extra per day of streak after the first. */
  dailyStreakBonus: number;
  /** Streak days that count toward the bonus. */
  dailyStreakCap: number;
  workMin: number;
  workMax: number;
}

export interface EngagementConfig {
  levels: LevelsConfig;
  economy: EconomyConfig;
}

export const DEFAULT_CONFIG: EngagementConfig = {
  levels: {
    enabled: false,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    announce: "current",
    announceChannel: null,
    announceMessage: "🎉 {user} just reached **level {level}**!",
    rewardMode: "stack",
    rewards: [],
    multipliers: [],
    noXpChannels: [],
    noXpRoles: [],
  },
  economy: {
    enabled: false,
    currencyName: "coins",
    currencySymbol: "🪙",
    dailyAmount: 100,
    dailyStreakBonus: 10,
    dailyStreakCap: 7,
    workMin: 20,
    workMax: 80,
  },
};

// --- Limits (shared by the commands and the GUI service) --------------------------

/** Largest amount of XP or currency any single balance or change may hold. */
export const MAX_AMOUNT = 1_000_000_000;
export const MAX_LEVEL = 1000;
export const MAX_REWARDS = 50;
export const MAX_MULTIPLIERS = 25;
export const MAX_SHOP_ITEMS = 50;
export const DAILY_COOLDOWN_MS = 20 * 3_600_000;
/** A daily claimed within this long of the last one keeps the streak. */
export const STREAK_WINDOW_MS = 48 * 3_600_000;
export const WORK_COOLDOWN_MS = 3_600_000;

/**
 * Checks and tidies a levels config from the GUI. Returns an error sentence,
 * or the cleaned config.
 */
export function validateLevels(input: LevelsConfig): LevelsConfig | string {
  const whole = (n: number) => Number.isInteger(n);
  if (!whole(input.xpMin) || !whole(input.xpMax) || input.xpMin < 1 || input.xpMax > 1000 || input.xpMin > input.xpMax) {
    return "XP per message must be whole numbers from 1 to 1000, with the minimum no higher than the maximum.";
  }
  if (!whole(input.cooldownSeconds) || input.cooldownSeconds < 0 || input.cooldownSeconds > 3600) {
    return "The XP cooldown must be 0 to 3600 seconds.";
  }
  if (!["off", "current", "channel"].includes(input.announce)) return "Pick where level-ups are announced.";
  if (input.announce === "channel" && !input.announceChannel) return "Pick the channel for level-up announcements.";
  const message = input.announceMessage.trim();
  if (input.announce !== "off" && !message) return "The level-up message can't be empty.";
  if (message.length > 1000) return "The level-up message can be up to 1000 characters.";
  if (!["stack", "highest"].includes(input.rewardMode)) return "Pick how role rewards combine.";
  if (input.rewards.length > MAX_REWARDS) return `Up to ${MAX_REWARDS} role rewards.`;
  const seen = new Set<string>();
  for (const r of input.rewards) {
    if (!whole(r.level) || r.level < 1 || r.level > MAX_LEVEL) return `Reward levels must be 1 to ${MAX_LEVEL}.`;
    if (!r.roleId) return "Every reward needs a role.";
    const key = `${r.level}:${r.roleId}`;
    if (seen.has(key)) return "The same role is listed twice for one level.";
    seen.add(key);
  }
  if (input.multipliers.length > MAX_MULTIPLIERS) return `Up to ${MAX_MULTIPLIERS} XP multipliers.`;
  const multiplierRoles = new Set<string>();
  for (const m of input.multipliers) {
    if (!m.roleId) return "Every multiplier needs a role.";
    if (!(m.multiplier >= 0.1 && m.multiplier <= 10)) return "Multipliers must be between 0.1 and 10.";
    if (multiplierRoles.has(m.roleId)) return "A role can only have one multiplier.";
    multiplierRoles.add(m.roleId);
  }
  return {
    ...input,
    announceChannel: input.announce === "channel" ? input.announceChannel : input.announceChannel || null,
    announceMessage: message || DEFAULT_CONFIG.levels.announceMessage,
    rewards: [...input.rewards].sort((a, b) => a.level - b.level),
    multipliers: input.multipliers.map((m) => ({ roleId: m.roleId, multiplier: Math.round(m.multiplier * 100) / 100 })),
    noXpChannels: [...new Set(input.noXpChannels.filter(Boolean))],
    noXpRoles: [...new Set(input.noXpRoles.filter(Boolean))],
  };
}

/** As validateLevels, for the economy settings. */
export function validateEconomy(input: EconomyConfig): EconomyConfig | string {
  const name = input.currencyName.trim();
  const symbol = input.currencySymbol.trim();
  if (!name || name.length > 32) return "The currency name must be 1 to 32 characters.";
  if (symbol.length > 32) return "The currency symbol can be up to 32 characters.";
  const inRange = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (!inRange(input.dailyAmount, 1, 1_000_000)) return "The daily amount must be 1 to 1,000,000.";
  if (!inRange(input.dailyStreakBonus, 0, 1_000_000)) return "The streak bonus must be 0 to 1,000,000.";
  if (!inRange(input.dailyStreakCap, 1, 365)) return "The streak cap must be 1 to 365 days.";
  if (!inRange(input.workMin, 1, 1_000_000) || !inRange(input.workMax, 1, 1_000_000) || input.workMin > input.workMax) {
    return "Work pay must be 1 to 1,000,000, with the minimum no higher than the maximum.";
  }
  return { ...input, currencyName: name, currencySymbol: symbol };
}

/** An admin change to XP or a balance. */
export type AdjustOp = "give" | "take" | "set" | "reset";

// --- Levels -----------------------------------------------------------------------

/** XP needed to go from `level` to `level + 1` (Dyno/MEE6 curve). */
export function xpToNext(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP at which `level` is reached. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

export interface LevelProgress {
  level: number;
  /** XP earned since reaching `level`. */
  into: number;
  /** XP from `level` to the next one. */
  needed: number;
}

export function progressFromXp(xp: number): LevelProgress {
  let level = 0;
  let rest = Math.max(0, Math.floor(xp));
  while (level < MAX_LEVEL && rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return { level, into: rest, needed: xpToNext(level) };
}

export function levelFromXp(xp: number): number {
  return progressFromXp(xp).level;
}

/** A random whole number from min to max inclusive; `rand` returns [0, 1). */
export function randomBetween(min: number, max: number, rand: () => number = Math.random): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/** The XP one message earns: a random base times the best multiplier among the member's roles. */
export function rollXp(config: LevelsConfig, roleIds: readonly string[], rand: () => number = Math.random): number {
  const base = randomBetween(config.xpMin, config.xpMax, rand);
  return Math.max(1, Math.round(base * bestMultiplier(config.multipliers, roleIds)));
}

export function bestMultiplier(multipliers: readonly XpMultiplier[], roleIds: readonly string[]): number {
  let best: number | undefined;
  for (const m of multipliers) {
    if (roleIds.includes(m.roleId) && (best === undefined || m.multiplier > best)) best = m.multiplier;
  }
  return best ?? 1;
}

/**
 * Which reward roles a member at `level` should have. "stack" keeps every
 * reward reached so far; "highest" keeps only the highest reached level's.
 */
export function rewardRolesFor(rewards: readonly LevelReward[], level: number, mode: RewardMode): Set<string> {
  const reached = rewards.filter((r) => r.level <= level);
  if (mode === "highest" && reached.length > 0) {
    const top = Math.max(...reached.map((r) => r.level));
    return new Set(reached.filter((r) => r.level === top).map((r) => r.roleId));
  }
  return new Set(reached.map((r) => r.roleId));
}

/** Role changes that bring a member's reward roles in line with their level. */
export function rewardChanges(
  rewards: readonly LevelReward[],
  level: number,
  mode: RewardMode,
  current: readonly string[],
): { add: string[]; remove: string[] } {
  const want = rewardRolesFor(rewards, level, mode);
  const all = new Set(rewards.map((r) => r.roleId));
  return {
    add: [...want].filter((id) => !current.includes(id)),
    remove: [...all].filter((id) => !want.has(id) && current.includes(id)),
  };
}

// --- Economy ----------------------------------------------------------------------

export interface DailyOutcome {
  /** False while on cooldown; `waitMs` says how long is left. */
  ok: boolean;
  waitMs: number;
  streak: number;
  amount: number;
}

/**
 * The result of claiming a daily now. The streak continues when the last
 * claim was within STREAK_WINDOW_MS, and each streak day after the first
 * adds the bonus, up to the cap.
 */
export function dailyOutcome(config: EconomyConfig, lastAt: number, streak: number, now: number): DailyOutcome {
  if (lastAt > 0 && now - lastAt < DAILY_COOLDOWN_MS) {
    return { ok: false, waitMs: lastAt + DAILY_COOLDOWN_MS - now, streak, amount: 0 };
  }
  const next = lastAt > 0 && now - lastAt <= STREAK_WINDOW_MS ? streak + 1 : 1;
  const bonusDays = Math.min(next, config.dailyStreakCap) - 1;
  return { ok: true, waitMs: 0, streak: next, amount: config.dailyAmount + config.dailyStreakBonus * bonusDays };
}

/**
 * Reads an amount typed in chat: digits with optional commas or underscores,
 * or "all" when `all` is given. Undefined unless it's 1 to MAX_AMOUNT.
 */
export function parseAmount(text: string | undefined, all?: number): number | undefined {
  if (!text) return undefined;
  const t = text.trim().toLowerCase();
  if (t === "all" && all !== undefined) return all > 0 ? Math.min(all, MAX_AMOUNT) : undefined;
  if (!/^\d[\d,_]*$/.test(t)) return undefined;
  const n = Number(t.replace(/[,_]/g, ""));
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_AMOUNT ? n : undefined;
}

/** "🪙 1,250 coins", or "1,250 coins" without a symbol. */
export function formatMoney(config: Pick<EconomyConfig, "currencyName" | "currencySymbol">, amount: number): string {
  const n = amount.toLocaleString("en-US");
  return config.currencySymbol ? `${config.currencySymbol} **${n}** ${config.currencyName}` : `**${n}** ${config.currencyName}`;
}

/** A progress bar for chat in emoji squares, e.g. "🟩🟩🟩⬜⬜⬜⬜⬜⬜⬜". */
export function progressBar(into: number, needed: number, width = 10): string {
  const filled = needed > 0 ? Math.min(width, Math.floor((into / needed) * width)) : 0;
  return "🟩".repeat(filled) + "⬜".repeat(width - filled);
}

/** The 1-based page count for `total` rows at `size` per page (at least 1). */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}
