import { JobInterval, UserGuid } from "@rootsdk/server-app";
import { Args } from "../commands/parse";
import { register, UsageError } from "../commands/registry";
import { all, get, run } from "../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce, scheduleRepeating } from "../jobs";
import { log, errMessage } from "../lib/log";
import { formatUtc, parseWhen } from "../lib/time";
import { channelMention, truncate, userMention } from "../lib/text";
import { nicknameOf } from "../members";
import { send } from "../messaging";
import { Level } from "../permissions";
import { notifyChange } from "../services/changes";

export interface Reminder {
  id: number;
  user_id: string;
  channel_id: string;
  message: string;
  due_at: number;
}

export interface Announcement {
  id: number;
  channel_id: string;
  message: string;
  next_at: number;
  repeat: Repeat;
  job_id: string | null;
}

export type Repeat = "once" | "daily" | "weekly" | "monthly";

const MAX_REMINDERS_PER_MEMBER = 25;
const REPEAT_INTERVAL: Record<Exclude<Repeat, "once">, JobInterval> = {
  daily: JobInterval.Daily,
  weekly: JobInterval.Weekly,
  monthly: JobInterval.Monthly,
};

/** Reads "2h", "2026-10-01T18:00", or "2026-10-01 18:00" (two tokens). */
function takeWhen(args: Args): Date | undefined {
  const first = args.peek();
  if (first?.kind !== "word") return undefined;
  let when = parseWhen(first.text);
  if (when) {
    args.next();
    return when;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(first.text)) {
    args.next();
    const time = args.word();
    when = time ? parseWhen(`${first.text} ${time}`) : undefined;
  }
  return when;
}

function nextOccurrence(from: number, repeat: Repeat): number {
  const d = new Date(from);
  if (repeat === "daily") d.setUTCDate(d.getUTCDate() + 1);
  else if (repeat === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (repeat === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// --- Firing ------------------------------------------------------------------

async function fireReminder(id: number): Promise<void> {
  const r = await get<Reminder>("SELECT * FROM reminders WHERE id = ?", [id]);
  if (!r) return;
  // Delete first: if posting fails, a missed reminder beats a repeated one.
  await run("DELETE FROM reminders WHERE id = ?", [id]);
  notifyChange("reminders");
  const late = Date.now() - r.due_at > 5 * 60_000 ? ` (late: was due ${formatUtc(r.due_at)})` : "";
  const mention = userMention(await nicknameOf(r.user_id as UserGuid), r.user_id);
  await send(r.channel_id, `⏰ ${mention}, reminder${late}: ${r.message}`);
}

async function fireAnnouncement(id: number): Promise<void> {
  const a = await get<Announcement>("SELECT * FROM announcements WHERE id = ?", [id]);
  if (!a) return;
  // A job can arrive twice (live + missed replay); skip if this run already happened.
  if (a.next_at > Date.now() + 2 * 60_000) return;
  if (a.repeat === "once") await run("DELETE FROM announcements WHERE id = ?", [id]);
  else {
    let next = nextOccurrence(a.next_at, a.repeat);
    while (next <= Date.now()) next = nextOccurrence(next, a.repeat);
    await run("UPDATE announcements SET next_at = ? WHERE id = ?", [next, id]);
  }
  notifyChange("announcements");
  await send(a.channel_id, a.message);
}

async function reconcile(): Promise<void> {
  for (const r of await all<Reminder>("SELECT * FROM reminders")) {
    if (r.due_at <= Date.now()) await fireReminder(r.id).catch((err) => log("warn", "late reminder failed", { error: errMessage(err) }));
    else if (!(await hasJob("remind", r.id))) await scheduleOnce("remind", r.id, r.due_at);
  }
  for (const a of await all<Announcement>("SELECT * FROM announcements")) {
    if (await hasJob("announce", a.id)) continue;
    if (a.repeat === "once") {
      if (a.next_at <= Date.now()) await fireAnnouncement(a.id);
      else await scheduleOnce("announce", a.id, a.next_at);
    } else {
      const jobId = await scheduleRepeating("announce", a.id, new Date(a.next_at), REPEAT_INTERVAL[a.repeat]);
      await run("UPDATE announcements SET job_id = ? WHERE id = ?", [jobId, a.id]);
    }
  }
}

// --- Shared with the GUI ------------------------------------------------------

export async function listReminders(userId: string): Promise<Reminder[]> {
  return all<Reminder>("SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at", [userId]);
}

/** Cancels one of the member's own reminders. False if they have no such reminder. */
export async function cancelReminder(id: number, userId: string): Promise<boolean> {
  const { changes } = await run("DELETE FROM reminders WHERE id = ? AND user_id = ?", [id, userId]);
  if (!changes) return false;
  notifyChange("reminders");
  await cancelJobs("remind", id);
  return true;
}

export async function listAnnouncements(): Promise<Announcement[]> {
  return all<Announcement>("SELECT * FROM announcements ORDER BY next_at");
}

/**
 * Schedules an announcement. A one-time announcement must be at least a
 * minute away; a repeating start in the past means "at this time of
 * day/week/month", so it moves to the next occurrence. Returns why it was
 * refused, or the new ID and the (possibly moved) first time.
 */
export async function createAnnouncement(
  channelId: string,
  message: string,
  when: Date,
  repeat: Repeat,
  authorId: string,
): Promise<{ problem: string } | { id: number; at: Date }> {
  const at = new Date(when.getTime());
  if (repeat === "once" && at.getTime() < Date.now() + 60_000) return { problem: "Pick a time at least a minute away." };
  if (repeat !== "once") {
    while (at.getTime() < Date.now() + 60_000) at.setTime(nextOccurrence(at.getTime(), repeat));
  }
  const { lastID } = await run(
    "INSERT INTO announcements (channel_id, message, next_at, repeat, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [channelId, message, at.getTime(), repeat, authorId, Date.now()],
  );
  const jobId =
    repeat === "once" ? await scheduleOnce("announce", lastID, at) : await scheduleRepeating("announce", lastID, at, REPEAT_INTERVAL[repeat]);
  await run("UPDATE announcements SET job_id = ? WHERE id = ?", [jobId, lastID]);
  notifyChange("announcements");
  return { id: lastID, at };
}

export async function deleteAnnouncement(id: number): Promise<boolean> {
  const { changes } = await run("DELETE FROM announcements WHERE id = ?", [id]);
  if (!changes) return false;
  notifyChange("announcements");
  await cancelJobs("announce", id);
  return true;
}

// --- Commands ----------------------------------------------------------------

export function registerReminders(): void {
  onJob("remind", fireReminder);
  onJob("announce", fireAnnouncement);
  onReconcile(reconcile);

  register(
    {
      name: "remind",
      aliases: ["remindme"],
      category: "Reminders",
      level: Level.Member,
      usage: "<when> <message>",
      description: "Get pinged in this channel later. `when` is like 30m, 2h, 1d, or 2026-10-01 18:00 (UTC).",
      details: ["Reminders fire within about a minute of the time asked.", "See and cancel yours with `reminders`."],
      async run(ctx) {
        const when = takeWhen(ctx.args);
        const message = ctx.args.rest();
        if (!when || !message) throw new UsageError();
        if (when.getTime() < Date.now() + 60_000) return ctx.reply("❌ Pick a time at least a minute away.");
        const count = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?", [ctx.authorId]))?.n ?? 0;
        if (count >= MAX_REMINDERS_PER_MEMBER) return ctx.reply(`❌ You already have ${count} reminders. Cancel some first.`);
        const { lastID } = await run(
          "INSERT INTO reminders (user_id, channel_id, message, due_at, created_at) VALUES (?, ?, ?, ?, ?)",
          [ctx.authorId, ctx.channelId, truncate(message, 1500), when.getTime(), Date.now()],
        );
        await scheduleOnce("remind", lastID, when);
        notifyChange("reminders");
        await ctx.reply(`⏰ Got it. I'll remind you at ${formatUtc(when)} (reminder #${lastID}).`);
      },
    },
    {
      name: "reminders",
      category: "Reminders",
      level: Level.Member,
      usage: "[cancel <number>]",
      description: "List your reminders, or cancel one.",
      async run(ctx) {
        if (ctx.args.word() === "cancel") {
          const id = Number(ctx.args.word());
          const changes = await cancelReminder(id, ctx.authorId);
          return ctx.reply(changes ? `🗑️ Reminder #${id} cancelled.` : "❌ You don't have a reminder with that number.");
        }
        const list = await listReminders(ctx.authorId);
        if (list.length === 0) return ctx.reply("You have no reminders.");
        await ctx.reply(list.map((r) => `#${r.id} · ${formatUtc(r.due_at)} · ${truncate(r.message, 80)}`).join("\n"));
      },
    },
    {
      name: "announce",
      aliases: ["say"],
      category: "Reminders",
      level: Level.Moderator,
      usage: "#channel <message>",
      description: "Post a message as Taproot in a channel.",
      async run(ctx) {
        const channel = ctx.args.mention("channel");
        const message = ctx.args.rest();
        if (!channel?.id || !message) throw new UsageError();
        await send(channel.id, message);
        if (channel.id !== ctx.channelId) await ctx.reply(`📣 Posted in ${channel.text}.`);
      },
    },
    {
      name: "schedule",
      category: "Reminders",
      level: Level.Moderator,
      usage: "#channel <when> [daily|weekly|monthly] <message> | list | remove <number>",
      description: "Schedule an announcement, once or repeating. Times are UTC.",
      details: [
        "`schedule #events 2026-10-03 19:00 weekly Game night starts now!`",
        "`schedule #general 2h Stream starts in 5 minutes`",
      ],
      async run(ctx) {
        const first = ctx.args.peek();
        if (first?.kind === "word" && first.text.toLowerCase() === "list") {
          const list = await listAnnouncements();
          if (list.length === 0) return ctx.reply("No scheduled announcements.");
          return ctx.reply(
            list
              .map((a) => `#${a.id} · ${channelMention("channel", a.channel_id)} · next ${formatUtc(a.next_at)} · ${a.repeat} · ${truncate(a.message, 60)}`)
              .join("\n"),
          );
        }
        if (first?.kind === "word" && first.text.toLowerCase() === "remove") {
          ctx.args.next();
          const id = Number(ctx.args.word());
          const changes = await deleteAnnouncement(id);
          return ctx.reply(changes ? `🗑️ Announcement #${id} removed.` : "❌ No announcement with that number.");
        }

        const channel = ctx.args.mention("channel");
        if (!channel?.id) throw new UsageError("Mention the channel first.");
        const when = takeWhen(ctx.args);
        if (!when) throw new UsageError("I couldn't read the time.");
        const maybeRepeat = ctx.args.peek();
        let repeat: Repeat = "once";
        if (maybeRepeat?.kind === "word" && ["daily", "weekly", "monthly"].includes(maybeRepeat.text.toLowerCase())) {
          repeat = maybeRepeat.text.toLowerCase() as Repeat;
          ctx.args.next();
        }
        const message = ctx.args.rest();
        if (!message) throw new UsageError("Add the message.");
        const result = await createAnnouncement(channel.id, message, when, repeat, ctx.authorId);
        if ("problem" in result) return ctx.reply(`❌ ${result.problem}`);
        const label = repeat === "once" ? `at ${formatUtc(result.at)}` : `${repeat}, starting ${formatUtc(result.at)}`;
        await ctx.reply(`📅 Announcement #${result.id} scheduled in ${channel.text} ${label}.`);
      },
    },
  );
}
