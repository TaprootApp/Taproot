import { all, get, run } from "../../db";
import { AdjustOp, MAX_AMOUNT } from "./logic";

// Database access for levels and the economy. The db module shares one
// SQLite connection with every other feature, so an explicit BEGIN/COMMIT
// could interleave with another feature's statements. Instead every change
// here is a single statement that checks its own precondition (enough
// balance, cooldown over, stock left) and reports whether it applied, which
// SQLite makes atomic. Two concurrent !pay or !buy commands can therefore
// never spend the same coins twice.

export async function createTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS engagement_xp (
    user_id TEXT PRIMARY KEY,
    xp INTEGER NOT NULL DEFAULT 0,
    last_xp_at INTEGER NOT NULL DEFAULT 0
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_engagement_xp_rank ON engagement_xp (xp DESC)`);

  await run(`CREATE TABLE IF NOT EXISTS engagement_wallets (
    user_id TEXT PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    daily_streak INTEGER NOT NULL DEFAULT 0,
    last_daily_at INTEGER NOT NULL DEFAULT 0,
    last_work_at INTEGER NOT NULL DEFAULT 0
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_engagement_wallets_rank ON engagement_wallets (balance DESC)`);

  // stock NULL = unlimited.
  await run(`CREATE TABLE IF NOT EXISTS engagement_shop (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    role_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    stock INTEGER,
    created_at INTEGER NOT NULL
  )`);
}

// --- XP ---------------------------------------------------------------------------

/**
 * Adds XP unless the member earned some within the cooldown. Returns the new
 * total, or undefined when the cooldown blocked it.
 */
export async function awardXp(userId: string, amount: number, now: number, cooldownMs: number): Promise<number | undefined> {
  const row = await get<{ xp: number }>(
    `INSERT INTO engagement_xp (user_id, xp, last_xp_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET xp = MIN(xp + excluded.xp, ${MAX_AMOUNT}), last_xp_at = excluded.last_xp_at
     WHERE engagement_xp.last_xp_at <= ?
     RETURNING xp`,
    [userId, Math.min(amount, MAX_AMOUNT), now, now - cooldownMs],
  );
  return row?.xp;
}

export async function xpOf(userId: string): Promise<number> {
  return (await get<{ xp: number }>("SELECT xp FROM engagement_xp WHERE user_id = ?", [userId]))?.xp ?? 0;
}

/** Changes a member's XP; returns [before, after]. Take never goes below 0. */
export async function adjustXp(userId: string, op: AdjustOp, amount: number): Promise<[number, number]> {
  const before = await xpOf(userId);
  if (op === "reset") {
    await run("DELETE FROM engagement_xp WHERE user_id = ?", [userId]);
    return [before, 0];
  }
  const expr = op === "give" ? `MIN(xp + ?, ${MAX_AMOUNT})` : op === "take" ? "MAX(xp - ?, 0)" : "?";
  await run("INSERT OR IGNORE INTO engagement_xp (user_id) VALUES (?)", [userId]);
  const row = await get<{ xp: number }>(`UPDATE engagement_xp SET xp = ${expr} WHERE user_id = ? RETURNING xp`, [amount, userId]);
  return [before, row?.xp ?? 0];
}

/** 1-based position on the levels board, or 0 with no XP. */
export async function xpRank(xp: number): Promise<number> {
  if (xp <= 0) return 0;
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_xp WHERE xp > ?", [xp]);
  return (row?.n ?? 0) + 1;
}

export async function xpBoard(offset: number, limit: number): Promise<{ total: number; rows: { user_id: string; xp: number }[] }> {
  const [count, rows] = await Promise.all([
    get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_xp WHERE xp > 0"),
    all<{ user_id: string; xp: number }>(
      "SELECT user_id, xp FROM engagement_xp WHERE xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?",
      [limit, offset],
    ),
  ]);
  return { total: count?.n ?? 0, rows };
}

export async function resetAllXp(): Promise<number> {
  return (await run("DELETE FROM engagement_xp")).changes;
}

// --- Wallets ----------------------------------------------------------------------

export interface Wallet {
  balance: number;
  daily_streak: number;
  last_daily_at: number;
  last_work_at: number;
}

const EMPTY_WALLET: Wallet = { balance: 0, daily_streak: 0, last_daily_at: 0, last_work_at: 0 };

export async function walletOf(userId: string): Promise<Wallet> {
  return (
    (await get<Wallet>("SELECT balance, daily_streak, last_daily_at, last_work_at FROM engagement_wallets WHERE user_id = ?", [
      userId,
    ])) ?? { ...EMPTY_WALLET }
  );
}

async function ensureWallet(userId: string): Promise<void> {
  await run("INSERT OR IGNORE INTO engagement_wallets (user_id) VALUES (?)", [userId]);
}

/** Adds to a balance (capped at MAX_AMOUNT); returns the new balance. */
export async function credit(userId: string, amount: number): Promise<number> {
  await ensureWallet(userId);
  const row = await get<{ balance: number }>(
    `UPDATE engagement_wallets SET balance = MIN(balance + ?, ${MAX_AMOUNT}) WHERE user_id = ? RETURNING balance`,
    [amount, userId],
  );
  return row?.balance ?? 0;
}

/** Takes `amount` only if the balance covers it; returns the new balance, or undefined. */
export async function debit(userId: string, amount: number): Promise<number | undefined> {
  await ensureWallet(userId);
  const row = await get<{ balance: number }>(
    "UPDATE engagement_wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ? RETURNING balance",
    [amount, userId, amount],
  );
  return row?.balance;
}

/**
 * Moves money between members. The debit is conditional, so the sender can
 * never go negative; if the credit then fails the debit is refunded.
 * Returns the sender's new balance, or undefined when they can't afford it.
 */
export async function transfer(from: string, to: string, amount: number): Promise<number | undefined> {
  const left = await debit(from, amount);
  if (left === undefined) return undefined;
  try {
    await credit(to, amount);
  } catch (err) {
    await credit(from, amount);
    throw err;
  }
  return left;
}

/** Changes a balance for eco give/take/set/reset; returns [before, after]. */
export async function adjustBalance(userId: string, op: AdjustOp, amount: number): Promise<[number, number]> {
  const before = (await walletOf(userId)).balance;
  if (op === "reset") {
    await run("UPDATE engagement_wallets SET balance = 0 WHERE user_id = ?", [userId]);
    return [before, 0];
  }
  await ensureWallet(userId);
  const expr = op === "give" ? `MIN(balance + ?, ${MAX_AMOUNT})` : op === "take" ? "MAX(balance - ?, 0)" : "?";
  const row = await get<{ balance: number }>(`UPDATE engagement_wallets SET balance = ${expr} WHERE user_id = ? RETURNING balance`, [
    amount,
    userId,
  ]);
  return [before, row?.balance ?? 0];
}

/**
 * Pays out a daily if `last_daily_at` is still what the caller read, so two
 * racing claims can't both succeed. Returns the new balance, or undefined.
 */
export async function claimDaily(userId: string, expectedLast: number, amount: number, streak: number, now: number) {
  await ensureWallet(userId);
  const row = await get<{ balance: number }>(
    `UPDATE engagement_wallets SET balance = MIN(balance + ?, ${MAX_AMOUNT}), daily_streak = ?, last_daily_at = ?
     WHERE user_id = ? AND last_daily_at = ? RETURNING balance`,
    [amount, streak, now, userId, expectedLast],
  );
  return row?.balance;
}

/** As claimDaily, for work. */
export async function claimWork(userId: string, expectedLast: number, amount: number, now: number) {
  await ensureWallet(userId);
  const row = await get<{ balance: number }>(
    `UPDATE engagement_wallets SET balance = MIN(balance + ?, ${MAX_AMOUNT}), last_work_at = ?
     WHERE user_id = ? AND last_work_at = ? RETURNING balance`,
    [amount, now, userId, expectedLast],
  );
  return row?.balance;
}

export async function moneyRank(balance: number): Promise<number> {
  if (balance <= 0) return 0;
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_wallets WHERE balance > ?", [balance]);
  return (row?.n ?? 0) + 1;
}

export async function moneyBoard(offset: number, limit: number) {
  const [count, rows] = await Promise.all([
    get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_wallets WHERE balance > 0"),
    all<{ user_id: string; balance: number }>(
      "SELECT user_id, balance FROM engagement_wallets WHERE balance > 0 ORDER BY balance DESC, user_id LIMIT ? OFFSET ?",
      [limit, offset],
    ),
  ]);
  return { total: count?.n ?? 0, rows };
}

/** Clears every wallet (balances, streaks and cooldowns). */
export async function resetAllMoney(): Promise<number> {
  return (await run("DELETE FROM engagement_wallets")).changes;
}

// --- Shop -------------------------------------------------------------------------

export interface ShopItem {
  id: number;
  name: string;
  description: string;
  role_id: string;
  price: number;
  stock: number | null;
}

export async function listShop(): Promise<ShopItem[]> {
  return all<ShopItem>("SELECT id, name, description, role_id, price, stock FROM engagement_shop ORDER BY price, id");
}

export async function shopItem(id: number): Promise<ShopItem | undefined> {
  return get<ShopItem>("SELECT id, name, description, role_id, price, stock FROM engagement_shop WHERE id = ?", [id]);
}

/** An item by its number or its name (any case). */
export async function findShopItem(text: string): Promise<ShopItem | undefined> {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const byId = await shopItem(Number(t));
    if (byId) return byId;
  }
  return get<ShopItem>(
    "SELECT id, name, description, role_id, price, stock FROM engagement_shop WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1",
    [t],
  );
}

export async function countShop(): Promise<number> {
  return (await get<{ n: number }>("SELECT COUNT(*) AS n FROM engagement_shop"))?.n ?? 0;
}

export async function insertShopItem(item: Omit<ShopItem, "id">): Promise<number> {
  const { lastID } = await run(
    "INSERT INTO engagement_shop (name, description, role_id, price, stock, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [item.name, item.description, item.role_id, item.price, item.stock, Date.now()],
  );
  return lastID;
}

export async function updateShopItem(item: ShopItem): Promise<boolean> {
  const { changes } = await run("UPDATE engagement_shop SET name = ?, description = ?, role_id = ?, price = ?, stock = ? WHERE id = ?", [
    item.name,
    item.description,
    item.role_id,
    item.price,
    item.stock,
    item.id,
  ]);
  return changes > 0;
}

export async function deleteShopItem(id: number): Promise<boolean> {
  return (await run("DELETE FROM engagement_shop WHERE id = ?", [id])).changes > 0;
}

/** Reserves one unit; false when sold out (or the item is gone). */
export async function takeStock(id: number): Promise<boolean> {
  const { changes } = await run("UPDATE engagement_shop SET stock = stock - 1 WHERE id = ? AND (stock IS NULL OR stock > 0)", [id]);
  return changes > 0;
}

/** Puts back a unit reserved by takeStock after a failed purchase. */
export async function returnStock(id: number): Promise<void> {
  await run("UPDATE engagement_shop SET stock = stock + 1 WHERE id = ? AND stock IS NOT NULL", [id]);
}
