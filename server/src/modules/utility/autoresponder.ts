import { rootServer, ChannelGuid, ChannelMessageCreatedEvent, MessageGuid } from "@rootsdk/server-app";
import { all, get, run } from "../../db";
import { CommandContext, register, UsageError } from "../../commands/registry";
import { tokenize } from "../../commands/parse";
import { resolveEmojiText } from "../../features/roles";
import { emojiAsTyped, emojiDisplay } from "../../features/emoji";
import { write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { channelMention, fillTemplate, userMention } from "../../lib/text";
import { formatDuration, parseDuration } from "../../lib/time";
import { nicknameOf } from "../../members";
import { send } from "../../messaging";
import { Level } from "../../permissions";
import { addMessageListener } from "../../pipeline";
import { notifyChange } from "../../services/changes";
import {
  Cooldowns,
  MATCH_MODES,
  matchesTrigger,
  MatchMode,
  MAX_AUTORESPONDERS,
  MAX_COOLDOWN_SECONDS,
  MAX_RESPONSE,
  triggerProblem,
} from "./logic";
import { channelName, isBot, serverName } from "./shared";

// Autoresponders: staff-defined triggers that answer ordinary chat messages
// (not commands) with a text reply, a reaction, or both. The first matching
// trigger wins, so one message gets at most one response.

export interface Autoresponder {
  id: number;
  trigger: string;
  match: MatchMode;
  response: string;
  reaction: string;
  channel_ids: string[];
  cooldown_s: number;
  uses: number;
}

interface Row extends Omit<Autoresponder, "channel_ids"> {
  channel_ids: string;
}

export const AR_AREA = "utility:autoresponders";
/** Minimum gap between responses of one trigger in one channel, so it can't be spammed. */
const CHANNEL_FLOOR_S = 3;

let list: Autoresponder[] = [];
const cooldowns = new Cooldowns();

export const PLACEHOLDERS = "`{user}` mentions who posted · `{user.name}` their name · `{channel}` · `{server}`";

export async function initAutoresponders(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS utility_autoresponders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    match TEXT NOT NULL,
    response TEXT NOT NULL DEFAULT '',
    reaction TEXT NOT NULL DEFAULT '',
    channel_ids TEXT NOT NULL DEFAULT '[]',
    cooldown_s INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  await reload();
  registerArCommand();
  addMessageListener("utility:autoresponder", onMessage);
}

function fromRow(row: Row): Autoresponder {
  let channels: string[] = [];
  try {
    const parsed = JSON.parse(row.channel_ids);
    if (Array.isArray(parsed)) channels = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    // Corrupt value: treat as every channel.
  }
  return { ...row, match: MATCH_MODES.includes(row.match) ? row.match : "exact", channel_ids: channels };
}

async function reload(): Promise<void> {
  list = (await all<Row>("SELECT * FROM utility_autoresponders ORDER BY id")).map(fromRow);
}

/** Current list, with use counts fresh from the database. */
export async function listAutoresponders(): Promise<Autoresponder[]> {
  await reload();
  return list;
}

export interface AutoresponderInput {
  id?: number;
  trigger: string;
  match: MatchMode;
  response: string;
  /** A :shortcode: as typed, or empty. */
  reaction: string;
  channelIds: string[];
  cooldownSeconds: number;
}

/**
 * Validates and saves (creates when id is 0/undefined). Returns a problem
 * the caller shows, or the saved autoresponder. Shared by "ar" and the GUI.
 */
export async function saveAutoresponder(input: AutoresponderInput, authorId: string): Promise<{ problem: string } | Autoresponder> {
  const trigger = input.trigger.trim();
  const problem = triggerProblem(trigger, input.match);
  if (problem) return { problem };
  const response = input.response.trim();
  if (response.length > MAX_RESPONSE) return { problem: `Responses can be up to ${MAX_RESPONSE} characters.` };
  let reaction = "";
  if (input.reaction.trim()) {
    const resolved = await resolveEmojiText(input.reaction.trim());
    if (!resolved) return { problem: "Write the reaction as a :shortcode:, like :wave:." };
    reaction = resolved;
  }
  if (!response && !reaction) return { problem: "Give a response, a reaction, or both." };
  if (!Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds < 0 || input.cooldownSeconds > MAX_COOLDOWN_SECONDS) {
    return { problem: "The cooldown must be between 0 seconds and 1 day." };
  }
  const channels = [...new Set(input.channelIds.filter(Boolean))].slice(0, 50);

  if (input.id) {
    const { changes } = await run(
      "UPDATE utility_autoresponders SET trigger = ?, match = ?, response = ?, reaction = ?, channel_ids = ?, cooldown_s = ? WHERE id = ?",
      [trigger, input.match, response, reaction, JSON.stringify(channels), input.cooldownSeconds, input.id],
    );
    if (!changes) return { problem: `No autoresponder #${input.id}.` };
  } else {
    const count = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM utility_autoresponders"))?.n ?? 0;
    if (count >= MAX_AUTORESPONDERS) return { problem: `You can have up to ${MAX_AUTORESPONDERS} autoresponders.` };
    const duplicate = list.find((a) => a.match === input.match && a.trigger.toLowerCase() === trigger.toLowerCase());
    if (duplicate) return { problem: `Autoresponder #${duplicate.id} already has that trigger.` };
    input.id = (
      await run(
        `INSERT INTO utility_autoresponders (trigger, match, response, reaction, channel_ids, cooldown_s, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [trigger, input.match, response, reaction, JSON.stringify(channels), input.cooldownSeconds, authorId, Date.now()],
      )
    ).lastID;
  }
  await reload();
  notifyChange(AR_AREA);
  return list.find((a) => a.id === input.id)!;
}

export async function deleteAutoresponder(id: number): Promise<boolean> {
  const { changes } = await run("DELETE FROM utility_autoresponders WHERE id = ?", [id]);
  if (!changes) return false;
  await reload();
  notifyChange(AR_AREA);
  return true;
}

// --- Runtime -----------------------------------------------------------------

async function onMessage(evt: ChannelMessageCreatedEvent, wasCommand: boolean): Promise<void> {
  if (wasCommand || list.length === 0 || isBot(evt.userId)) return;
  const content = evt.messageContent ?? "";
  if (!content.trim()) return;

  const ar = list.find(
    (a) => (a.channel_ids.length === 0 || a.channel_ids.includes(evt.channelId)) && matchesTrigger(content, a.trigger, a.match),
  );
  if (!ar) return;
  if (!cooldowns.take(`${ar.id}:${evt.channelId}`, CHANNEL_FLOOR_S)) return;
  if (ar.cooldown_s > 0 && !cooldowns.take(`${ar.id}`, ar.cooldown_s)) return;

  if (ar.reaction) {
    await write("channelMessages.reactionCreate", () =>
      rootServer.community.channelMessages.reactionCreate({
        channelId: evt.channelId as ChannelGuid,
        messageId: evt.id as MessageGuid,
        shortcode: ar.reaction,
      }),
    ).catch((err) => log("warn", "autoresponder reaction failed", { id: ar.id, error: errMessage(err) }));
  }
  if (ar.response) {
    const name = await nicknameOf(evt.userId);
    const text = fillTemplate(ar.response, {
      user: userMention(name, evt.userId),
      "user.name": name,
      channel: channelMention(await channelName(evt.channelId), evt.channelId),
      server: await serverName().catch(() => "this community"),
    });
    await send(evt.channelId, text).catch((err) => log("warn", "autoresponder reply failed", { id: ar.id, error: errMessage(err) }));
  }
  await run("UPDATE utility_autoresponders SET uses = uses + 1 WHERE id = ?", [ar.id]);
  ar.uses++;
}

// --- Command -----------------------------------------------------------------

const MODE_WORDS: Record<string, MatchMode> = {
  exact: "exact",
  contains: "contains",
  starts: "starts",
  startswith: "starts",
  "starts-with": "starts",
  wildcard: "wildcard",
  wild: "wildcard",
};

const MODE_LABEL: Record<MatchMode, string> = { exact: "exact", contains: "contains", starts: "starts with", wildcard: "wildcard" };

export function describe(ar: Autoresponder, prefix = ""): string {
  const what = [ar.response ? "reply" : "", ar.reaction ? emojiDisplay(ar.reaction) : ""].filter(Boolean).join(" + ");
  const where = ar.channel_ids.length ? ` · ${ar.channel_ids.length} channel${ar.channel_ids.length === 1 ? "" : "s"}` : "";
  const cd = ar.cooldown_s ? ` · ${formatDuration(ar.cooldown_s * 1000)} cooldown` : "";
  return `${prefix}**#${ar.id}** \`${ar.trigger.replace(/`/g, "'")}\` (${MODE_LABEL[ar.match]}) → ${what}${where}${cd} · used ${ar.uses}×`;
}

function takeMode(ctx: CommandContext): MatchMode {
  const next = ctx.args.peek();
  const mode = next?.kind === "word" ? MODE_WORDS[next.text.toLowerCase()] : undefined;
  if (mode) ctx.args.next();
  return mode ?? "exact";
}

function splitPipe(text: string): [string, string] {
  const i = text.indexOf("|");
  if (i < 0) throw new UsageError("Separate the trigger and the response with |.");
  return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
}

function takeId(ctx: CommandContext): number {
  const id = Number(ctx.args.word()?.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) throw new UsageError("Give the autoresponder's number (see `ar list`).");
  return id;
}

function registerArCommand(): void {
  register({
    name: "ar",
    aliases: ["autoresponder", "autoresponders"],
    category: "Autoresponder",
    level: Level.Moderator,
    usage: "<add|react|remove|cooldown|channels> … | list",
    description: "Automatic replies or reactions when a message matches a trigger.",
    details: [
      "`ar add hello there | Hi {user}!` replies when a message is exactly \"hello there\".",
      "Put a match mode first: `exact` (default), `contains`, `starts` or `wildcard` (use * for any text), e.g. `ar add contains pizza | 🍕 Did someone say pizza?`",
      "`ar react contains good morning | :wave:` reacts instead of replying.",
      "`ar remove <n>` · `ar cooldown <n> <30s|5m|off>` · `ar channels <n> #channel… | all` · `ar list`",
      `Placeholders: ${PLACEHOLDERS}. Matching ignores case. Commands never trigger autoresponders.`,
    ],
    async run(ctx) {
      const action = ctx.args.word() ?? "list";

      if (action === "list") {
        const current = await listAutoresponders();
        if (current.length === 0) return ctx.reply(`No autoresponders yet. Add one with \`${ctx.prefix}ar add <trigger> | <response>\`.`);
        return ctx.reply(`**Autoresponders (${current.length}):**\n${current.map((a) => describe(a, "• ")).join("\n")}`);
      }

      if (action === "add" || action === "react") {
        const match = takeMode(ctx);
        const [trigger, rest] = splitPipe(ctx.args.rest());
        let reaction = "";
        let response = rest;
        if (action === "react") {
          const token = tokenize(rest)[0];
          reaction = token ? (token.kind === "emoji" ? token.id ?? token.text : token.text) : "";
          response = "";
          if (!reaction) throw new UsageError("Give the reaction emoji after |.");
        }
        const result = await saveAutoresponder(
          { trigger, match, response, reaction, channelIds: [], cooldownSeconds: 0 },
          ctx.authorId,
        );
        if ("problem" in result) return ctx.reply(`❌ ${result.problem}`);
        return ctx.reply(`✅ Added ${describe(result)}`);
      }

      if (action === "remove" || action === "delete") {
        const id = takeId(ctx);
        if (!(await deleteAutoresponder(id))) return ctx.reply(`❌ No autoresponder #${id}.`);
        return ctx.reply(`🗑️ Removed autoresponder #${id}.`);
      }

      if (action === "cooldown" || action === "channels" || action === "channel") {
        const id = takeId(ctx);
        const ar = (await listAutoresponders()).find((a) => a.id === id);
        if (!ar) return ctx.reply(`❌ No autoresponder #${id}.`);
        const input: AutoresponderInput = {
          id,
          trigger: ar.trigger,
          match: ar.match,
          response: ar.response,
          reaction: emojiAsTyped(ar.reaction),
          channelIds: ar.channel_ids,
          cooldownSeconds: ar.cooldown_s,
        };
        if (action === "cooldown") {
          const word = ctx.args.word();
          if (!word) throw new UsageError("Give a cooldown like 30s or 5m, or off.");
          const ms = word === "off" || word === "0" ? 0 : parseDuration(word);
          if (ms === undefined) throw new UsageError("Give a cooldown like 30s or 5m, or off.");
          input.cooldownSeconds = Math.round(ms / 1000);
        } else {
          const channels: string[] = [];
          for (let t = ctx.args.mention("channel"); t; t = ctx.args.mention("channel")) if (t.id) channels.push(t.id);
          if (channels.length === 0 && ctx.args.word() !== "all") throw new UsageError("Mention the channels, or say all.");
          input.channelIds = channels;
        }
        const result = await saveAutoresponder(input, ctx.authorId);
        if ("problem" in result) return ctx.reply(`❌ ${result.problem}`);
        return ctx.reply(`✅ Updated ${describe(result)}`);
      }
      throw new UsageError();
    },
  });
}
