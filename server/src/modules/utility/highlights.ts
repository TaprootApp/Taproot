import {
  rootServer,
  AccessRule,
  ChannelGuid,
  ChannelMessageCreatedEvent,
  ChannelOrChannelGroupGuid,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-app";
import { all, run } from "../../db";
import { register, UsageError } from "../../commands/registry";
import { read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { nicknameOf } from "../../members";
import { Level, listRoles, memberRoleIds } from "../../permissions";
import { addMessageListener } from "../../pipeline";
import { notifyChange } from "../../services/changes";
import { canSeeChannel, findKeywords, HighlightThrottle, MAX_HIGHLIGHTS, normalizeKeyword, plainMentions, RuleView } from "./logic";
import { channelName, isBot } from "./shared";

// Highlights: members subscribe to keywords and get a Root notification when
// one comes up in a channel they can see. Root Apps can't DM, so the ping is
// a notification: "Highlight: "word" in #channel" plus who said it. Rules:
// never for your own message, not while you're active in that channel
// (posted in the last 5 minutes), and at most one per channel per 5 minutes.

/** Change area; notifications carry the member, as "utility:highlights:<userId>". */
export const HL_AREA = "utility:highlights";

// keyword -> subscribers, and subscriber -> keywords.
const byKeyword = new Map<string, Set<string>>();
const byUser = new Map<string, Set<string>>();
const throttle = new HighlightThrottle();

export async function initHighlights(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS utility_highlights (
    user_id TEXT NOT NULL,
    keyword TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, keyword)
  )`);
  for (const row of await all<{ user_id: string; keyword: string }>("SELECT user_id, keyword FROM utility_highlights")) {
    index(row.user_id, row.keyword);
  }
  registerHighlightCommand();
  addMessageListener("utility:highlights", onMessage);
}

function index(userId: string, keyword: string): void {
  if (!byKeyword.has(keyword)) byKeyword.set(keyword, new Set());
  byKeyword.get(keyword)!.add(userId);
  if (!byUser.has(userId)) byUser.set(userId, new Set());
  byUser.get(userId)!.add(keyword);
}

function unindex(userId: string, keyword: string): void {
  byKeyword.get(keyword)?.delete(userId);
  if (byKeyword.get(keyword)?.size === 0) byKeyword.delete(keyword);
  byUser.get(userId)?.delete(keyword);
  if (byUser.get(userId)?.size === 0) byUser.delete(userId);
}

export function highlightsOf(userId: string): string[] {
  return [...(byUser.get(userId) ?? [])].sort();
}

/** Adds a keyword; returns the stored form, or a problem to show. */
export async function addHighlight(userId: string, raw: string): Promise<{ keyword: string } | { problem: string }> {
  const result = normalizeKeyword(raw);
  if ("problem" in result) return result;
  const mine = byUser.get(userId);
  if (mine?.has(result.keyword)) return { problem: `You already have "${result.keyword}".` };
  if ((mine?.size ?? 0) >= MAX_HIGHLIGHTS) return { problem: `You can have up to ${MAX_HIGHLIGHTS} keywords. Remove one first.` };
  await run("INSERT OR IGNORE INTO utility_highlights (user_id, keyword, created_at) VALUES (?, ?, ?)", [userId, result.keyword, Date.now()]);
  index(userId, result.keyword);
  notifyChange(`${HL_AREA}:${userId}`);
  return result;
}

export async function removeHighlight(userId: string, raw: string): Promise<boolean> {
  const result = normalizeKeyword(raw);
  const keyword = "keyword" in result ? result.keyword : raw.trim().toLowerCase();
  if (!byUser.get(userId)?.has(keyword)) return false;
  await run("DELETE FROM utility_highlights WHERE user_id = ? AND keyword = ?", [userId, keyword]);
  unindex(userId, keyword);
  notifyChange(`${HL_AREA}:${userId}`);
  return true;
}

export async function clearHighlights(userId: string): Promise<number> {
  const mine = [...(byUser.get(userId) ?? [])];
  await run("DELETE FROM utility_highlights WHERE user_id = ?", [userId]);
  for (const k of mine) unindex(userId, k);
  notifyChange(`${HL_AREA}:${userId}`);
  return mine.length;
}

// --- Channel visibility --------------------------------------------------------

const RULES_TTL = 5 * 60_000;
const rulesCache = new Map<string, { at: number; rules: RuleView[] }>();

/** The access rules that decide who sees a channel (its own, or its group's). */
async function channelRules(channelId: string): Promise<RuleView[]> {
  const cached = rulesCache.get(channelId);
  if (cached && Date.now() - cached.at < RULES_TTL) return cached.rules;
  let rules: RuleView[] = [];
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    const targetId = (channel.useChannelGroupPermission ? channel.channelGroupId : channel.id) as string as ChannelOrChannelGroupGuid;
    const list: AccessRule[] = await read("accessRules.listByChannelOrChannelGroup", () =>
      rootServer.community.accessRules.listByChannelOrChannelGroup({ channelOrChannelGroupId: targetId }),
    );
    rules = list.map((r) => ({ subjectId: r.roleOrMemberId as string, view: r.overlay?.channelView }));
  } catch (err) {
    // Fail closed (no pings but Full Control) until the cache expires, and log once per expiry.
    log("warn", "highlight visibility lookup failed", { channelId, error: errMessage(err) });
  }
  rulesCache.set(channelId, { at: Date.now(), rules });
  return rules;
}

async function canSee(userId: string, rules: RuleView[]): Promise<boolean> {
  const roleIds = await memberRoleIds(userId as UserGuid);
  const subjects = new Set<string>([userId, WellKnownRootGuids.CommunityRoles.EveryoneRole, ...roleIds]);
  const roles = await listRoles();
  const fullControl = roles.some((r) => roleIds.includes(r.id) && r.communityPermission?.communityFullControl);
  return canSeeChannel(rules, userId, subjects, fullControl);
}

/** Whether the member can see the channel (fails closed). Shared with channelinfo. */
export async function memberCanSeeChannel(userId: string, channelId: string): Promise<boolean> {
  try {
    return await canSee(userId, await channelRules(channelId));
  } catch {
    return false;
  }
}

// --- Runtime -------------------------------------------------------------------

async function onMessage(evt: ChannelMessageCreatedEvent): Promise<void> {
  throttle.notePost(evt.channelId, evt.userId);
  if (byKeyword.size === 0 || isBot(evt.userId)) return;
  const content = evt.messageContent ?? "";
  if (!content.trim()) return;

  const found = findKeywords(content, byKeyword.keys());
  if (found.length === 0) return;

  // Subscriber -> the first keyword that matched for them.
  const targets = new Map<string, string>();
  for (const keyword of found) {
    for (const userId of byKeyword.get(keyword) ?? []) {
      if (userId !== evt.userId && !targets.has(userId)) targets.set(userId, keyword);
    }
  }
  if (targets.size === 0) return;

  const rules = await channelRules(evt.channelId);
  const byWord = new Map<string, UserGuid[]>();
  for (const [userId, keyword] of targets) {
    let visible = false;
    try {
      visible = await canSee(userId, rules);
    } catch {
      // Not a member any more, or the lookup failed: stay quiet.
    }
    if (!visible || !throttle.take(evt.channelId, userId)) continue;
    if (!byWord.has(keyword)) byWord.set(keyword, []);
    byWord.get(keyword)!.push(userId as UserGuid);
  }
  if (byWord.size === 0) return;

  const [author, channel] = await Promise.all([nicknameOf(evt.userId), channelName(evt.channelId)]);
  const excerpt = plainMentions(content).replace(/\s+/g, " ").trim();
  const description = clip(`${author}: ${excerpt}`, 150);
  for (const [keyword, userIds] of byWord) {
    const title = clip(`Highlight: "${clip(keyword, 20)}" in #${channel}`, 50);
    // One call per keyword; recipients of the same keyword share the text.
    await write("notifications.send", () => rootServer.community.notifications.send({ title, description, userIds })).catch((err) =>
      log("warn", "highlight notification failed", { error: errMessage(err) }),
    );
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// --- Command -------------------------------------------------------------------

function registerHighlightCommand(): void {
  register({
    name: "highlight",
    aliases: ["hl", "highlights"],
    category: "Utility",
    level: Level.Member,
    usage: "<add|remove> <keyword> | list | clear",
    description: `Get a notification when a keyword is mentioned in a channel you can see (up to ${MAX_HIGHLIGHTS}).`,
    details: [
      "`highlight add taproot` · `highlight remove taproot` · `highlight list` · `highlight clear`",
      "Keywords match whole words, ignoring case. You won't be pinged for your own messages, in a channel you posted in during the last 5 minutes, or more than once per channel every 5 minutes.",
    ],
    async run(ctx) {
      const action = ctx.args.word() ?? "list";
      if (action === "list") {
        const mine = highlightsOf(ctx.authorId);
        if (mine.length === 0) return ctx.reply(`You have no highlight keywords. Add one with \`${ctx.prefix}highlight add <keyword>\`.`);
        return ctx.reply(`🔔 **Your highlights (${mine.length}/${MAX_HIGHLIGHTS}):** ${mine.map((k) => `\`${k}\``).join(", ")}`);
      }
      if (action === "clear") {
        const n = await clearHighlights(ctx.authorId);
        return ctx.reply(n ? `🧹 Removed all ${n} of your highlight keywords.` : "You had no highlight keywords.");
      }
      if (action === "add" || action === "remove" || action === "delete") {
        const text = plainMentions(ctx.args.rest());
        if (!text) throw new UsageError("Give the keyword.");
        if (action === "add") {
          const result = await addHighlight(ctx.authorId, text);
          if ("problem" in result) return ctx.reply(`❌ ${result.problem}`);
          return ctx.reply(`🔔 Added \`${result.keyword}\`. You'll get a notification when it comes up in a channel you can see.`);
        }
        if (!(await removeHighlight(ctx.authorId, text))) return ctx.reply("❌ That isn't one of your keywords.");
        return ctx.reply("🗑️ Removed.");
      }
      throw new UsageError();
    },
  });
}
