import { ChannelMessageCreatedEvent, UserGuid } from "@rootsdk/server-app";
import { all, run } from "../../db";
import { register } from "../../commands/registry";
import { log, errMessage } from "../../lib/log";
import { formatDuration } from "../../lib/time";
import { nicknameOf } from "../../members";
import { reply, sendEphemeral } from "../../messaging";
import { Level } from "../../permissions";
import { addMessageListener } from "../../pipeline";
import { notifyChange } from "../../services/changes";
import { AFK_NOTICE_WINDOW_MS, cleanAfkMessage, Cooldowns } from "./logic";
import { isBot } from "./shared";

// AFK: a member sets a note; when someone mentions them (or replies to them)
// Taproot answers with the note, at most once per channel every couple of
// minutes; the note clears the next time they post anywhere.

export interface AfkRow {
  user_id: string;
  message: string;
  since: number;
  /** The "afk" command message itself, which mustn't clear the status. */
  set_message_id: string | null;
}

/** Change area; notifications carry the member, as "utility:afk:<userId>". */
export const AFK_AREA = "utility:afk";
const afk = new Map<string, AfkRow>();
const notices = new Cooldowns();

export async function initAfk(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS utility_afk (
    user_id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    since INTEGER NOT NULL,
    set_message_id TEXT
  )`);
  for (const row of await all<AfkRow>("SELECT * FROM utility_afk")) afk.set(row.user_id, row);
  registerAfkCommand();
  addMessageListener("utility:afk", onMessage);
}

export async function afkOf(userId: string): Promise<AfkRow | undefined> {
  return afk.get(userId);
}

export async function setAfk(userId: string, message: string, setMessageId?: string): Promise<AfkRow> {
  const row: AfkRow = { user_id: userId, message: cleanAfkMessage(message), since: Date.now(), set_message_id: setMessageId ?? null };
  await run(
    `INSERT INTO utility_afk (user_id, message, since, set_message_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET message = excluded.message, since = excluded.since, set_message_id = excluded.set_message_id`,
    [row.user_id, row.message, row.since, row.set_message_id],
  );
  afk.set(userId, row);
  notifyChange(`${AFK_AREA}:${userId}`);
  return row;
}

export async function clearAfk(userId: string): Promise<AfkRow | undefined> {
  const row = afk.get(userId);
  if (!row) return undefined;
  afk.delete(userId);
  await run("DELETE FROM utility_afk WHERE user_id = ?", [userId]);
  notifyChange(`${AFK_AREA}:${userId}`);
  return row;
}

function registerAfkCommand(): void {
  register({
    name: "afk",
    category: "Utility",
    level: Level.Member,
    usage: "[message]",
    description: "Mark yourself away. Anyone who mentions you gets your message; it clears when you next post.",
    details: ["`afk grabbing lunch, back at 2`"],
    async run(ctx) {
      const row = await setAfk(ctx.authorId, ctx.args.rest(), ctx.messageId);
      await ctx.reply(`💤 You're now AFK: ${row.message}`);
    },
  });
}

async function onMessage(evt: ChannelMessageCreatedEvent): Promise<void> {
  if (afk.size === 0 || isBot(evt.userId)) return;

  // Posting clears your own AFK (except the "afk" message that set it).
  const own = afk.get(evt.userId);
  if (own && own.set_message_id !== evt.id) {
    await clearAfk(evt.userId);
    const name = await nicknameOf(evt.userId);
    sendEphemeral(evt.channelId, `👋 Welcome back, **${name.replace(/\*/g, "")}**! I removed your AFK (away ${formatDuration(Date.now() - own.since)}).`);
  }

  // Mentions and replies to AFK members.
  const mentioned = new Set<string>();
  for (const u of evt.referenceMaps?.users ?? []) mentioned.add(u.userId);
  for (const p of evt.parentMessages ?? []) if (p.userId) mentioned.add(p.userId);
  mentioned.delete(evt.userId);

  const lines: string[] = [];
  for (const userId of mentioned) {
    const row = afk.get(userId);
    if (!row || !notices.take(`${evt.channelId}:${userId}`, AFK_NOTICE_WINDOW_MS / 1000)) continue;
    const name = (await nicknameOf(userId as UserGuid)).replace(/\*/g, "");
    lines.push(`💤 **${name}** is AFK: ${row.message} · ${formatDuration(Date.now() - row.since)} ago`);
    if (lines.length >= 5) break;
  }
  if (lines.length) {
    await reply(evt.channelId, evt.id, lines.join("\n")).catch((err) => log("warn", "afk notice failed", { error: errMessage(err) }));
  }
}
