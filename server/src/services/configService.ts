import { Client, WellKnownRootGuids } from "@rootsdk/server-app";
import { ConfigServiceBase } from "@taproot/gen-server";
import {
  AutomodRules,
  Config,
  GeneralConfig,
  PreviewRequest,
  PreviewResponse,
  WelcomeConfig,
} from "@taproot/gen-shared";
import { renderTemplate } from "../features/welcome";
import { log, errMessage } from "../lib/log";
import { MAX_MESSAGE } from "../lib/text";
import { normalizeDomain, PREFIX_RULE, validPrefix } from "../lib/validate";
import { nicknameOf } from "../members";
import { send } from "../messaging";
import { isPrivileged, Level, listRoles } from "../permissions";
import { AutomodConfig, setSettings, settings } from "../settings";
import { act, invalid, requireLevel } from "./auth";
import { onChange } from "./changes";
import { visibleChannels } from "./sessionService";
import { toWireConfig } from "./wire";

// Everything in settings.ts, for admins. Validation mirrors the text commands
// (prefix, modlog, welcome, autorole, selfrole, automod, automodset, badword,
// allowlink) so the GUI can't save anything a command would refuse.
//
// IDs already saved are accepted even if Root no longer lists them, so a
// deleted channel or role doesn't block saving the rest of a section.

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) invalid(`${name} must be a whole number above 0.`);
  return value;
}

function message(text: string, name: string): string {
  if (!text.trim()) invalid(`${name} can't be empty.`);
  if (text.length > MAX_MESSAGE) invalid(`${name} is too long (${MAX_MESSAGE} characters max).`);
  return text;
}

async function channelIds(ids: string[], saved: readonly string[], what: string): Promise<string[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.every((id) => saved.includes(id))) return unique;
  const known = new Set((await act(visibleChannels)).map((c) => c.id));
  for (const id of unique) {
    if (!known.has(id) && !saved.includes(id)) invalid(`The ${what} channel doesn't exist or Taproot can't see it.`);
  }
  return unique;
}

async function channelId(id: string | undefined, saved: string | null, what: string): Promise<string | null> {
  if (!id) return null;
  return (await channelIds([id], saved ? [saved] : [], what))[0];
}

async function roleIds(ids: string[], saved: readonly string[], what: string, allowPrivileged: boolean): Promise<string[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  const fresh = unique.filter((id) => !saved.includes(id));
  if (fresh.length === 0) return unique;
  const roles = await act(listRoles);
  for (const id of fresh) {
    const role = roles.find((r) => r.id === id);
    if (!role || id === WellKnownRootGuids.CommunityRoles.EveryoneRole) invalid(`One of the ${what} roles doesn't exist.`);
    if (!allowPrivileged && isPrivileged(role)) {
      invalid(`**${role.name}** has staff permissions, so it can't be self-assigned.`);
    }
  }
  return unique;
}

class ConfigService extends ConfigServiceBase {
  constructor() {
    super();
    onChange((area) => {
      if (area !== "general" && area !== "welcome" && area !== "automod") return;
      try {
        this.broadcastConfigChanged({ area }, "all");
      } catch (err) {
        log("warn", "config broadcast failed", { area, error: errMessage(err) });
      }
    });
  }

  async getConfig(client: Client): Promise<Config> {
    await requireLevel(client, Level.Admin);
    return toWireConfig(settings());
  }

  async updateGeneral(request: GeneralConfig, client: Client): Promise<Config> {
    await requireLevel(client, Level.Admin);
    const s = settings();
    const prefix = request.prefix.trim();
    if (!validPrefix(prefix)) invalid(PREFIX_RULE);
    const modLogChannel = await channelId(request.modLogChannelId, s.modLogChannel, "mod log");
    const selfRoles = await roleIds(request.selfRoleIds, s.selfRoles, "self", false);

    // Same as !modlog: announce in the new channel, and don't save if Taproot can't post there.
    if (modLogChannel && modLogChannel !== s.modLogChannel) {
      await act(() => send(modLogChannel, "📋 Taproot will log moderation actions here."));
    }
    await setSettings({ prefix, modLogChannel, selfRoles });
    return toWireConfig(settings());
  }

  async updateWelcome(request: WelcomeConfig, client: Client): Promise<Config> {
    await requireLevel(client, Level.Admin);
    const s = settings();
    const welcomeMessage = message(request.welcomeMessage, "The welcome message");
    const goodbyeMessage = message(request.goodbyeMessage, "The goodbye message");
    const welcomeChannel = await channelId(request.welcomeChannelId, s.welcomeChannel, "welcome");
    const goodbyeChannel = await channelId(request.goodbyeChannelId, s.goodbyeChannel, "goodbye");
    const autoroles = await roleIds(request.autoroleIds, s.autoroles, "autorole", true);
    await setSettings({ welcomeChannel, welcomeMessage, goodbyeChannel, goodbyeMessage, autoroles });
    return toWireConfig(settings());
  }

  async updateAutomod(request: AutomodRules, client: Client): Promise<Config> {
    await requireLevel(client, Level.Admin);
    const current = settings().automod;

    // Split and lowercase like !badword, so entries match the same way.
    const words = [
      ...new Set(
        request.words
          .flatMap((w) => w.split(/[\s,]+/))
          .map((w) => w.toLowerCase())
          .filter(Boolean),
      ),
    ];
    const allow: string[] = [];
    for (const input of request.allowedDomains) {
      if (!input.trim()) continue;
      const domain = normalizeDomain(input.trim());
      if (!domain) invalid(`"${input}" isn't a domain. Use something like youtube.com.`);
      if (!allow.includes(domain)) allow.push(domain);
    }

    const duplicates = positiveInt(request.spamDuplicates, "Duplicates");
    if (duplicates < 2) invalid("Duplicates must be at least 2.");
    const percent = positiveInt(request.capsPercent, "Caps percent");
    if (percent > 100) invalid("Caps percent must be 100 or less.");

    const next: AutomodConfig = {
      enabled: request.enabled,
      words: { enabled: request.wordsEnabled, list: words },
      links: { enabled: request.linksEnabled, allow },
      mentions: {
        enabled: request.mentionsEnabled,
        max: positiveInt(request.maxMentions, "Max mentions"),
        blockAll: request.blockAllMentions,
      },
      spam: {
        enabled: request.spamEnabled,
        messages: positiveInt(request.spamMessages, "Spam messages"),
        seconds: positiveInt(request.spamSeconds, "Spam seconds"),
        duplicates,
      },
      caps: { enabled: request.capsEnabled, percent, minLength: positiveInt(request.capsMinLength, "Caps minimum length") },
      strikes: {
        count: positiveInt(request.strikeCount, "Strike count"),
        windowMinutes: positiveInt(request.strikeWindowMinutes, "Strike window"),
        muteMinutes: positiveInt(request.strikeMuteMinutes, "Mute time"),
      },
      ignoredChannels: await channelIds(request.ignoredChannelIds, current.ignoredChannels, "ignored"),
    };
    await setSettings({ automod: next });
    return toWireConfig(settings());
  }

  async previewTemplate(request: PreviewRequest, client: Client): Promise<PreviewResponse> {
    await requireLevel(client, Level.Admin);
    const template = message(request.template, "The template");
    const content = await act(async () => renderTemplate(template, client.userId, await nicknameOf(client.userId)));
    return { content };
  }
}

export const configService = new ConfigService();
