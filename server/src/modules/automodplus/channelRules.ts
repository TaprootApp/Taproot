import {
  rootServer,
  ChannelGuid,
  ChannelMessage,
  ChannelMessageCreatedEvent,
  ChannelMessageEvent,
  MessageDirectionTake,
  MessageType,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { register, UsageError } from "../../commands/registry";
import { all, get, run } from "../../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { read } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { channelMention, userMention } from "../../lib/text";
import { formatDuration, formatUtc, parseDuration } from "../../lib/time";
import { nicknameOf } from "../../members";
import { deleteMessage, sendEphemeral } from "../../messaging";
import { createCase } from "../../modlog";
import { Level, levelOf } from "../../permissions";
import { addMessageFilter, addMessageListener } from "../../pipeline";
import { notifyChange } from "../../services/changes";
import { settings } from "../../settings";
import { ALLOW_TYPES, AllowType, checkInt, LIMITS } from "./config";
import { ALLOW_LABELS, formatDailyTime, matchesAllowType, nextPurgeAt, parseDailyTime, PurgeSchedule, SlowmodeTracker } from "./logic";
import { AREA, plusConfig, updatePlus } from "./state";

// Per-channel rules (Dyno's Auto Delete, Auto Purge and premium Slowmode).
//
//   - Auto delete: a message filter removes messages that aren't the
//     channel's allowed type; a listener queues every message for deletion N
//     minutes later, and one job at a time sweeps the queue.
//   - Slowmode: Root has none, so too-fast messages are deleted with a short
//     notice. Staff are exempt. The last-message times live in memory.
//   - Auto purge: scheduled full-channel purges, run like !purge (list, then
//     delete one at a time through the shared rate limiter).

const EXPIRE_KIND = "automodplusExpire";
const PURGE_KIND = "automodplusPurge";

// --- Shared helpers -----------------------------------------------------------

const staffCache = new Map<string, { at: number; staff: boolean }>();
const STAFF_TTL = 60_000;

async function isStaff(userId: UserGuid): Promise<boolean> {
  const cached = staffCache.get(userId);
  if (cached && Date.now() - cached.at < STAFF_TTL) return cached.staff;
  const staff = (await levelOf(userId)) >= Level.Moderator;
  if (staffCache.size > 5000) staffCache.clear();
  staffCache.set(userId, { at: Date.now(), staff });
  return staff;
}

function isPerson(userId: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(userId) === RootGuidType.Person;
  } catch {
    return false;
  }
}

// One notice per member per channel per window, so a burst doesn't flood.
const lastNotice = new Map<string, number>();
const NOTICE_WINDOW = 20_000;

function notice(channelId: string, userId: string, text: string): void {
  const key = `${channelId}:${userId}`;
  const now = Date.now();
  if (now - (lastNotice.get(key) ?? 0) < NOTICE_WINDOW) return;
  lastNotice.set(key, now);
  if (lastNotice.size > 5000) {
    for (const [k, at] of lastNotice) if (now - at > NOTICE_WINDOW) lastNotice.delete(k);
  }
  sendEphemeral(channelId, text, 6000);
}

async function mentionOf(userId: UserGuid): Promise<string> {
  return userMention(await nicknameOf(userId), userId);
}

// --- Slowmode -----------------------------------------------------------------

const slowmode = new SlowmodeTracker();

async function slowmodeFilter(evt: ChannelMessageCreatedEvent): Promise<boolean> {
  const rule = plusConfig().slowmode.find((r) => r.channelId === evt.channelId);
  if (!rule || !isPerson(evt.userId)) return false;
  if (await isStaff(evt.userId)) return false;
  const wait = slowmode.check(evt.channelId, evt.userId, Date.now(), rule.seconds);
  if (wait === 0) return false;
  await deleteMessage(evt.channelId, evt.id).catch((err) => log("warn", "slowmode delete failed", { error: errMessage(err) }));
  notice(evt.channelId, evt.userId, `🐢 ${await mentionOf(evt.userId)}, this channel has slowmode: wait ${formatDuration(wait * 1000)} between messages.`);
  return true;
}

// --- Auto delete: allowed types -------------------------------------------------

async function autoDeleteFilter(evt: ChannelMessageCreatedEvent): Promise<boolean> {
  const rule = plusConfig().autoDelete.find((r) => r.channelId === evt.channelId);
  if (!rule || rule.allow === "any" || !isPerson(evt.userId)) return false;
  const msg = { content: evt.messageContent ?? "", uris: evt.messageUris };
  if (matchesAllowType(msg, rule.allow, settings().prefix)) return false;
  if (rule.exemptStaff && (await isStaff(evt.userId))) return false;
  await deleteMessage(evt.channelId, evt.id).catch((err) => log("warn", "auto delete failed", { error: errMessage(err) }));
  notice(evt.channelId, evt.userId, `🧹 ${await mentionOf(evt.userId)}, this channel is for ${ALLOW_LABELS[rule.allow]}.`);
  return true;
}

// --- Auto delete: timed -------------------------------------------------------

// The queue is capped so a busy channel with a short timer can't grow it
// without bound; past the cap new messages simply aren't queued (logged once).
const MAX_QUEUED = 20_000;
const SWEEP_BATCH = 250;
let sweepAt: number | undefined;
let sweeping = false;
let capWarned = false;

async function queueExpiry(evt: ChannelMessageCreatedEvent): Promise<void> {
  const rule = plusConfig().autoDelete.find((r) => r.channelId === evt.channelId);
  if (!rule || rule.deleteAfterMinutes <= 0 || evt.messageType === MessageType.System) return;
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM automodplus_expiring");
  if ((row?.n ?? 0) >= MAX_QUEUED) {
    if (!capWarned) log("warn", "auto delete queue is full; new messages aren't queued");
    capWarned = true;
    return;
  }
  capWarned = false;
  const deleteAt = Date.now() + rule.deleteAfterMinutes * 60_000;
  await run("INSERT OR IGNORE INTO automodplus_expiring (message_id, channel_id, delete_at) VALUES (?, ?, ?)", [
    evt.id,
    evt.channelId,
    deleteAt,
  ]);
  await ensureSweep(deleteAt);
}

/** Keeps one sweep job scheduled at (or before) the earliest queued deletion. */
async function ensureSweep(dueAt: number): Promise<void> {
  if (sweepAt !== undefined && sweepAt <= dueAt + 60_000) return;
  sweepAt = dueAt;
  try {
    await cancelJobs(EXPIRE_KIND, 0);
    await scheduleOnce(EXPIRE_KIND, 0, dueAt);
  } catch (err) {
    sweepAt = undefined;
    log("warn", "scheduling the auto delete sweep failed", { error: errMessage(err) });
  }
}

async function sweepExpired(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  sweepAt = undefined;
  try {
    const due = await all<{ message_id: string; channel_id: string }>(
      "SELECT message_id, channel_id FROM automodplus_expiring WHERE delete_at <= ? ORDER BY delete_at LIMIT ?",
      [Date.now() + 30_000, SWEEP_BATCH],
    );
    for (const row of due) {
      await deleteMessage(row.channel_id, row.message_id).catch(() => undefined);
      await run("DELETE FROM automodplus_expiring WHERE message_id = ?", [row.message_id]);
    }
    // Rules removed since the message was queued: drop what they'd have deleted.
    const channels = plusConfig()
      .autoDelete.filter((r) => r.deleteAfterMinutes > 0)
      .map((r) => r.channelId);
    await run(
      `DELETE FROM automodplus_expiring WHERE channel_id NOT IN (${channels.map(() => "?").join(",") || "''"})`,
      channels,
    );
    const next = await get<{ at: number | null }>("SELECT MIN(delete_at) AS at FROM automodplus_expiring");
    if (next?.at != null) await ensureSweep(due.length === SWEEP_BATCH ? Date.now() : next.at);
  } finally {
    sweeping = false;
  }
}

async function unqueue(messageId: string): Promise<void> {
  await run("DELETE FROM automodplus_expiring WHERE message_id = ?", [messageId]);
}

// --- Auto purge ---------------------------------------------------------------

export interface PurgeRow {
  id: number;
  channel_id: string;
  mode: "interval" | "daily";
  every_hours: number;
  daily_minute: number;
  keep_pinned: number;
  next_at: number;
  last_run_at: number | null;
  last_deleted: number | null;
  created_by: string;
  created_at: number;
}

const PURGE_CAP = 1000;
const PURGE_SCAN_LIMIT = 3000;
const running = new Set<number>();

function scheduleOf(row: PurgeRow): PurgeSchedule {
  return { mode: row.mode, everyHours: row.every_hours, dailyMinute: row.daily_minute };
}

export async function listPurges(): Promise<PurgeRow[]> {
  return all<PurgeRow>("SELECT * FROM automodplus_purges ORDER BY id");
}

export function describePurge(row: Pick<PurgeRow, "mode" | "every_hours" | "daily_minute" | "keep_pinned">): string {
  const when = row.mode === "daily" ? `daily at ${formatDailyTime(row.daily_minute)}` : `every ${row.every_hours}h`;
  return `${when}${row.keep_pinned ? ", keeping pinned messages" : ""}`;
}

/** Deletes messages older than `before`, newest first, up to the cap. */
async function purgeChannel(channelId: string, before: Date, keepPinned: boolean): Promise<{ deleted: number; more: boolean }> {
  const targets: ChannelMessage[] = [];
  let dateAt = before;
  let scanned = 0;
  let more = false;
  while (scanned < PURGE_SCAN_LIMIT) {
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
    for (const msg of [...page.messages].reverse()) {
      if (msg.messageType === MessageType.System || (keepPinned && msg.pinnedAt)) continue;
      if (targets.length >= PURGE_CAP) {
        more = true;
        break;
      }
      targets.push(msg);
    }
    if (more || page.oldCount === 0) break;
    dateAt = new Date(RootGuidUtils.toMilliseconds(page.messages[0].id));
  }
  let deleted = 0;
  for (const msg of targets) {
    try {
      await deleteMessage(channelId, msg.id);
      deleted++;
    } catch {
      // Already gone or not deletable: keep going.
    }
  }
  return { deleted, more: more || scanned >= PURGE_SCAN_LIMIT };
}

async function schedulePurge(row: Pick<PurgeRow, "id" | "next_at">): Promise<void> {
  try {
    await cancelJobs(PURGE_KIND, row.id);
    await scheduleOnce(PURGE_KIND, row.id, row.next_at);
  } catch (err) {
    // Reconcile picks it up later.
    log("warn", "scheduling an auto purge failed", { id: row.id, error: errMessage(err) });
  }
}

export async function runPurge(id: number): Promise<number | undefined> {
  if (running.has(id)) return undefined;
  const row = await get<PurgeRow>("SELECT * FROM automodplus_purges WHERE id = ?", [id]);
  if (!row) return undefined;
  running.add(id);
  try {
    const startedAt = Date.now();
    const { deleted, more } = await purgeChannel(row.channel_id, new Date(startedAt), row.keep_pinned === 1);
    // A capped run continues shortly; otherwise the next scheduled time.
    const nextAt = more ? Date.now() + 5 * 60_000 : nextPurgeAt(scheduleOf(row), Date.now(), startedAt);
    await run("UPDATE automodplus_purges SET last_run_at = ?, last_deleted = ?, next_at = ? WHERE id = ?", [
      startedAt,
      deleted,
      nextAt,
      id,
    ]);
    await schedulePurge({ id, next_at: nextAt });
    notifyChange(AREA.channels);
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: row.channel_id as ChannelGuid })).catch(
      () => undefined,
    );
    await createCase({
      action: "purge",
      userId: row.channel_id,
      userName: channel ? channelMention(channel.name, channel.id) : channelMention("channel", row.channel_id),
      reason: `Auto purge #${id}: ${deleted} message(s)${more ? " (more to go)" : ""}`,
    });
    return deleted;
  } finally {
    running.delete(id);
  }
}

export async function savePurge(input: {
  id?: number;
  channelId: string;
  schedule: PurgeSchedule;
  keepPinned: boolean;
  userId: string;
}): Promise<number> {
  const now = Date.now();
  const nextAt = nextPurgeAt(input.schedule, now, null);
  let id = input.id;
  if (id) {
    await run(
      "UPDATE automodplus_purges SET channel_id = ?, mode = ?, every_hours = ?, daily_minute = ?, keep_pinned = ?, next_at = ? WHERE id = ?",
      [input.channelId, input.schedule.mode, input.schedule.everyHours, input.schedule.dailyMinute, input.keepPinned ? 1 : 0, nextAt, id],
    );
  } else {
    const count = await get<{ n: number }>("SELECT COUNT(*) AS n FROM automodplus_purges");
    if ((count?.n ?? 0) >= LIMITS.purges) throw new UsageError(`At most ${LIMITS.purges} auto purges.`);
    const result = await run(
      `INSERT INTO automodplus_purges (channel_id, mode, every_hours, daily_minute, keep_pinned, next_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.channelId, input.schedule.mode, input.schedule.everyHours, input.schedule.dailyMinute, input.keepPinned ? 1 : 0, nextAt, input.userId, now],
    );
    id = result.lastID;
  }
  await schedulePurge({ id, next_at: nextAt });
  notifyChange(AREA.channels);
  return id;
}

export async function deletePurge(id: number): Promise<boolean> {
  const { changes } = await run("DELETE FROM automodplus_purges WHERE id = ?", [id]);
  await cancelJobs(PURGE_KIND, id).catch(() => undefined);
  if (changes > 0) notifyChange(AREA.channels);
  return changes > 0;
}

// --- Commands -----------------------------------------------------------------

/** "30", "30s", "2m", "1h" -> seconds. */
function parseSeconds(text: string | undefined): number | undefined {
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const ms = parseDuration(text);
  return ms === undefined ? undefined : Math.round(ms / 1000);
}

function registerCommands(): void {
  register(
    {
      name: "slowmode",
      category: "Auto-mod",
      level: Level.Moderator,
      usage: "[#channel] <seconds | 2m | off>",
      description: "Make members wait between messages in a channel. Staff are exempt.",
      details: [
        "Root has no built-in slowmode, so messages sent too soon are deleted with a short notice.",
        "`slowmode` on its own lists the channels that have it.",
      ],
      async run(ctx) {
        const channel = ctx.args.mention("channel");
        const value = ctx.args.word();
        if (!channel && !value) {
          const list = plusConfig().slowmode;
          if (list.length === 0) return ctx.reply("No channels have slowmode.");
          return ctx.reply(
            ["**Slowmode**", ...list.map((r) => `${channelMention("channel", r.channelId)} · ${formatDuration(r.seconds * 1000)}`)].join("\n"),
          );
        }
        const channelId = channel?.id ?? ctx.channelId;
        const label = channel?.text ?? "this channel";
        if (value === "off" || value === "0") {
          await updatePlus(AREA.channels, (p) => (p.slowmode = p.slowmode.filter((r) => r.channelId !== channelId)));
          return ctx.reply(`✅ Slowmode is off in ${label}.`);
        }
        const seconds = parseSeconds(value);
        const err = checkInt(seconds, LIMITS.slowmodeSeconds, "Slowmode seconds");
        if (err || seconds === undefined) throw new UsageError(err);
        const existing = plusConfig().slowmode;
        if (!existing.some((r) => r.channelId === channelId) && existing.length >= LIMITS.channelRules) {
          throw new UsageError(`At most ${LIMITS.channelRules} slowmode channels.`);
        }
        await updatePlus(AREA.channels, (p) => {
          p.slowmode = [...p.slowmode.filter((r) => r.channelId !== channelId), { channelId, seconds }];
        });
        await ctx.reply(`🐢 Slowmode in ${label}: one message every ${formatDuration(seconds * 1000)}.`);
      },
    },
    {
      name: "autodelete",
      category: "Auto-mod",
      level: Level.Admin,
      usage: "[#channel <type> | #channel after <duration|off> | #channel off]",
      description: "Delete messages that aren't the right type, or every message after a while.",
      details: [
        `Types: ${ALLOW_TYPES.join(", ")}. \`autodelete #art images\` keeps #art for pictures; \`any\` removes the type rule.`,
        "`autodelete #lfg after 1h` deletes every message an hour after it's posted. Pinned messages are kept.",
        "`autodelete #channel off` removes both. Staff are exempt from type rules.",
      ],
      async run(ctx) {
        const channel = ctx.args.mention("channel");
        if (!channel?.id) {
          const list = plusConfig().autoDelete;
          if (list.length === 0) return ctx.reply("No auto delete rules.");
          return ctx.reply(
            [
              "**Auto delete**",
              ...list.map(
                (r) =>
                  `${channelMention("channel", r.channelId)} · ${ALLOW_LABELS[r.allow]}${
                    r.deleteAfterMinutes ? ` · deleted after ${formatDuration(r.deleteAfterMinutes * 60_000)}` : ""
                  }`,
              ),
            ].join("\n"),
          );
        }
        const channelId = channel.id;
        const word = ctx.args.word();
        const current = plusConfig().autoDelete.find((r) => r.channelId === channelId) ?? {
          channelId,
          allow: "any" as AllowType,
          deleteAfterMinutes: 0,
          exemptStaff: true,
        };
        const next = { ...current };
        if (word === "off") {
          await updatePlus(AREA.channels, (p) => (p.autoDelete = p.autoDelete.filter((r) => r.channelId !== channelId)));
          return ctx.reply(`✅ Auto delete is off in ${channel.text}.`);
        } else if (word === "after") {
          const value = ctx.args.word();
          if (value === "off") next.deleteAfterMinutes = 0;
          else {
            const ms = value ? parseDuration(value) : undefined;
            const minutes = ms === undefined ? NaN : Math.round(ms / 60_000);
            const err = checkInt(minutes, [1, LIMITS.deleteAfterMinutes[1]], "The delay in minutes");
            if (err) throw new UsageError(err);
            next.deleteAfterMinutes = minutes;
          }
        } else if (word && (ALLOW_TYPES as readonly string[]).includes(word)) {
          next.allow = word as AllowType;
        } else throw new UsageError();

        const list = plusConfig().autoDelete;
        if (!list.some((r) => r.channelId === channelId) && list.length >= LIMITS.channelRules) {
          throw new UsageError(`At most ${LIMITS.channelRules} auto delete channels.`);
        }
        await updatePlus(AREA.channels, (p) => {
          const rest = p.autoDelete.filter((r) => r.channelId !== channelId);
          p.autoDelete = next.allow === "any" && next.deleteAfterMinutes === 0 ? rest : [...rest, next];
        });
        const parts = [`allows ${ALLOW_LABELS[next.allow]}`];
        if (next.deleteAfterMinutes) parts.push(`deletes messages after ${formatDuration(next.deleteAfterMinutes * 60_000)}`);
        await ctx.reply(`✅ ${channel.text} ${parts.join(" and ")}.`);
      },
    },
    {
      name: "autopurge",
      category: "Auto-mod",
      level: Level.Admin,
      usage: "[add #channel every <hours>h | add #channel daily <HH:MM> | remove <id> | run <id>]",
      description: "Purge a channel on a schedule. Pinned messages are kept.",
      details: [
        "`autopurge add #memes every 12h` or `autopurge add #lfg daily 04:00` (UTC).",
        `Each run deletes up to ${PURGE_CAP} messages, one at a time; a bigger backlog continues a few minutes later.`,
        "`autopurge` lists them with their IDs.",
      ],
      async run(ctx) {
        const action = ctx.args.word();
        if (!action || action === "list") {
          const rows = await listPurges();
          if (rows.length === 0) return ctx.reply("No auto purges.");
          return ctx.reply(
            [
              "**Auto purges**",
              ...rows.map(
                (r) =>
                  `**#${r.id}** ${channelMention("channel", r.channel_id)} · ${describePurge(r)} · next ${formatUtc(r.next_at)}${
                    r.last_run_at ? ` · last deleted ${r.last_deleted ?? 0}` : ""
                  }`,
              ),
            ].join("\n"),
          );
        }
        if (action === "add") {
          const channel = ctx.args.mention("channel");
          if (!channel?.id) throw new UsageError("Mention a channel.");
          const mode = ctx.args.word();
          const value = ctx.args.word();
          let schedule: PurgeSchedule;
          if (mode === "every") {
            const hours = Number(value?.replace(/h$/, ""));
            const err = checkInt(hours, LIMITS.purgeEveryHours, "Hours");
            if (err) throw new UsageError(err);
            schedule = { mode: "interval", everyHours: hours, dailyMinute: 0 };
          } else if (mode === "daily") {
            const minute = value ? parseDailyTime(value) : undefined;
            if (minute === undefined) throw new UsageError("Give a UTC time like 04:00.");
            schedule = { mode: "daily", everyHours: 24, dailyMinute: minute };
          } else throw new UsageError();
          const id = await savePurge({ channelId: channel.id, schedule, keepPinned: true, userId: ctx.authorId });
          const row = await get<PurgeRow>("SELECT * FROM automodplus_purges WHERE id = ?", [id]);
          return ctx.reply(`🧹 Auto purge #${id}: ${channel.text} ${describePurge(row!)}. First run ${formatUtc(row!.next_at)}.`);
        }
        const id = Number(ctx.args.word());
        if (!Number.isInteger(id)) throw new UsageError("Give the auto purge's number (see `autopurge`).");
        if (action === "remove") {
          return ctx.reply((await deletePurge(id)) ? `✅ Auto purge #${id} removed.` : "❌ No auto purge with that number.");
        }
        if (action === "run") {
          if (!(await get("SELECT 1 FROM automodplus_purges WHERE id = ?", [id]))) return ctx.reply("❌ No auto purge with that number.");
          await ctx.reply(`🧹 Running auto purge #${id}…`);
          const deleted = await runPurge(id);
          if (deleted === undefined) return ctx.reply("That purge is already running.");
          return ctx.reply(`🧹 Auto purge #${id} deleted ${deleted} message(s).`);
        }
        throw new UsageError();
      },
    },
  );
}

// --- Setup --------------------------------------------------------------------

export async function initChannelRules(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS automodplus_expiring (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    delete_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_automodplus_expiring ON automodplus_expiring (delete_at)`);
  await run(`CREATE TABLE IF NOT EXISTS automodplus_purges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    every_hours INTEGER NOT NULL DEFAULT 24,
    daily_minute INTEGER NOT NULL DEFAULT 0,
    keep_pinned INTEGER NOT NULL DEFAULT 1,
    next_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_deleted INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // Slowmode runs before auto delete: a too-fast message is gone either way.
  addMessageFilter("automodplus:slowmode", slowmodeFilter, 60);
  addMessageFilter("automodplus:autodelete", autoDeleteFilter, 50);
  addMessageListener("automodplus:expire", queueExpiry);

  const messages = rootServer.community.channelMessages;
  messages.on(ChannelMessageEvent.ChannelMessagePinCreated, (evt) => {
    unqueue(evt.messageId).catch(() => undefined);
  });
  messages.on(ChannelMessageEvent.ChannelMessageDeleted, (evt) => {
    unqueue(evt.id).catch(() => undefined);
  });

  onJob(EXPIRE_KIND, () => sweepExpired());
  onJob(PURGE_KIND, async (id) => {
    await runPurge(id);
  });
  // Catch-up work runs in the background: deleting takes a while at Root's
  // rate limit, and other features' reconcile steps shouldn't wait on it.
  onReconcile(async () => {
    sweepExpired().catch((err) => log("warn", "auto delete sweep failed", { error: errMessage(err) }));
    for (const row of await all<PurgeRow>("SELECT * FROM automodplus_purges")) {
      if (row.next_at < Date.now() - 120_000) {
        runPurge(row.id).catch((err) => log("warn", "overdue auto purge failed", { id: row.id, error: errMessage(err) }));
      } else if (!(await hasJob(PURGE_KIND, row.id))) {
        await schedulePurge(row);
      }
    }
  });

  setInterval(() => {
    const max = Math.max(0, ...plusConfig().slowmode.map((r) => r.seconds));
    slowmode.prune(Date.now(), max);
  }, 60_000).unref();

  registerCommands();
}
