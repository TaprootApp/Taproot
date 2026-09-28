import { rootServer, Client } from "@rootsdk/server-app";
import { UtilityServiceBase } from "@taproot/gen-server";
import {
  UtilityAfkStatus,
  UtilityAutoresponder,
  UtilityAutoresponderList,
  UtilityHighlightList,
  UtilityIdRequest,
  UtilityKeywordRequest,
  UtilityMatchMode,
  UtilitySetAfkRequest,
} from "@taproot/gen-shared";
import { emojiAsTyped } from "../../features/emoji";
import { log, errMessage } from "../../lib/log";
import { Level, levelOf } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import { AFK_AREA, afkOf, AfkRow, clearAfk, setAfk } from "./afk";
import { Autoresponder, AR_AREA, deleteAutoresponder, listAutoresponders, saveAutoresponder } from "./autoresponder";
import { addHighlight, clearHighlights, HL_AREA, highlightsOf, removeHighlight } from "./highlights";
import { MAX_AFK_MESSAGE, MAX_AUTORESPONDERS, MAX_HIGHLIGHTS, MAX_RESPONSE, MAX_TRIGGER, MatchMode } from "./logic";
import { channelName } from "./shared";

// GUI for the utility module: each member's own AFK and highlight keywords,
// and the autoresponder list for moderators. Every change goes through the
// same functions as the text commands.

const MATCH_TO_WIRE: Record<MatchMode, UtilityMatchMode> = {
  exact: UtilityMatchMode.EXACT,
  contains: UtilityMatchMode.CONTAINS,
  starts: UtilityMatchMode.STARTS_WITH,
  wildcard: UtilityMatchMode.WILDCARD,
};

function matchFromWire(mode: UtilityMatchMode): MatchMode | undefined {
  return (Object.keys(MATCH_TO_WIRE) as MatchMode[]).find((k) => MATCH_TO_WIRE[k] === mode);
}

function toAfk(row: AfkRow | undefined): UtilityAfkStatus {
  return row ? { afk: true, message: row.message, sinceAtMs: row.since } : { afk: false, message: "", sinceAtMs: 0 };
}

function highlightList(userId: string): UtilityHighlightList {
  return { keywords: highlightsOf(userId), max: MAX_HIGHLIGHTS };
}

async function toWire(ar: Autoresponder): Promise<UtilityAutoresponder> {
  return {
    id: ar.id,
    trigger: ar.trigger,
    match: MATCH_TO_WIRE[ar.match],
    response: ar.response,
    reaction: ar.reaction ? emojiAsTyped(ar.reaction) : "",
    channelIds: ar.channel_ids,
    cooldownSeconds: ar.cooldown_s,
    uses: ar.uses,
    channelNames: await Promise.all(ar.channel_ids.map(channelName)),
  };
}

async function arList(): Promise<UtilityAutoresponderList> {
  return { autoresponders: await Promise.all((await listAutoresponders()).map(toWire)), max: MAX_AUTORESPONDERS };
}

class UtilityService extends UtilityServiceBase {
  // AFK (anyone, their own).

  async getMyAfk(client: Client): Promise<UtilityAfkStatus> {
    await requireLevel(client, Level.Member);
    return toAfk(await afkOf(client.userId));
  }

  async setMyAfk(request: UtilitySetAfkRequest, client: Client): Promise<UtilityAfkStatus> {
    await requireLevel(client, Level.Member);
    if (request.message.length > MAX_AFK_MESSAGE * 2) invalid(`Keep the message under ${MAX_AFK_MESSAGE} characters.`);
    return toAfk(await setAfk(client.userId, request.message));
  }

  async clearMyAfk(client: Client): Promise<UtilityAfkStatus> {
    await requireLevel(client, Level.Member);
    await clearAfk(client.userId);
    return toAfk(undefined);
  }

  // Highlights (anyone, their own).

  async listMyHighlights(client: Client): Promise<UtilityHighlightList> {
    await requireLevel(client, Level.Member);
    return highlightList(client.userId);
  }

  async addMyHighlight(request: UtilityKeywordRequest, client: Client): Promise<UtilityHighlightList> {
    await requireLevel(client, Level.Member);
    if (request.keyword.length > 200) invalid("That keyword is too long.");
    const result = await addHighlight(client.userId, request.keyword);
    if ("problem" in result) invalid(result.problem);
    return highlightList(client.userId);
  }

  async removeMyHighlight(request: UtilityKeywordRequest, client: Client): Promise<UtilityHighlightList> {
    await requireLevel(client, Level.Member);
    if (!(await removeHighlight(client.userId, request.keyword))) notFound("That isn't one of your keywords.");
    return highlightList(client.userId);
  }

  async clearMyHighlights(client: Client): Promise<UtilityHighlightList> {
    await requireLevel(client, Level.Member);
    await clearHighlights(client.userId);
    return highlightList(client.userId);
  }

  // Autoresponders (moderator+).

  async listAutoresponders(client: Client): Promise<UtilityAutoresponderList> {
    await requireLevel(client, Level.Moderator);
    return act(arList);
  }

  async saveAutoresponder(request: UtilityAutoresponder, client: Client): Promise<UtilityAutoresponderList> {
    await requireLevel(client, Level.Moderator);
    const match = matchFromWire(request.match) ?? invalid("Pick how the trigger matches.");
    if (request.trigger.length > MAX_TRIGGER * 2 || request.response.length > MAX_RESPONSE * 2 || request.reaction.length > 100) {
      invalid("That's too long.");
    }
    if (!Array.isArray(request.channelIds) || request.channelIds.length > 50) invalid("Pick at most 50 channels.");
    const result = await act(() =>
      saveAutoresponder(
        {
          id: request.id > 0 ? request.id : undefined,
          trigger: request.trigger,
          match,
          response: request.response,
          reaction: request.reaction,
          channelIds: request.channelIds.filter((c) => typeof c === "string" && c.length <= 64),
          cooldownSeconds: Math.round(request.cooldownSeconds),
        },
        client.userId,
      ),
    );
    if ("problem" in result) {
      if (result.problem.startsWith("No autoresponder")) notFound(result.problem);
      invalid(result.problem);
    }
    return act(arList);
  }

  async deleteAutoresponder(request: UtilityIdRequest, client: Client): Promise<UtilityAutoresponderList> {
    await requireLevel(client, Level.Moderator);
    if (!(await deleteAutoresponder(request.id))) notFound("That autoresponder doesn't exist anymore.");
    return act(arList);
  }
}

export const utilityService = new UtilityService();

/** Clients of one member, for their own AFK/highlight changes. */
function clientsOf(userId: string): Client[] {
  return rootServer.clients.getClients().filter((c) => c.userId === userId);
}

async function staffClients(): Promise<Client[]> {
  const clients = rootServer.clients.getClients();
  const levels = await Promise.all(clients.map((c) => levelOf(c.userId).catch(() => Level.Member)));
  return clients.filter((_, i) => levels[i] >= Level.Moderator);
}

onChange((area) => {
  try {
    for (const prefix of [AFK_AREA, HL_AREA]) {
      if (area.startsWith(`${prefix}:`)) {
        const clients = clientsOf(area.slice(prefix.length + 1));
        if (clients.length) utilityService.broadcastUtilityChanged({ area: prefix }, clients);
        return;
      }
    }
    if (area === AR_AREA) {
      staffClients()
        .then((clients) => {
          if (clients.length) utilityService.broadcastUtilityChanged({ area }, clients);
        })
        .catch((err) => log("warn", "autoresponder broadcast failed", { error: errMessage(err) }));
    }
  } catch (err) {
    log("warn", "utility broadcast failed", { error: errMessage(err) });
  }
});
