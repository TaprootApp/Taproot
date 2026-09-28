import { rootServer, ChannelGuid, ChannelType, Client } from "@rootsdk/server-app";
import { FeedsServiceBase } from "@taproot/gen-server";
import {
  FeedsAddRequest,
  FeedsChannelList,
  FeedsFeed,
  FeedsIdRequest,
  FeedsKind,
  FeedsList,
  FeedsSaveSettingsRequest,
  FeedsSettings,
  FeedsTestResponse,
  FeedsUpdateRequest,
  FeedsVoiceLinkList,
  FeedsVoiceLinkRequest,
} from "@taproot/gen-shared";
import { read } from "../../lib/api";
import { Level } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import * as feeds from "./feeds";
import { DEFAULT_TEMPLATES, FEED_KINDS, FeedKind, sourceUrl } from "./logic";
import { FeedError } from "./sources";
import * as voice from "./voice";

// GUI for feeds and voice links (admin only). Everything goes through the
// same functions as the "feed" and "voicelink" commands. The Twitch secret
// is write-only: it's never sent back, only whether one is saved.

const KIND_TO_WIRE: Record<FeedKind, FeedsKind> = {
  youtube: FeedsKind.YOUTUBE,
  reddit: FeedsKind.REDDIT,
  twitch: FeedsKind.TWITCH,
  kick: FeedsKind.KICK,
};

function kindFromWire(kind: FeedsKind): FeedKind | undefined {
  return FEED_KINDS.find((k) => KIND_TO_WIRE[k] === kind);
}

const MAX_SECRET = 200;

// --- Lookups -------------------------------------------------------------------------

const CHANNEL_TTL = 60_000;
let channelCache: { at: number; list: FeedsChannelList["channels"] } | undefined;

/** Text and voice channels Taproot can see, grouped like Root's sidebar. */
async function channelList(force = false): Promise<FeedsChannelList["channels"]> {
  if (!force && channelCache && Date.now() - channelCache.at < CHANNEL_TTL) return channelCache.list;
  const out: FeedsChannelList["channels"] = [];
  const groups = await read("channelGroups.list", () => rootServer.community.channelGroups.list());
  for (const group of groups) {
    const channels = await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: group.id }));
    for (const c of channels) {
      const isVoice = c.channelType === ChannelType.Voice;
      if (!isVoice && c.channelType !== ChannelType.Text && c.channelType !== ChannelType.ThreadedText) continue;
      out.push({ id: c.id, name: c.name, groupName: group.name, voice: isVoice });
    }
  }
  channelCache = { at: Date.now(), list: out };
  return out;
}

async function channelName(id: string): Promise<string> {
  const cached = (await channelList().catch((): FeedsChannelList["channels"] => [])).find((c) => c.id === id);
  if (cached) return cached.name;
  try {
    return (await read("channels.get", () => rootServer.community.channels.get({ id: id as ChannelGuid }))).name;
  } catch {
    return "unknown channel";
  }
}

// --- Conversions ------------------------------------------------------------------------

async function toWire(f: feeds.FeedRow): Promise<FeedsFeed> {
  return {
    id: f.id,
    kind: KIND_TO_WIRE[f.kind] ?? FeedsKind.UNSPECIFIED,
    source: f.source,
    label: f.label,
    channelId: f.channel_id,
    channelName: await channelName(f.channel_id),
    roleId: f.role_id ?? "",
    template: f.template,
    enabled: !!f.enabled,
    createdAtMs: f.created_at,
    lastCheckAtMs: f.last_check_at ?? 0,
    lastPostAtMs: f.last_post_at ?? 0,
    nextCheckAtMs: f.enabled ? f.next_check_at ?? 0 : 0,
    lastError: f.last_error ?? "",
    failures: f.failures,
    sourceUrl: sourceUrl(f.kind, f.source),
  };
}

async function feedList(): Promise<FeedsList> {
  return {
    feeds: await Promise.all((await feeds.listFeeds()).map(toWire)),
    pollMinutes: feeds.config().pollMinutes,
    twitchConfigured: !!feeds.twitchCredentials(),
    defaultTemplates: FEED_KINDS.map((k) => DEFAULT_TEMPLATES[k]),
  };
}

function settingsOut(): FeedsSettings {
  const c = feeds.config();
  return { pollMinutes: c.pollMinutes, twitchClientId: c.twitch.clientId, twitchSecretSet: !!c.twitch.clientSecret };
}

async function linkList(): Promise<FeedsVoiceLinkList> {
  const links = await voice.listLinks();
  return {
    links: await Promise.all(
      links.map(async (l) => ({
        voiceChannelId: l.voice_channel_id,
        voiceChannelName: await channelName(l.voice_channel_id),
        textChannelId: l.text_channel_id,
        textChannelName: await channelName(l.text_channel_id),
        activeMembers: await voice.activeGrantCount(l.text_channel_id),
      })),
    ),
  };
}

function template(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > feeds.MAX_TEMPLATE) invalid(`Keep the template under ${feeds.MAX_TEMPLATE} characters.`);
  return trimmed;
}

async function requireTextChannel(id: string): Promise<void> {
  const problem = await act(() => feeds.textChannelProblem(id));
  if (problem) invalid(problem);
}

async function requireRole(id: string): Promise<void> {
  if (!id) return;
  const problem = await act(() => feeds.roleProblem(id));
  if (problem) invalid(problem);
}

// --- Service --------------------------------------------------------------------------------

class FeedsService extends FeedsServiceBase {
  async listFeeds(client: Client): Promise<FeedsList> {
    await requireLevel(client, Level.Admin);
    return act(feedList);
  }

  async addFeed(request: FeedsAddRequest, client: Client): Promise<FeedsList> {
    await requireLevel(client, Level.Admin);
    const kind = kindFromWire(request.kind) ?? invalid("Pick YouTube, Reddit, Twitch, or Kick.");
    const input = request.source.trim();
    if (!input || input.length > 300) invalid("Enter the channel, subreddit, or link to follow.");
    const text = template(request.template);
    await requireTextChannel(request.channelId);
    await requireRole(request.roleId);
    let resolved: { source: string; label: string };
    try {
      resolved = await feeds.resolveSource(kind, input);
    } catch (err) {
      invalid(err instanceof FeedError ? err.message : "I couldn't look that up. Try again in a minute.");
    }
    const result = await act(() =>
      feeds.addFeed({ kind, ...resolved, channelId: request.channelId, roleId: request.roleId || undefined, template: text, createdBy: client.userId }),
    );
    if ("problem" in result) invalid(result.problem);
    return act(feedList);
  }

  async updateFeed(request: FeedsUpdateRequest, client: Client): Promise<FeedsList> {
    await requireLevel(client, Level.Admin);
    const feed = (await act(() => feeds.feedById(request.id))) ?? notFound("That feed doesn't exist anymore.");
    const text = template(request.template);
    if (request.channelId !== feed.channel_id) await requireTextChannel(request.channelId);
    if (request.roleId && request.roleId !== feed.role_id) await requireRole(request.roleId);
    const change = { channelId: request.channelId, roleId: request.roleId || null, template: text, enabled: request.enabled };
    if (!(await act(() => feeds.updateFeed(feed.id, change)))) notFound("That feed doesn't exist anymore.");
    return act(feedList);
  }

  async removeFeed(request: FeedsIdRequest, client: Client): Promise<FeedsList> {
    await requireLevel(client, Level.Admin);
    if (!(await act(() => feeds.removeFeed(request.id)))) notFound("That feed doesn't exist anymore.");
    return act(feedList);
  }

  async testFeed(request: FeedsIdRequest, client: Client): Promise<FeedsTestResponse> {
    await requireLevel(client, Level.Admin);
    const feed = (await act(() => feeds.feedById(request.id))) ?? notFound("That feed doesn't exist anymore.");
    return { result: await act(() => feeds.testFeed(feed)) };
  }

  async getSettings(client: Client): Promise<FeedsSettings> {
    await requireLevel(client, Level.Admin);
    return settingsOut();
  }

  async saveSettings(request: FeedsSaveSettingsRequest, client: Client): Promise<FeedsSettings> {
    await requireLevel(client, Level.Admin);
    if (!Number.isFinite(request.pollMinutes)) invalid("Pick how often to check.");
    const current = feeds.config();
    const next: feeds.FeedsConfig = {
      pollMinutes: feeds.clampPollMinutes(request.pollMinutes),
      twitch: { ...current.twitch },
    };
    if (request.clearTwitch) next.twitch = { clientId: "", clientSecret: "" };
    else {
      const clientId = request.twitchClientId.trim();
      const secret = request.twitchClientSecret.trim();
      if (clientId && !/^[a-z0-9]{10,64}$/i.test(clientId)) invalid("That doesn't look like a Twitch client ID.");
      if (secret && (secret.length > MAX_SECRET || !/^[a-z0-9]+$/i.test(secret))) invalid("That doesn't look like a Twitch client secret.");
      if (secret && !clientId) invalid("Enter the client ID too.");
      // A new client ID invalidates the old secret.
      if (clientId !== current.twitch.clientId && !secret && clientId) invalid("Enter the secret for the new client ID.");
      next.twitch = { clientId, clientSecret: secret || (clientId ? current.twitch.clientSecret : "") };
    }
    await act(() => feeds.saveConfig(next));
    return settingsOut();
  }

  async listVoiceLinks(client: Client): Promise<FeedsVoiceLinkList> {
    await requireLevel(client, Level.Admin);
    return act(linkList);
  }

  async addVoiceLink(request: FeedsVoiceLinkRequest, client: Client): Promise<FeedsVoiceLinkList> {
    await requireLevel(client, Level.Admin);
    const problem =
      (await act(() => voice.channelProblem(request.voiceChannelId, "voice"))) ??
      (await act(() => voice.channelProblem(request.textChannelId, "text")));
    if (problem) invalid(problem.replace(/\*\*/g, ""));
    const refused = await act(() => voice.addLink(request.voiceChannelId, request.textChannelId, client.userId));
    if (refused) invalid(refused);
    return act(linkList);
  }

  async removeVoiceLink(request: FeedsVoiceLinkRequest, client: Client): Promise<FeedsVoiceLinkList> {
    await requireLevel(client, Level.Admin);
    if (!(await act(() => voice.removeLink(request.voiceChannelId)))) notFound("That voice channel isn't linked.");
    return act(linkList);
  }

  async listChannels(client: Client): Promise<FeedsChannelList> {
    await requireLevel(client, Level.Admin);
    return { channels: await act(() => channelList(true)) };
  }
}

export const feedsService = new FeedsService();

onChange((area) => {
  if (area.startsWith("feeds:")) feedsService.broadcastFeedsChanged({ area }, "all");
});
