import {
  rootServer,
  ChannelGuid,
  ChannelMessage,
  ErrorCodeType,
  MessageGuid,
} from "@rootsdk/server-app";
import { UsageError, register } from "../../commands/registry";
import { get, run } from "../../db";
import { emojiKey } from "../../features/emoji";
import { resolveEmojiText } from "../../features/roles";
import { errorCode, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { channelMention } from "../../lib/text";
import { send } from "../../messaging";
import { Level } from "../../permissions";
import { moduleConfig, saveModuleConfig } from "../../settings";
import { emojiDisplay, STAR_THRESHOLD_MAX, starAction, starrers } from "./logic";
import { renderStarPost } from "./render";
import { AREA_STARBOARD, channelName, displayName, editMessage, fetchMessage, isBot, MODULE } from "./shared";

// Starboard: when a message collects enough of the chosen reaction, Taproot
// reposts it to the starboard channel and keeps that one post's count up to
// date. Counts are recomputed from the messages' own reactions (the original
// plus Taproot's copy, distinct members), a few seconds after the last
// change, so missed events and bursts don't drift the count.

export interface StarboardConfig {
  enabled: boolean;
  channelId: string | null;
  emoji: string;
  threshold: number;
  selfStar: boolean;
  ignoredChannels: string[];
  /** Delete the post when the count drops below the threshold (else just update it). */
  removeBelow: boolean;
}

export interface EventsConfig {
  starboard: StarboardConfig;
}

export const EVENTS_DEFAULTS: EventsConfig = {
  starboard: {
    enabled: false,
    channelId: null,
    emoji: ":star:",
    threshold: 3,
    selfStar: false,
    ignoredChannels: [],
    removeBelow: true,
  },
};

export function starboardConfig(): StarboardConfig {
  return moduleConfig<EventsConfig>(MODULE).starboard;
}

export async function saveStarboard(change: Partial<StarboardConfig>): Promise<StarboardConfig> {
  const current = moduleConfig<EventsConfig>(MODULE);
  const next: EventsConfig = { ...current, starboard: { ...current.starboard, ...change } };
  await saveModuleConfig(MODULE, next, AREA_STARBOARD);
  return next.starboard;
}

interface StarRow {
  message_id: string;
  channel_id: string;
  author_id: string;
  post_id: string | null;
  post_channel_id: string | null;
  stars: number;
  /** Staff deleted the starboard post; never repost this message. */
  blocked: number;
  created_at: number;
  updated_at: number;
}

export async function initStarboardTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS events_starboard (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    post_id TEXT,
    post_channel_id TEXT,
    stars INTEGER NOT NULL DEFAULT 0,
    blocked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_starboard_post ON events_starboard (post_id)`);
}

export async function starboardStats(): Promise<{ posts: number; totalStars: number }> {
  const row = await get<{ posts: number; stars: number | null }>(
    "SELECT COUNT(*) AS posts, SUM(stars) AS stars FROM events_starboard WHERE post_id IS NOT NULL",
  );
  return { posts: row?.posts ?? 0, totalStars: row?.stars ?? 0 };
}

// --- Refresh -------------------------------------------------------------------

const DEBOUNCE_MS = 3000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const chains = new Map<string, Promise<void>>();

/** Recounts a message a few seconds after the last change; one refresh per message at a time. */
function schedule(channelId: string, messageId: string): void {
  const existing = timers.get(messageId);
  if (existing) clearTimeout(existing);
  timers.set(
    messageId,
    setTimeout(() => {
      timers.delete(messageId);
      const previous = chains.get(messageId) ?? Promise.resolve();
      const next = previous
        .then(() => refresh(channelId, messageId))
        .catch((err) => log("warn", "starboard refresh failed", { error: errMessage(err) }))
        .finally(() => {
          if (chains.get(messageId) === next) chains.delete(messageId);
        });
      chains.set(messageId, next);
    }, DEBOUNCE_MS),
  );
}

async function deletePost(channelId: string, postId: string): Promise<void> {
  await write("channelMessages.delete", () =>
    rootServer.community.channelMessages.delete({ channelId: channelId as ChannelGuid, id: postId as MessageGuid }),
  ).catch((err) => {
    if (errorCode(err) !== ErrorCodeType.NotFound) log("warn", "starboard post delete failed", { error: errMessage(err) });
  });
}

function attachmentsOf(msg: ChannelMessage): string[] {
  return (msg.messageUris ?? []).filter((u) => u.attachment).map((u) => u.attachment!.fileName || "attachment");
}

async function render(msg: ChannelMessage, count: number, cfg: StarboardConfig): Promise<string> {
  return renderStarPost({
    emoji: cfg.emoji,
    count,
    channelId: msg.channelId,
    channelName: await channelName(msg.channelId),
    authorName: await displayName(msg.userId),
    content: msg.messageContent ?? "",
    attachments: attachmentsOf(msg),
  });
}

async function refresh(channelId: string, messageId: string): Promise<void> {
  const cfg = starboardConfig();
  const row = await get<StarRow>("SELECT * FROM events_starboard WHERE message_id = ?", [messageId]);
  if (row?.blocked) return;
  const msg = await fetchMessage(channelId, messageId);
  if (!msg) {
    // The original is gone: take its post down too.
    if (row?.post_id) await deletePost(row.post_channel_id ?? cfg.channelId ?? "", row.post_id);
    if (row) await run("DELETE FROM events_starboard WHERE message_id = ?", [messageId]);
    return;
  }
  if (isBot(msg.userId)) return;

  const post = row?.post_id && row.post_channel_id ? await fetchMessage(row.post_channel_id, row.post_id) : undefined;
  const postGone = Boolean(row?.post_id) && !post;
  const reactions = [...(msg.reactions ?? []), ...(post?.reactions ?? [])];
  const count = starrers(reactions, cfg.emoji, msg.userId, cfg.selfStar, isBot).size;
  const action = starAction(count, cfg.threshold, Boolean(post), cfg.removeBelow);
  const now = Date.now();

  if (action === "create") {
    // A post that vanished without a delete event we saw is simply replaced.
    if (!cfg.enabled || !cfg.channelId) return;
    const created = await send(cfg.channelId, await render(msg, count, cfg));
    await run(
      `INSERT INTO events_starboard (message_id, channel_id, author_id, post_id, post_channel_id, stars, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET post_id = excluded.post_id, post_channel_id = excluded.post_channel_id,
         stars = excluded.stars, updated_at = excluded.updated_at`,
      [messageId, msg.channelId, msg.userId, created.id, cfg.channelId, count, now, now],
    );
    return;
  }
  if (action === "update" && post && row?.post_id && row.post_channel_id) {
    // Edits also carry changes to the original's text.
    await editMessage(row.post_channel_id, row.post_id, await render(msg, count, cfg));
    await run("UPDATE events_starboard SET stars = ?, updated_at = ? WHERE message_id = ?", [count, now, messageId]);
    return;
  }
  if (action === "remove" && row?.post_id) {
    await deletePost(row.post_channel_id ?? "", row.post_id);
    await run("UPDATE events_starboard SET post_id = NULL, post_channel_id = NULL, stars = ?, updated_at = ? WHERE message_id = ?", [
      count,
      now,
      messageId,
    ]);
    return;
  }
  if (row && (postGone || count !== row.stars)) {
    await run("UPDATE events_starboard SET stars = ?, updated_at = ? WHERE message_id = ?", [count, now, messageId]);
  }
}

// --- Events --------------------------------------------------------------------

export async function onStarReaction(channelId: string, messageId: string, shortcode: string): Promise<void> {
  const cfg = starboardConfig();
  if (!cfg.enabled || !cfg.channelId || emojiKey(shortcode) !== emojiKey(cfg.emoji)) return;
  // A reaction on Taproot's starboard copy counts toward the original.
  const copy = await get<StarRow>("SELECT * FROM events_starboard WHERE post_id = ?", [messageId]);
  if (copy) return schedule(copy.channel_id, copy.message_id);
  if (channelId === cfg.channelId || cfg.ignoredChannels.includes(channelId)) return;
  if (await isTicketChannel(channelId)) return;
  schedule(channelId, messageId);
}

/**
 * Support tickets are private conversations with staff; starring a message in
 * one must never repost it to the (usually public) starboard.
 */
async function isTicketChannel(channelId: string): Promise<boolean> {
  try {
    return Boolean(await get("SELECT 1 FROM support_tickets WHERE channel_id = ? LIMIT 1", [channelId]));
  } catch {
    // The support module's table doesn't exist (module failed to start): no tickets.
    return false;
  }
}

/** An edited original gets its starboard post refreshed. */
export async function onStarredEdited(messageId: string): Promise<void> {
  const row = await get<StarRow>("SELECT * FROM events_starboard WHERE message_id = ? AND post_id IS NOT NULL", [messageId]);
  if (row) schedule(row.channel_id, row.message_id);
}

export async function onStarredDeleted(messageId: string): Promise<void> {
  const original = await get<StarRow>("SELECT * FROM events_starboard WHERE message_id = ?", [messageId]);
  if (original) {
    if (original.post_id) await deletePost(original.post_channel_id ?? "", original.post_id);
    await run("DELETE FROM events_starboard WHERE message_id = ?", [messageId]);
    return;
  }
  // Someone removed Taproot's starboard post: keep that message off the board.
  await run("UPDATE events_starboard SET post_id = NULL, post_channel_id = NULL, blocked = 1, updated_at = ? WHERE post_id = ?", [
    Date.now(),
    messageId,
  ]);
}

// --- Command -----------------------------------------------------------------

async function describe(cfg: StarboardConfig): Promise<string> {
  const mention = async (id: string) => channelMention(await channelName(id), id);
  const ignored = cfg.ignoredChannels.length ? (await Promise.all(cfg.ignoredChannels.map(mention))).join(", ") : "none";
  return [
    `**Starboard** is **${cfg.enabled ? "on" : "off"}**.`,
    `Channel: ${cfg.channelId ? await mention(cfg.channelId) : "not set"}`,
    `Emoji: ${emojiDisplay(cfg.emoji)} · Threshold: **${cfg.threshold}**`,
    `Self-star: ${cfg.selfStar ? "counted" : "not counted"} · Below threshold: ${cfg.removeBelow ? "post removed" : "post kept"}`,
    `Ignored channels: ${ignored}`,
  ].join("\n");
}

export function registerStarboard(): void {
  register({
    name: "starboard",
    category: "Starboard",
    level: Level.Admin,
    usage: "[on|off] · channel <#channel|off> · emoji <:emoji:> · threshold <n> · selfstar <on|off> · remove <on|off> · ignore #channel",
    description: "Repost messages that collect enough stars to a starboard channel.",
    details: [
      "`starboard channel #starboard` then `starboard on` to start.",
      "`starboard threshold 5` sets how many reactions are needed (distinct members; stars on the starboard copy count too).",
      "`starboard remove off` keeps posts up when the count drops below the threshold.",
      "`starboard ignore #channel` toggles a channel being left out.",
    ],
    async run(ctx) {
      const action = ctx.args.word();
      const cfg = starboardConfig();
      const onOff = (word: string | undefined): boolean => {
        if (word === "on" || word === "yes" || word === "true") return true;
        if (word === "off" || word === "no" || word === "false") return false;
        throw new UsageError("Say `on` or `off`.");
      };

      if (!action) return ctx.reply(await describe(cfg));
      if (action === "on" || action === "off") {
        if (action === "on" && !cfg.channelId) return ctx.reply("❌ Pick a channel first: `starboard channel #starboard`.");
        await saveStarboard({ enabled: action === "on" });
        return ctx.reply(`✅ Starboard turned **${action}**.`);
      }
      if (action === "channel") {
        const channel = ctx.args.mention("channel");
        if (!channel?.id) {
          if (ctx.args.word() === "off") {
            await saveStarboard({ channelId: null, enabled: false });
            return ctx.reply("✅ Starboard channel cleared and the starboard turned off.");
          }
          throw new UsageError("Mention the starboard channel.");
        }
        await saveStarboard({ channelId: channel.id });
        return ctx.reply(`✅ Starred messages go to ${channel.text}.${cfg.enabled ? "" : " Run `starboard on` to start."}`);
      }
      if (action === "emoji") {
        const token = ctx.args.next();
        const raw = token ? (token.kind === "emoji" ? token.id ?? token.text : token.text) : "";
        const shortcode = await resolveEmojiText(raw);
        if (!shortcode) throw new UsageError("Write the emoji as a :shortcode:, like :star:.");
        await saveStarboard({ emoji: shortcode });
        return ctx.reply(`✅ Starboard emoji set to ${emojiDisplay(shortcode)}.`);
      }
      if (action === "threshold" || action === "stars" || action === "min") {
        const n = Number(ctx.args.word());
        if (!Number.isInteger(n) || n < 1 || n > STAR_THRESHOLD_MAX) throw new UsageError(`Pick a number from 1 to ${STAR_THRESHOLD_MAX}.`);
        await saveStarboard({ threshold: n });
        return ctx.reply(`✅ Messages need **${n}** to reach the starboard.`);
      }
      if (action === "selfstar") {
        const on = onOff(ctx.args.word());
        await saveStarboard({ selfStar: on });
        return ctx.reply(on ? "✅ Authors' own reactions now count." : "✅ Authors' own reactions no longer count.");
      }
      if (action === "remove") {
        const on = onOff(ctx.args.word());
        await saveStarboard({ removeBelow: on });
        return ctx.reply(on ? "✅ Posts are removed when they drop below the threshold." : "✅ Posts stay up when they drop below the threshold.");
      }
      if (action === "ignore" || action === "unignore") {
        const channel = ctx.args.mention("channel");
        if (!channel?.id) throw new UsageError("Mention the channel.");
        const has = cfg.ignoredChannels.includes(channel.id);
        await saveStarboard({
          ignoredChannels: has ? cfg.ignoredChannels.filter((id) => id !== channel.id) : [...cfg.ignoredChannels, channel.id],
        });
        return ctx.reply(has ? `✅ ${channel.text} counts for the starboard again.` : `✅ ${channel.text} is now ignored by the starboard.`);
      }
      throw new UsageError();
    },
  });
}
