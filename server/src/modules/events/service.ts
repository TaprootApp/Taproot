import { rootServer, ChannelGuid, Client, ErrorCodeType } from "@rootsdk/server-app";
import { EventsServiceBase } from "@taproot/gen-server";
import {
  EventsCreateGiveawayRequest,
  EventsCreatePollRequest,
  EventsGiveaway,
  EventsGiveawayList,
  EventsGiveawayState,
  EventsIdRequest,
  EventsPoll,
  EventsPollList,
  EventsRerollRequest,
  EventsStarboardConfig,
  EventsStarboardView,
} from "@taproot/gen-shared";
import { resolveEmojiText } from "../../features/roles";
import { errorCode, read } from "../../lib/api";
import { Level, listRoles } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import * as giveaways from "./giveaways";
import { MAX_WINNERS, pollProblem, STAR_THRESHOLD_MAX } from "./logic";
import * as polls from "./polls";
import { AREA_GIVEAWAYS, AREA_POLLS, AREA_STARBOARD, channelName, displayName } from "./shared";
import { saveStarboard, starboardConfig, starboardStats } from "./starboard";

// GUI service for giveaways, polls (moderator+) and starboard settings
// (admin). Every change goes through the same functions as the text
// commands, so rules and side effects are identical.

const STATE_TO_WIRE: Record<string, EventsGiveawayState> = {
  running: EventsGiveawayState.RUNNING,
  ended: EventsGiveawayState.ENDED,
  cancelled: EventsGiveawayState.CANCELLED,
};

/** Checks a channel from the GUI exists before posting to it. */
async function requireChannel(channelId: string): Promise<void> {
  if (!channelId) invalid("Pick a channel.");
  try {
    await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
  } catch (err) {
    if (errorCode(err) === ErrorCodeType.NotFound || errorCode(err) === ErrorCodeType.RequestValidationFailed) {
      invalid("That channel doesn't exist anymore.");
    }
    await act(() => Promise.reject(err));
  }
}

async function member(userId: string) {
  return { userId, nickname: await displayName(userId) };
}

async function toGiveaway(g: giveaways.Giveaway): Promise<EventsGiveaway> {
  return {
    id: g.id,
    channelId: g.channel_id,
    channelName: await channelName(g.channel_id),
    prize: g.prize,
    winnerCount: g.winner_count,
    requiredRoleId: g.required_role_id ?? undefined,
    host: await member(g.host_id),
    endsAtMs: g.ends_at,
    state: STATE_TO_WIRE[g.state] ?? EventsGiveawayState.UNSPECIFIED,
    entryCount: await giveaways.entryCount(g.id),
    winners: await Promise.all(giveaways.winnersOf(g).map((w) => member(w.id))),
    createdAtMs: g.created_at,
    endedAtMs: g.ended_at ?? 0,
  };
}

async function toPoll(p: polls.Poll): Promise<EventsPoll> {
  const counts = await polls.pollCounts(p);
  return {
    id: p.id,
    channelId: p.channel_id,
    channelName: await channelName(p.channel_id),
    question: p.question,
    options: polls.optionsOf(p).map((label, i) => ({ label, votes: counts[i] ?? 0 })),
    endsAtMs: p.ends_at ?? 0,
    closed: Boolean(p.closed),
    totalVotes: counts.reduce((a, b) => a + b, 0),
    createdBy: await member(p.created_by),
    createdAtMs: p.created_at,
    closedAtMs: p.closed_at ?? 0,
  };
}

async function starboardView(): Promise<EventsStarboardView> {
  const c = starboardConfig();
  const stats = await starboardStats();
  return {
    config: {
      enabled: c.enabled,
      channelId: c.channelId ?? undefined,
      emoji: c.emoji,
      threshold: c.threshold,
      selfStar: c.selfStar,
      ignoredChannelIds: [...c.ignoredChannels],
      removeBelowThreshold: c.removeBelow,
    },
    stats: { posts: stats.posts, totalStars: stats.totalStars },
  };
}

async function requireGiveaway(id: number): Promise<giveaways.Giveaway> {
  return (await giveaways.giveawayById(id)) ?? notFound("That giveaway doesn't exist anymore.");
}

class EventsService extends EventsServiceBase {
  // Giveaways (moderator+).

  async listGiveaways(client: Client): Promise<EventsGiveawayList> {
    await requireLevel(client, Level.Moderator);
    return act(async () => ({ giveaways: await Promise.all((await giveaways.listGiveaways()).map(toGiveaway)) }));
  }

  async createGiveaway(request: EventsCreateGiveawayRequest, client: Client): Promise<EventsGiveaway> {
    await requireLevel(client, Level.Moderator);
    const input = { prize: request.prize.trim(), winnerCount: request.winnerCount, durationMs: request.durationMs };
    const problem = giveaways.giveawayProblem(input);
    if (problem) invalid(problem);
    const roleId = request.requiredRoleId || undefined;
    if (roleId && !(await act(listRoles)).some((r) => r.id === roleId)) invalid("That role doesn't exist anymore.");
    await requireChannel(request.channelId);
    const { giveaway } = await act(() => giveaways.startGiveaway({ ...input, channelId: request.channelId, roleId, hostId: client.userId }));
    return act(() => toGiveaway(giveaway));
  }

  async endGiveaway(request: EventsIdRequest, client: Client): Promise<EventsGiveaway> {
    await requireLevel(client, Level.Moderator);
    await requireGiveaway(request.id);
    const result = await act(() => giveaways.endGiveaway(request.id));
    if (typeof result === "string") invalid(result);
    return act(() => toGiveaway(result));
  }

  async rerollGiveaway(request: EventsRerollRequest, client: Client): Promise<EventsGiveaway> {
    await requireLevel(client, Level.Moderator);
    await requireGiveaway(request.id);
    const count = request.count || 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_WINNERS) invalid(`Reroll 1 to ${MAX_WINNERS} winners.`);
    const result = await act(() => giveaways.rerollGiveaway(request.id, count));
    if (typeof result === "string") invalid(result);
    if (result.drawn.length === 0) invalid("No one else is eligible to win.");
    return act(() => toGiveaway(result.giveaway));
  }

  async cancelGiveaway(request: EventsIdRequest, client: Client): Promise<EventsGiveaway> {
    await requireLevel(client, Level.Moderator);
    await requireGiveaway(request.id);
    const result = await act(() => giveaways.cancelGiveaway(request.id));
    if (typeof result === "string") invalid(result);
    return act(() => toGiveaway(result));
  }

  // Polls (moderator+).

  async listPolls(client: Client): Promise<EventsPollList> {
    await requireLevel(client, Level.Moderator);
    return act(async () => ({ polls: await Promise.all((await polls.listPolls()).map(toPoll)) }));
  }

  async createPoll(request: EventsCreatePollRequest, client: Client): Promise<EventsPoll> {
    await requireLevel(client, Level.Moderator);
    const question = request.question.trim();
    const options = request.options.map((o) => o.trim()).filter(Boolean);
    const durationMs = Number.isFinite(request.durationMs) ? Math.max(0, request.durationMs) : 0;
    const problem = pollProblem(question, options, durationMs);
    if (problem) invalid(problem.replace(/`/g, ""));
    await requireChannel(request.channelId);
    const { poll } = await act(() =>
      polls.createPoll({ channelId: request.channelId, question, options, durationMs: durationMs || undefined, createdBy: client.userId }),
    );
    return act(() => toPoll(poll));
  }

  async endPoll(request: EventsIdRequest, client: Client): Promise<EventsPoll> {
    await requireLevel(client, Level.Moderator);
    if (!(await polls.pollById(request.id))) notFound("That poll doesn't exist anymore.");
    const result = await act(() => polls.closePoll(request.id));
    if (typeof result === "string") invalid(result);
    return act(() => toPoll(result));
  }

  // Starboard (admin).

  async getStarboard(client: Client): Promise<EventsStarboardView> {
    await requireLevel(client, Level.Admin);
    return act(starboardView);
  }

  async updateStarboard(request: EventsStarboardConfig, client: Client): Promise<EventsStarboardView> {
    await requireLevel(client, Level.Admin);
    const channelId = request.channelId || null;
    if (request.enabled && !channelId) invalid("Pick a starboard channel before turning it on.");
    if (channelId) await requireChannel(channelId);
    if (!Number.isInteger(request.threshold) || request.threshold < 1 || request.threshold > STAR_THRESHOLD_MAX) {
      invalid(`The threshold must be 1 to ${STAR_THRESHOLD_MAX}.`);
    }
    const emoji = (await act(() => resolveEmojiText(request.emoji.trim()))) ?? invalid("Write the emoji as a :shortcode:, like :star:.");
    const ignored = [...new Set(request.ignoredChannelIds.filter((id) => typeof id === "string" && id))].slice(0, 200);
    await act(() =>
      saveStarboard({
        enabled: request.enabled,
        channelId,
        emoji,
        threshold: request.threshold,
        selfStar: request.selfStar,
        ignoredChannels: ignored,
        removeBelow: request.removeBelowThreshold,
      }),
    );
    return act(starboardView);
  }
}

export const eventsService = new EventsService();

const AREAS = new Set([AREA_GIVEAWAYS, AREA_POLLS, AREA_STARBOARD]);
// Reaction bursts (a popular giveaway) are coalesced to one broadcast per area per second.
const pending = new Set<string>();
onChange((area) => {
  if (!AREAS.has(area) || pending.has(area)) return;
  pending.add(area);
  setTimeout(() => {
    pending.delete(area);
    try {
      eventsService.broadcastEventsChanged({ area }, "all");
    } catch {
      // A failed broadcast must never break anything.
    }
  }, 1000);
});
