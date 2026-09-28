import { rootServer, ChannelGuid, ChannelType, ErrorCodeType, WellKnownRootGuids } from "@rootsdk/server-app";
import { register, UsageError } from "../../commands/registry";
import { all, get, run } from "../../db";
import { cancelJobs, hasJob, onJob, onReconcile, scheduleOnce } from "../../jobs";
import { describeError, errorCode, read } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { channelMention, MAX_MESSAGE, roleMention, truncate } from "../../lib/text";
import { formatUtc } from "../../lib/time";
import { send } from "../../messaging";
import { Level, listRoles } from "../../permissions";
import { loadModuleConfig, moduleConfig, saveModuleConfig } from "../../settings";
import { notifyChange } from "../../services/changes";
import {
  DEFAULT_TEMPLATES,
  FEED_KINDS,
  FeedItem,
  FeedKind,
  FeedState,
  MAX_POLL_MINUTES,
  MIN_POLL_MINUTES,
  nextDelayMs,
  parseKickSlug,
  parseSubreddit,
  parseTwitchLogin,
  renderPost,
  selectLive,
  selectNewItems,
  Selection,
  sourceUrl,
  staggerMs,
} from "./logic";
import {
  FeedError,
  fetchKick,
  fetchReddit,
  fetchTwitch,
  fetchYouTube,
  forgetTwitchToken,
  resolveReddit,
  resolveTwitch,
  resolveYouTube,
  TwitchCredentials,
} from "./sources";

// Social feeds (Dyno's premium YouTube/Reddit/Twitch notifications). Each
// feed polls on its own chain of one-time jobs: a check schedules the next
// one, spread over the interval by feed ID and backed off after failures.
// The first check only records what already exists, so adding a feed never
// posts a backlog.

export const NAME = "feeds";
export const AREA_FEEDS = "feeds:feeds";
export const AREA_SETTINGS = "feeds:settings";
const JOB = "feedpoll";
export const MAX_FEEDS = 50;
export const MAX_TEMPLATE = 2000;

export interface FeedsConfig {
  pollMinutes: number;
  twitch: { clientId: string; clientSecret: string };
}

const DEFAULTS: FeedsConfig = { pollMinutes: 10, twitch: { clientId: "", clientSecret: "" } };

export interface FeedRow {
  id: number;
  kind: FeedKind;
  source: string;
  label: string;
  channel_id: string;
  role_id: string | null;
  template: string;
  enabled: number;
  state: string;
  created_by: string;
  created_at: number;
  last_check_at: number | null;
  last_post_at: number | null;
  next_check_at: number | null;
  last_error: string | null;
  failures: number;
}

export function config(): FeedsConfig {
  return moduleConfig<FeedsConfig>(NAME);
}

export function twitchCredentials(): TwitchCredentials | undefined {
  const { clientId, clientSecret } = config().twitch;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export async function saveConfig(next: FeedsConfig): Promise<void> {
  const before = config();
  if (before.twitch.clientId !== next.twitch.clientId || before.twitch.clientSecret !== next.twitch.clientSecret) forgetTwitchToken();
  await saveModuleConfig(NAME, next, AREA_SETTINGS);
  // The feeds page shows the interval and whether Twitch is set up.
  notifyChange(AREA_FEEDS);
}

export function clampPollMinutes(minutes: number): number {
  return Math.min(Math.max(Math.round(minutes) || DEFAULTS.pollMinutes, MIN_POLL_MINUTES), MAX_POLL_MINUTES);
}

export async function initFeedTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS feeds_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    label TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    role_id TEXT,
    template TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_check_at INTEGER,
    last_post_at INTEGER,
    next_check_at INTEGER,
    last_error TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    UNIQUE (kind, source, channel_id)
  )`);
  await loadModuleConfig(NAME, DEFAULTS);
}

// --- Reading feeds -------------------------------------------------------------

export async function listFeeds(): Promise<FeedRow[]> {
  return all<FeedRow>("SELECT * FROM feeds_feeds ORDER BY id");
}

export async function feedById(id: number): Promise<FeedRow | undefined> {
  return Number.isInteger(id) ? get<FeedRow>("SELECT * FROM feeds_feeds WHERE id = ?", [id]) : undefined;
}

function stateOf(feed: FeedRow): FeedState {
  try {
    const parsed = JSON.parse(feed.state) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FeedState) : {};
  } catch {
    return {};
  }
}

// --- Validation shared by commands and the GUI -----------------------------------

/** Resolves a source as typed; returns the canonical source and display label, or throws FeedError. */
export async function resolveSource(kind: FeedKind, input: string): Promise<{ source: string; label: string }> {
  switch (kind) {
    case "youtube": {
      const { channelId, title } = await resolveYouTube(input);
      return { source: channelId, label: title };
    }
    case "reddit": {
      const sub = parseSubreddit(input);
      if (!sub) throw new FeedError("Give a subreddit like r/gaming.");
      return { source: sub, label: await resolveReddit(sub) };
    }
    case "twitch": {
      const login = parseTwitchLogin(input);
      if (!login) throw new FeedError("Give a Twitch channel name or twitch.tv link.");
      const creds = twitchCredentials();
      if (!creds) throw new FeedError("Twitch feeds need a Twitch client ID and secret. Add them on the Feeds page first.");
      return { source: login, label: await resolveTwitch(login, creds) };
    }
    case "kick": {
      const slug = parseKickSlug(input);
      if (!slug) throw new FeedError("Give a Kick channel name or kick.com link.");
      // Kick's check is unreliable, so a blocked lookup doesn't stop the feed being added.
      try {
        return { source: slug, label: (await fetchKick(slug)).name };
      } catch (err) {
        if (err instanceof FeedError && err.status === 404) throw err;
        return { source: slug, label: slug };
      }
    }
  }
}

/** Why a channel can't take feed posts, or undefined when it can. */
export async function textChannelProblem(channelId: string): Promise<string | undefined> {
  if (!channelId) return "Pick a channel.";
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    if (channel.channelType !== ChannelType.Text && channel.channelType !== ChannelType.ThreadedText) return "Pick a text channel.";
    return undefined;
  } catch (err) {
    const code = errorCode(err);
    if (code === ErrorCodeType.NotFound || code === ErrorCodeType.RequestValidationFailed) return "That channel doesn't exist anymore.";
    return describeError(err);
  }
}

/** Why a role can't be mentioned by feeds, or undefined when it can. */
export async function roleProblem(roleId: string): Promise<string | undefined> {
  if (roleId === WellKnownRootGuids.CommunityRoles.EveryoneRole) return "Pick a role other than @everyone.";
  const roles = await listRoles();
  return roles.some((r) => r.id === roleId) ? undefined : "I couldn't find that role.";
}

// --- Changing feeds --------------------------------------------------------------

export async function addFeed(options: {
  kind: FeedKind;
  source: string;
  label: string;
  channelId: string;
  roleId?: string;
  template?: string;
  createdBy: string;
}): Promise<{ problem: string } | { feed: FeedRow }> {
  const count = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM feeds_feeds"))?.n ?? 0;
  if (count >= MAX_FEEDS) return { problem: `There are already ${MAX_FEEDS} feeds. Remove one first.` };
  const dupe = await get<FeedRow>("SELECT * FROM feeds_feeds WHERE kind = ? AND source = ? AND channel_id = ?", [
    options.kind,
    options.source,
    options.channelId,
  ]);
  if (dupe) return { problem: `That feed already posts in this channel (feed #${dupe.id}).` };
  const now = Date.now();
  const { lastID } = await run(
    `INSERT INTO feeds_feeds (kind, source, label, channel_id, role_id, template, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [options.kind, options.source, truncate(options.label, 100), options.channelId, options.roleId || null, options.template ?? "", options.createdBy, now],
  );
  // The first check runs soon and only records what's already there.
  await schedule(lastID, now + 60_000);
  notifyChange(AREA_FEEDS);
  return { feed: (await feedById(lastID))! };
}

export async function updateFeed(
  id: number,
  change: { channelId: string; roleId: string | null; template: string; enabled: boolean },
): Promise<boolean> {
  const feed = await feedById(id);
  if (!feed) return false;
  await run("UPDATE feeds_feeds SET channel_id = ?, role_id = ?, template = ?, enabled = ? WHERE id = ?", [
    change.channelId,
    change.roleId,
    change.template,
    change.enabled ? 1 : 0,
    id,
  ]);
  if (change.enabled && !feed.enabled) {
    // Re-enabled: start over without a backlog of what came out meanwhile.
    await run("UPDATE feeds_feeds SET failures = 0, last_error = NULL, state = ? WHERE id = ?", [JSON.stringify({ ...stateOf(feed), baseline: false }), id]);
    await schedule(id, Date.now() + 60_000);
  } else if (!change.enabled && feed.enabled) {
    await run("UPDATE feeds_feeds SET next_check_at = NULL WHERE id = ?", [id]);
    await cancelJobs(JOB, id).catch(() => undefined);
  }
  notifyChange(AREA_FEEDS);
  return true;
}

export async function removeFeed(id: number): Promise<boolean> {
  const { changes } = await run("DELETE FROM feeds_feeds WHERE id = ?", [id]);
  if (!changes) return false;
  notifyChange(AREA_FEEDS);
  await cancelJobs(JOB, id).catch((err) => log("warn", "feeds: cancel job failed", { error: errMessage(err) }));
  return true;
}

// --- Checking ----------------------------------------------------------------------

async function schedule(id: number, at: number): Promise<void> {
  await run("UPDATE feeds_feeds SET next_check_at = ? WHERE id = ?", [at, id]);
  try {
    await cancelJobs(JOB, id);
    await scheduleOnce(JOB, id, at);
  } catch (err) {
    // The startup/daily reconcile reschedules feeds with no job.
    log("warn", "feeds: scheduling failed", { feed: id, error: errMessage(err) });
  }
}

/** Latest items (uploads/posts) or the live stream, from the source. */
async function fetchItems(feed: FeedRow): Promise<{ items: FeedItem[]; live?: FeedItem; isLive: boolean }> {
  switch (feed.kind) {
    case "youtube":
      return { items: (await fetchYouTube(feed.source)).items, isLive: false };
    case "reddit":
      return { items: await fetchReddit(feed.source), isLive: false };
    case "twitch": {
      const creds = twitchCredentials();
      if (!creds) throw new FeedError("Twitch credentials are missing. Add them on the Feeds page.");
      const live = await fetchTwitch(feed.source, creds);
      return { items: [], live, isLive: true };
    }
    case "kick": {
      const { live } = await fetchKick(feed.source);
      return { items: [], live, isLive: true };
    }
  }
}

async function roleMentionFor(roleId: string | null): Promise<string> {
  if (!roleId) return "";
  const role = (await listRoles().catch(() => [])).find((r) => r.id === roleId);
  return role ? roleMention(role.name, role.id) : "";
}

export function render(feed: FeedRow, item: FeedItem, mention: string): string {
  return renderPost({ kind: feed.kind, source: feed.source, template: feed.template, roleMention: mention, item }, MAX_MESSAGE);
}

const checking = new Set<number>();

/** One scheduled check: fetch, post what's new, remember it, schedule the next. */
async function checkFeed(id: number): Promise<void> {
  const feed = await feedById(id);
  if (!feed || !feed.enabled || checking.has(id)) return;
  // A job can arrive twice (live + missed replay); skip one that isn't due.
  if (feed.next_check_at && feed.next_check_at > Date.now() + 2 * 60_000) return;
  checking.add(id);
  try {
    await runCheck(feed);
  } finally {
    checking.delete(id);
  }
}

async function runCheck(feed: FeedRow): Promise<void> {
  const now = Date.now();
  let selection: Selection | undefined;
  let error: string | null = null;
  let failures = feed.failures;
  try {
    const result = await fetchItems(feed);
    const state = stateOf(feed);
    selection = result.isLive ? selectLive(result.live, state, feed.last_post_at, now) : selectNewItems(result.items, state, feed.created_at);
    failures = 0;
  } catch (err) {
    failures = feed.failures + 1;
    error = err instanceof FeedError ? err.message : "The check failed unexpectedly.";
    if (!(err instanceof FeedError)) log("warn", "feeds: check failed", { feed: feed.id, error: errMessage(err) });
  }

  let posted = 0;
  if (selection && selection.post.length > 0) {
    const mention = await roleMentionFor(feed.role_id);
    for (const item of selection.post) {
      try {
        await send(feed.channel_id, render(feed, item, mention));
        posted++;
      } catch (err) {
        // Still marked seen: a channel Taproot can't post in shouldn't flood it later.
        error = `Couldn't post in the channel: ${describeError(err)}`;
        break;
      }
    }
  }

  await run(
    `UPDATE feeds_feeds SET last_check_at = ?, failures = ?, last_error = ?, state = COALESCE(?, state),
       last_post_at = CASE WHEN ? > 0 THEN ? ELSE last_post_at END WHERE id = ?`,
    [now, failures, error, selection ? JSON.stringify(selection.state) : null, posted, now, feed.id],
  );
  // Refresh open pages when something visible changed, not on every quiet check.
  if (posted > 0 || error !== feed.last_error || !feed.last_check_at) notifyChange(AREA_FEEDS);
  const fresh = await feedById(feed.id);
  if (fresh?.enabled) await schedule(feed.id, now + nextDelayMs(config().pollMinutes, failures));
}

/** "feed test" and the GUI's Test button: posts the newest item, or a sample. */
export async function testFeed(feed: FeedRow): Promise<string> {
  let item: FeedItem | undefined;
  let note = "";
  try {
    const result = await fetchItems(feed);
    item = result.isLive ? result.live : [...result.items].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0];
    if (!item) note = result.isLive ? "They're offline, so this is a sample." : "There's nothing there yet, so this is a sample.";
  } catch (err) {
    note = `The check failed (${err instanceof FeedError ? err.message : "unexpected error"}), so this is a sample.`;
  }
  const sample: FeedItem = {
    id: "test",
    title: "Test post from Taproot",
    url: sourceUrl(feed.kind, feed.source),
    author: feed.label.replace(/^r\//, ""),
    game: "Just Chatting",
  };
  const content = render(feed, item ?? sample, await roleMentionFor(feed.role_id));
  await send(feed.channel_id, note ? `${content}\n_${note}_` : content);
  return note ? `Posted a sample in the channel. ${note}` : "Posted the latest item in the channel.";
}

async function reconcile(): Promise<void> {
  const pollMinutes = config().pollMinutes;
  for (const feed of await listFeeds()) {
    if (!feed.enabled) continue;
    if (await hasJob(JOB, feed.id)) continue;
    // Missed its check (outage, failed scheduling): spread the catch-up over the interval.
    await schedule(feed.id, Date.now() + 60_000 + staggerMs(feed.id, pollMinutes));
  }
}

// --- Commands ------------------------------------------------------------------------

function feedLine(f: FeedRow): string {
  const status = !f.enabled ? "paused" : f.last_error ? `⚠️ ${truncate(f.last_error, 80)}` : f.last_check_at ? `checked ${formatUtc(f.last_check_at)}` : "first check pending";
  return `#${f.id} · ${f.kind} · **${f.label.replace(/[*_[\]]/g, "")}** → ${channelMention("channel", f.channel_id)} · ${status}`;
}

export function registerFeedCommands(): void {
  onJob(JOB, checkFeed);
  onReconcile(reconcile);

  register({
    name: "feed",
    category: "Feeds",
    level: Level.Admin,
    usage: "add <youtube|reddit|twitch|kick> <channel or link> #channel [@role] | remove <id> | list | test <id>",
    description: "Post new YouTube uploads, Reddit posts, or Twitch and Kick go-live alerts in a channel.",
    details: [
      "`feed add youtube https://youtube.com/@name #videos @Notify`",
      "`feed add reddit r/gaming #reddit`",
      "`feed add twitch shroud #streams` (needs Twitch credentials, set on the Feeds page)",
      "Feeds are checked every few minutes. Only new items are posted, never what was there before the feed was added.",
      "Change the message template and the check interval on the Feeds page.",
    ],
    async run(ctx) {
      const sub = ctx.args.word();
      if (sub === "list" || sub === undefined) {
        const feeds = await listFeeds();
        if (feeds.length === 0) return ctx.reply(`No feeds yet. Add one with \`${ctx.prefix}feed add\`.`);
        return ctx.reply(feeds.map(feedLine).join("\n"));
      }
      if (sub === "remove" || sub === "delete") {
        const id = Number(ctx.args.word());
        return ctx.reply((await removeFeed(id)) ? `🗑️ Feed #${id} removed.` : "❌ No feed with that number.");
      }
      if (sub === "test") {
        const feed = await feedById(Number(ctx.args.word()));
        if (!feed) return ctx.reply("❌ No feed with that number.");
        const result = await testFeed(feed);
        if (feed.channel_id !== ctx.channelId) await ctx.reply(`🧪 ${result}`);
        return;
      }
      if (sub !== "add") throw new UsageError();

      const kind = ctx.args.word() as FeedKind | undefined;
      if (!kind || !FEED_KINDS.includes(kind)) throw new UsageError("Pick youtube, reddit, twitch, or kick.");
      const raw = ctx.args.next();
      if (!raw || raw.kind !== "word") throw new UsageError("Add the channel, subreddit, or link to follow.");
      const channel = ctx.args.mention("channel");
      if (!channel?.id) throw new UsageError("Mention the channel to post in.");
      const role = ctx.args.mention("role");

      const channelProblem = await textChannelProblem(channel.id);
      if (channelProblem) return ctx.reply(`❌ ${channelProblem}`);
      if (role?.id) {
        const problem = await roleProblem(role.id);
        if (problem) return ctx.reply(`❌ ${problem}`);
      }
      let resolved: { source: string; label: string };
      try {
        resolved = await resolveSource(kind, raw.text);
      } catch (err) {
        return ctx.reply(`❌ ${err instanceof FeedError ? err.message : "I couldn't look that up. Try again in a minute."}`);
      }
      const result = await addFeed({ kind, ...resolved, channelId: channel.id, roleId: role?.id, createdBy: ctx.authorId });
      if ("problem" in result) return ctx.reply(`❌ ${result.problem}`);
      await ctx.reply(
        `✅ Feed #${result.feed.id} added: **${resolved.label.replace(/[*_[\]]/g, "")}** → ${channel.text}. ` +
          `New ${kind === "twitch" || kind === "kick" ? "streams" : "items"} will be posted from now on (checked every ${config().pollMinutes} minutes).`,
      );
    },
  });
}

export { DEFAULT_TEMPLATES };
