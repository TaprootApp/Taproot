import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_COOLDOWN_MS,
  DEFAULT_CONFIG,
  bestMultiplier,
  dailyOutcome,
  formatMoney,
  levelFromXp,
  pageCount,
  parseAmount,
  progressBar,
  progressFromXp,
  rewardChanges,
  rewardRolesFor,
  rollXp,
  totalXpForLevel,
  validateEconomy,
  validateLevels,
  xpToNext,
} from "../src/modules/engagement/logic";

const HOUR = 3_600_000;

test("level curve is 5L^2 + 50L + 100", () => {
  assert.equal(xpToNext(0), 100);
  assert.equal(xpToNext(1), 155);
  assert.equal(xpToNext(10), 1100);
  assert.equal(totalXpForLevel(0), 0);
  assert.equal(totalXpForLevel(2), 255);
});

test("progressFromXp splits total XP into level and progress", () => {
  assert.deepEqual(progressFromXp(0), { level: 0, into: 0, needed: 100 });
  assert.deepEqual(progressFromXp(99), { level: 0, into: 99, needed: 100 });
  assert.deepEqual(progressFromXp(100), { level: 1, into: 0, needed: 155 });
  assert.deepEqual(progressFromXp(300), { level: 2, into: 45, needed: 220 });
  assert.equal(levelFromXp(-5), 0);
  for (const level of [1, 5, 20, 50]) assert.equal(levelFromXp(totalXpForLevel(level)), level);
  assert.equal(levelFromXp(totalXpForLevel(20) - 1), 19);
});

test("rollXp stays in range and applies the best role multiplier", () => {
  const cfg = { ...DEFAULT_CONFIG.levels, multipliers: [{ roleId: "a", multiplier: 2 }, { roleId: "b", multiplier: 1.5 }] };
  assert.equal(rollXp(cfg, [], () => 0), 15);
  assert.equal(rollXp(cfg, [], () => 0.9999), 25);
  assert.equal(rollXp(cfg, ["b", "a"], () => 0), 30);
  assert.equal(bestMultiplier(cfg.multipliers, ["b"]), 1.5);
  assert.equal(bestMultiplier(cfg.multipliers, ["x"]), 1);
  const half = { ...cfg, xpMin: 1, xpMax: 1, multipliers: [{ roleId: "slow", multiplier: 0.1 }] };
  assert.equal(rollXp(half, ["slow"], () => 0), 1, "never below 1");
});

test("reward roles stack or keep only the highest", () => {
  const rewards = [
    { level: 5, roleId: "r5" },
    { level: 10, roleId: "r10" },
    { level: 20, roleId: "r20" },
  ];
  assert.deepEqual([...rewardRolesFor(rewards, 4, "stack")], []);
  assert.deepEqual([...rewardRolesFor(rewards, 12, "stack")], ["r5", "r10"]);
  assert.deepEqual([...rewardRolesFor(rewards, 12, "highest")], ["r10"]);
  assert.deepEqual(rewardChanges(rewards, 12, "highest", ["r5", "other"]), { add: ["r10"], remove: ["r5"] });
  assert.deepEqual(rewardChanges(rewards, 12, "stack", ["r5"]), { add: ["r10"], remove: [] });
  // Dropping a level (admin xp take) removes rewards above it.
  assert.deepEqual(rewardChanges(rewards, 6, "stack", ["r5", "r10", "r20"]), { add: [], remove: ["r10", "r20"] });
});

test("daily enforces the 20h cooldown and builds a capped streak", () => {
  const eco = { ...DEFAULT_CONFIG.economy, dailyAmount: 100, dailyStreakBonus: 10, dailyStreakCap: 3 };
  const now = 1_000 * HOUR;
  assert.deepEqual(dailyOutcome(eco, 0, 0, now), { ok: true, waitMs: 0, streak: 1, amount: 100 });
  const early = dailyOutcome(eco, now - 5 * HOUR, 1, now);
  assert.equal(early.ok, false);
  assert.equal(early.waitMs, DAILY_COOLDOWN_MS - 5 * HOUR);
  assert.deepEqual(dailyOutcome(eco, now - 21 * HOUR, 1, now), { ok: true, waitMs: 0, streak: 2, amount: 110 });
  assert.equal(dailyOutcome(eco, now - 24 * HOUR, 9, now).amount, 120, "bonus capped at 3 streak days");
  assert.deepEqual(dailyOutcome(eco, now - 49 * HOUR, 9, now), { ok: true, waitMs: 0, streak: 1, amount: 100 });
});

test("parseAmount accepts positive whole numbers and 'all'", () => {
  assert.equal(parseAmount("250"), 250);
  assert.equal(parseAmount("1,000"), 1000);
  assert.equal(parseAmount("all", 42), 42);
  for (const bad of [undefined, "", "0", "-5", "1.5", "abc", "all", "1e3", "99999999999"]) {
    assert.equal(parseAmount(bad), undefined, String(bad));
  }
  assert.equal(parseAmount("all", 0), undefined);
});

test("validateLevels checks ranges and tidies the config", () => {
  const ok = validateLevels({
    ...DEFAULT_CONFIG.levels,
    rewards: [
      { level: 10, roleId: "b" },
      { level: 5, roleId: "a" },
    ],
    noXpChannels: ["c", "c", ""],
  });
  assert.ok(typeof ok !== "string");
  assert.deepEqual(ok.rewards.map((r) => r.level), [5, 10]);
  assert.deepEqual(ok.noXpChannels, ["c"]);
  const bad = (change: object) => typeof validateLevels({ ...DEFAULT_CONFIG.levels, ...change }) === "string";
  assert.ok(bad({ xpMin: 30, xpMax: 20 }));
  assert.ok(bad({ xpMin: 0 }));
  assert.ok(bad({ cooldownSeconds: -1 }));
  assert.ok(bad({ announce: "channel", announceChannel: null }));
  assert.ok(bad({ announce: "loud" }));
  assert.ok(bad({ rewards: [{ level: 0, roleId: "a" }] }));
  assert.ok(bad({ multipliers: [{ roleId: "a", multiplier: 50 }] }));
  assert.ok(bad({ multipliers: [{ roleId: "a", multiplier: 2 }, { roleId: "a", multiplier: 3 }] }));
});

test("validateEconomy checks names and amounts", () => {
  const ok = validateEconomy({ ...DEFAULT_CONFIG.economy, currencyName: "  gems " });
  assert.ok(typeof ok !== "string");
  assert.equal(ok.currencyName, "gems");
  const bad = (change: object) => typeof validateEconomy({ ...DEFAULT_CONFIG.economy, ...change }) === "string";
  assert.ok(bad({ currencyName: " " }));
  assert.ok(bad({ dailyAmount: 0 }));
  assert.ok(bad({ workMin: 90, workMax: 10 }));
  assert.ok(bad({ dailyStreakCap: 0 }));
});

test("formatting helpers", () => {
  assert.equal(formatMoney({ currencyName: "coins", currencySymbol: "🪙" }, 1250), "🪙 **1,250** coins");
  assert.equal(formatMoney({ currencyName: "gems", currencySymbol: "" }, 3), "**3** gems");
  assert.equal(progressBar(50, 100), "🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜");
  assert.equal(progressBar(0, 100), "⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜");
  assert.equal(pageCount(0, 10), 1);
  assert.equal(pageCount(21, 10), 3);
});
