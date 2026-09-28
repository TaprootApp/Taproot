import { randomInt } from "node:crypto";
import { UsageError, register } from "../../commands/registry";
import { all, get, run } from "../../db";
import { emojiKey } from "../../features/emoji";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { log, errMessage } from "../../lib/log";
import { truncate } from "../../lib/text";
import { formatDuration, formatUtc, parseDuration } from "../../lib/time";
import { reply, send } from "../../messaging";
import { Level, listRoles } from "../../permissions";
import { notifyChange } from "../../services/changes";
import {
  ENTER_SHORTCODE,
  GIVEAWAY_MAX_MS,
  GIVEAWAY_MIN_MS,
  MAX_PRIZE,
  MAX_WINNERS,
  parseWinnerCount,
  plainMentions,
  shuffle,
} from "./logic";
import { GiveawayState, renderGiveaway, renderWinners } from "./render";
import {
  AREA_GIVEAWAYS,
  displayName,
  editMessage,
  fetchMessage,
  isBot,
  memberInfo,
  notifyMember,
  seedReaction,
} from "./shared";

// Giveaways: Taproot posts the giveaway and seeds a 🎉 reaction. Entries are
// stored as reaction events arrive, topped up from the message's reactions
// when the draw runs, and the draw happens from a job (reconciled at startup
// and daily). Winners must still be members, not bots, and hold the required
// role (if any) at draw time.

const JOB = "eventsGiveaway";

export interface Giveaway {
  id: number;
  channel_id: string;
  message_id: string;
  prize: string;
  winner_count: number;
  required_role_id: string | null;
  host_id: string;
  ends_at: number;
  state: GiveawayState;
  /** JSON: Array<{ id: string; reroll: boolean }>. */
  winners: string;
  created_at: number;
  ended_at: number | null;
}

export interface Winner {
  id: string;
  reroll: boolean;
}

export async function initGiveawayTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS events_giveaways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    prize TEXT NOT NULL,
    winner_count INTEGER NOT NULL,
    required_role_id TEXT,
    host_id TEXT NOT NULL,
    ends_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'running',
    winners TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_giveaways_message ON events_giveaways (message_id)`);
  await run(`CREATE TABLE IF NOT EXISTS events_giveaway_entries (
    giveaway_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    entered_at INTEGER NOT NULL,
    PRIMARY KEY (giveaway_id, user_id)
  )`);
}

export function winnersOf(g: Giveaway): Winner[] {
  try {
    const parsed = JSON.parse(g.winners) as Winner[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function giveawayById(id: number): Promise<Giveaway | undefined> {
  return Number.isInteger(id) ? get<Giveaway>("SELECT * FROM events_giveaways WHERE id = ?", [id]) : undefined;
}

export async function listGiveaways(limit = 100): Promise<Giveaway[]> {
  return all<Giveaway>("SELECT * FROM events_giveaways ORDER BY (state = 'running') DESC, id DESC LIMIT ?", [limit]);
}

export async function entryCount(id: number): Promise<number> {
  return (await get<{ n: number }>("SELECT COUNT(*) AS n FROM events_giveaway_entries WHERE giveaway_id = ?", [id]))?.n ?? 0;
}

async function roleName(roleId: string | null): Promise<string | undefined> {
  if (!roleId) return undefined;
  try {
    return (await listRoles()).find((r) => r.id === roleId)?.name ?? "deleted role";
  } catch {
    return "a role";
  }
}

async function render(g: Giveaway): Promise<string> {
  const winners = await Promise.all(winnersOf(g).map(async (w) => ({ id: w.id, name: `${await displayName(w.id)}${w.reroll ? " (reroll)" : ""}` })));
  return renderGiveaway({
    id: g.id,
    prize: g.prize,
    winnerCount: g.winner_count,
    hostName: await displayName(g.host_id),
    roleName: await roleName(g.required_role_id),
    endsAt: g.state === "running" ? g.ends_at : g.ended_at ?? g.ends_at,
    state: g.state,
    entries: await entryCount(g.id),
    winners,
  });
}

async function refreshMessage(g: Giveaway): Promise<void> {
  if (g.message_id) await editMessage(g.channel_id, g.message_id, await render(g));
}

// --- Actions (shared by commands and the GUI) --------------------------------

export interface NewGiveaway {
  channelId: string;
  prize: string;
  winnerCount: number;
  durationMs: number;
  roleId?: string;
  hostId: string;
}

/** Why a giveaway can't be created, or undefined. */
export function giveawayProblem(input: Omit<NewGiveaway, "channelId" | "hostId">): string | undefined {
  if (!input.prize.trim()) return "Say what the prize is.";
  if (input.prize.length > MAX_PRIZE) return `Keep the prize under ${MAX_PRIZE} characters.`;
  if (!Number.isInteger(input.winnerCount) || input.winnerCount < 1 || input.winnerCount > MAX_WINNERS) {
    return `Pick 1 to ${MAX_WINNERS} winners.`;
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < GIVEAWAY_MIN_MS || input.durationMs > GIVEAWAY_MAX_MS) {
    return "A giveaway can run from 1 minute to 90 days.";
  }
  return undefined;
}

/** Posts the giveaway, seeds 🎉 and schedules the draw. Callers validate first. */
export async function startGiveaway(input: NewGiveaway): Promise<{ giveaway: Giveaway; seeded: boolean }> {
  const now = Date.now();
  const prize = plainMentions(input.prize.trim());
  const { lastID } = await run(
    `INSERT INTO events_giveaways (channel_id, prize, winner_count, required_role_id, host_id, ends_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.channelId, prize, input.winnerCount, input.roleId ?? null, input.hostId, now + input.durationMs, now],
  );
  let g = (await giveawayById(lastID))!;
  try {
    const msg = await send(g.channel_id, await render(g));
    await run("UPDATE events_giveaways SET message_id = ? WHERE id = ?", [msg.id, g.id]);
    g = { ...g, message_id: msg.id };
  } catch (err) {
    await run("DELETE FROM events_giveaways WHERE id = ?", [g.id]);
    throw err;
  }
  const seeded = await seedReaction(g.channel_id, g.message_id, ENTER_SHORTCODE);
  await scheduleOnce(JOB, g.id, g.ends_at);
  notifyChange(AREA_GIVEAWAYS);
  return { giveaway: g, seeded };
}

/** Adds everyone who reacted 🎉 on the message but whose event we missed. */
async function syncEntries(g: Giveaway): Promise<void> {
  if (!g.message_id) return;
  const msg = await fetchMessage(g.channel_id, g.message_id);
  if (!msg) return;
  const key = emojiKey(ENTER_SHORTCODE);
  for (const r of msg.reactions ?? []) {
    if (emojiKey(r.shortcode) !== key || isBot(r.userId)) continue;
    await run("INSERT OR IGNORE INTO events_giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)", [
      g.id,
      r.userId,
      Date.now(),
    ]);
  }
}

/**
 * Draws up to `count` distinct winners, skipping `exclude`, bots, members who
 * left and (when set) members without the required role.
 */
async function draw(g: Giveaway, count: number, exclude: Set<string>): Promise<string[]> {
  const rows = await all<{ user_id: string }>("SELECT user_id FROM events_giveaway_entries WHERE giveaway_id = ?", [g.id]);
  const pool = shuffle(
    rows.map((r) => r.user_id).filter((id) => !exclude.has(id) && !isBot(id)),
    randomInt,
  );
  const winners: string[] = [];
  for (const userId of pool) {
    if (winners.length >= count) break;
    try {
      const member = await memberInfo(userId);
      if (!member) continue;
      if (g.required_role_id && !member.roleIds.includes(g.required_role_id)) continue;
      winners.push(userId);
    } catch (err) {
      log("warn", "giveaway: member check failed, skipping entrant", { error: errMessage(err) });
    }
  }
  return winners;
}

async function announce(g: Giveaway, winnerIds: string[], reroll: boolean): Promise<void> {
  const winners = await Promise.all(winnerIds.map(async (id) => ({ id, name: await displayName(id) })));
  const text = renderWinners(g.prize, winners, await entryCount(g.id), reroll);
  try {
    if (g.message_id) await reply(g.channel_id, g.message_id, text);
    else await send(g.channel_id, text);
  } catch (err) {
    // The reply target may be gone; fall back to a plain post.
    log("warn", "giveaway announce reply failed", { error: errMessage(err) });
    await send(g.channel_id, text).catch((e) => log("warn", "giveaway announce failed", { error: errMessage(e) }));
  }
  for (const id of winnerIds) {
    await notifyMember(id, "You won a giveaway! 🎉", `You won ${truncate(g.prize, 120)}.`);
  }
}

const ending = new Set<number>();

/**
 * Ends a running giveaway: draws, records and announces winners. Returns the
 * updated giveaway, or a reason it couldn't end.
 */
export async function endGiveaway(id: number): Promise<Giveaway | string> {
  const g = await giveawayById(id);
  if (!g) return "No giveaway with that number.";
  if (g.state !== "running") return `Giveaway #${id} has already ${g.state === "cancelled" ? "been cancelled" : "ended"}.`;
  if (ending.has(id)) return `Giveaway #${id} is already being drawn.`;
  ending.add(id);
  try {
    await syncEntries(g);
    const winnerIds = await draw(g, g.winner_count, new Set());
    const winners: Winner[] = winnerIds.map((w) => ({ id: w, reroll: false }));
    const { changes } = await run(
      "UPDATE events_giveaways SET state = 'ended', winners = ?, ended_at = ? WHERE id = ? AND state = 'running'",
      [JSON.stringify(winners), Date.now(), id],
    );
    if (!changes) return `Giveaway #${id} has already ended.`;
    await cancelJobs(JOB, id).catch(() => undefined);
    const ended = (await giveawayById(id))!;
    await refreshMessage(ended);
    await announce(ended, winnerIds, false);
    notifyChange(AREA_GIVEAWAYS);
    return ended;
  } finally {
    ending.delete(id);
  }
}

/** Draws `count` more winners from the entrants who haven't won yet. */
export async function rerollGiveaway(id: number, count: number): Promise<{ giveaway: Giveaway; drawn: string[] } | string> {
  const g = await giveawayById(id);
  if (!g) return "No giveaway with that number.";
  if (g.state !== "ended") return g.state === "running" ? `Giveaway #${id} is still running. End it first.` : `Giveaway #${id} was cancelled.`;
  if (!Number.isInteger(count) || count < 1 || count > MAX_WINNERS) return `Reroll 1 to ${MAX_WINNERS} winners.`;
  if (ending.has(id)) return `Giveaway #${id} is already being drawn.`;
  ending.add(id);
  try {
    const previous = winnersOf(g);
    const drawn = await draw(g, count, new Set(previous.map((w) => w.id)));
    const winners = [...previous, ...drawn.map((w) => ({ id: w, reroll: true }))];
    await run("UPDATE events_giveaways SET winners = ? WHERE id = ?", [JSON.stringify(winners), id]);
    const updated = (await giveawayById(id))!;
    await refreshMessage(updated);
    await announce(updated, drawn, true);
    notifyChange(AREA_GIVEAWAYS);
    return { giveaway: updated, drawn };
  } finally {
    ending.delete(id);
  }
}

export async function cancelGiveaway(id: number): Promise<Giveaway | string> {
  const g = await giveawayById(id);
  if (!g) return "No giveaway with that number.";
  const { changes } = await run("UPDATE events_giveaways SET state = 'cancelled', ended_at = ? WHERE id = ? AND state = 'running'", [
    Date.now(),
    id,
  ]);
  if (!changes) return `Giveaway #${id} isn't running.`;
  await cancelJobs(JOB, id).catch(() => undefined);
  const cancelled = (await giveawayById(id))!;
  await refreshMessage(cancelled);
  notifyChange(AREA_GIVEAWAYS);
  return cancelled;
}

// --- Events --------------------------------------------------------------------

// Members told they lack the required role, so repeated clicks don't spam them.
const warnedNoRole = new Set<string>();

export async function onGiveawayReaction(messageId: string, userId: string, shortcode: string, added: boolean): Promise<void> {
  if (emojiKey(shortcode) !== emojiKey(ENTER_SHORTCODE) || isBot(userId)) return;
  const g = await get<Giveaway>("SELECT * FROM events_giveaways WHERE message_id = ? AND state = 'running'", [messageId]);
  if (!g) return;
  if (!added) {
    await run("DELETE FROM events_giveaway_entries WHERE giveaway_id = ? AND user_id = ?", [g.id, userId]);
    notifyChange(AREA_GIVEAWAYS);
    return;
  }
  await run("INSERT OR IGNORE INTO events_giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)", [g.id, userId, Date.now()]);
  notifyChange(AREA_GIVEAWAYS);
  // The role is checked again at the draw; this just tells them early.
  if (g.required_role_id && !warnedNoRole.has(`${g.id}:${userId}`)) {
    const member = await memberInfo(userId).catch(() => undefined);
    if (member && !member.roleIds.includes(g.required_role_id)) {
      warnedNoRole.add(`${g.id}:${userId}`);
      const role = (await roleName(g.required_role_id)) ?? "a role";
      await notifyMember(userId, "Giveaway entry needs a role", `You need the ${role} role by the draw to win ${truncate(g.prize, 80)}.`);
    }
  }
}

/** A running giveaway whose message was deleted is cancelled. */
export async function onGiveawayMessageDeleted(messageId: string): Promise<void> {
  const g = await get<Giveaway>("SELECT * FROM events_giveaways WHERE message_id = ? AND state = 'running'", [messageId]);
  if (!g) return;
  await run("UPDATE events_giveaways SET state = 'cancelled', ended_at = ?, message_id = '' WHERE id = ?", [Date.now(), g.id]);
  await cancelJobs(JOB, g.id).catch(() => undefined);
  notifyChange(AREA_GIVEAWAYS);
}

async function reconcile(): Promise<void> {
  for (const g of await all<Giveaway>("SELECT * FROM events_giveaways WHERE state = 'running'")) {
    if (g.ends_at <= Date.now()) {
      const result = await endGiveaway(g.id).catch((err) => errMessage(err));
      if (typeof result === "string") log("warn", "late giveaway draw failed", { id: g.id, reason: result });
    } else if (!(await hasJob(JOB, g.id))) {
      await scheduleOnce(JOB, g.id, g.ends_at);
    }
  }
}

// --- Commands ----------------------------------------------------------------

export function registerGiveaways(): void {
  onJob(JOB, async (id) => {
    const result = await endGiveaway(id);
    if (typeof result === "string") log("info", "giveaway job skipped", { id, reason: result });
  });
  onReconcile(reconcile);

  register({
    name: "giveaway",
    aliases: ["giveaways"],
    category: "Giveaways",
    level: Level.Moderator,
    usage: "start #channel <duration> <winners> [@role] <prize> | end <id> | reroll <id> [count] | cancel <id> | list",
    description: "Run giveaways: members react with 🎉 to enter.",
    details: [
      "`giveaway start #giveaways 1d 2 Steam key` draws 2 winners in a day.",
      "Mention a role before the prize to require it: `giveaway start #giveaways 3h 1 @Supporters Nitro`.",
      "`giveaway reroll 4` draws one new winner who hasn't won yet; `giveaway reroll 4 2` draws two.",
      "Winners must still be members (and hold the required role) at the draw. Timing is accurate to about a minute.",
    ],
    async run(ctx) {
      const action = ctx.args.word() ?? "list";

      if (action === "start" || action === "create") {
        const channel = ctx.args.mention("channel");
        if (!channel?.id) throw new UsageError("Mention the channel to post in first.");
        const durationMs = parseDuration(ctx.args.word() ?? "");
        if (durationMs === undefined) throw new UsageError("Give a duration after the channel, like `1d` or `2h30m`.");
        const winnerCount = parseWinnerCount(ctx.args.word());
        if (winnerCount === undefined) throw new UsageError(`Give the number of winners (1-${MAX_WINNERS}) after the duration.`);
        const role = ctx.args.mention("role");
        const prize = ctx.args.rest();
        const problem = giveawayProblem({ prize, winnerCount, durationMs });
        if (problem) return ctx.reply(`❌ ${problem}`);
        const { giveaway, seeded } = await startGiveaway({
          channelId: channel.id,
          prize,
          winnerCount,
          durationMs,
          roleId: role?.id,
          hostId: ctx.authorId,
        });
        const hint = seeded ? "" : "\n⚠️ I couldn't add the 🎉 reaction myself; react once so members can click it.";
        return ctx.reply(
          `✅ Giveaway **#${giveaway.id}** started in ${channel.text}. It ends ${formatUtc(giveaway.ends_at)} (in ${formatDuration(durationMs)}).${hint}`,
        );
      }

      if (action === "list") {
        const running = (await listGiveaways()).filter((g) => g.state === "running");
        if (running.length === 0) return ctx.reply("No giveaways are running.");
        const lines = await Promise.all(
          running.map(async (g) => `#${g.id} · **${g.prize}** · ${g.winner_count} winner(s) · ${await entryCount(g.id)} entries · ends ${formatUtc(g.ends_at)}`),
        );
        return ctx.reply(`**Running giveaways**\n${lines.join("\n")}`);
      }

      const id = Number(ctx.args.word());
      if (!Number.isInteger(id)) throw new UsageError("Give the giveaway number. See `giveaway list`.");

      if (action === "end") {
        const result = await endGiveaway(id);
        if (typeof result === "string") return ctx.reply(`❌ ${result}`);
        return ctx.reply(`✅ Giveaway #${id} ended with ${winnersOf(result).length} winner(s).`);
      }
      if (action === "reroll") {
        const raw = ctx.args.word();
        const count = raw === undefined ? 1 : parseWinnerCount(raw);
        if (count === undefined) throw new UsageError(`Reroll 1 to ${MAX_WINNERS} winners.`);
        const result = await rerollGiveaway(id, count);
        // The reroll announcement itself is the reply.
        if (typeof result === "string") return ctx.reply(`❌ ${result}`);
        return;
      }
      if (action === "cancel" || action === "delete") {
        const result = await cancelGiveaway(id);
        if (typeof result === "string") return ctx.reply(`❌ ${result}`);
        return ctx.reply(`🗑️ Giveaway #${id} cancelled.`);
      }
      throw new UsageError();
    },
  });
}
