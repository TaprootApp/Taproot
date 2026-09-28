import {
  rootServer,
  ChannelGuid,
  ChannelMessage,
  ErrorCodeType,
  MessageGuid,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { errorCode, read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { MAX_MESSAGE, truncate } from "../../lib/text";
import { rememberNickname, lastKnownNickname } from "../../members";

// SDK helpers shared by the events features.

export const MODULE = "events";
export const AREA_GIVEAWAYS = "events:giveaways";
export const AREA_POLLS = "events:polls";
export const AREA_STARBOARD = "events:starboard";

export function isBot(userId: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(userId as UserGuid) === RootGuidType.App;
  } catch {
    return false;
  }
}

const CHANNEL_TTL = 60_000;
const channelNames = new Map<string, { at: number; name: string }>();

/** A channel's name for display; never throws. */
export async function channelName(channelId: string): Promise<string> {
  const cached = channelNames.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_TTL) return cached.name;
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    channelNames.set(channelId, { at: Date.now(), name: channel.name });
    return channel.name;
  } catch {
    return "unknown channel";
  }
}

/** The message, or undefined when it's gone or unreadable. */
export async function fetchMessage(channelId: string, messageId: string): Promise<ChannelMessage | undefined> {
  try {
    return await read("channelMessages.get", () =>
      rootServer.community.channelMessages.get({ channelId: channelId as ChannelGuid, id: messageId as MessageGuid }),
    );
  } catch (err) {
    if (errorCode(err) !== ErrorCodeType.NotFound) log("warn", "message fetch failed", { error: errMessage(err) });
    return undefined;
  }
}

/** Edits one of Taproot's messages. Best effort: false if it failed. */
export async function editMessage(channelId: string, messageId: string, content: string): Promise<boolean> {
  try {
    await write("channelMessages.edit", () =>
      rootServer.community.channelMessages.edit({
        channelId: channelId as ChannelGuid,
        id: messageId as MessageGuid,
        content: truncate(content, MAX_MESSAGE),
      }),
    );
    return true;
  } catch (err) {
    log("warn", "message edit failed", { error: errMessage(err) });
    return false;
  }
}

/** Adds Taproot's own reaction so members can click it. False if it failed. */
export async function seedReaction(channelId: string, messageId: string, shortcode: string): Promise<boolean> {
  try {
    await write("channelMessages.reactionCreate", () =>
      rootServer.community.channelMessages.reactionCreate({
        channelId: channelId as ChannelGuid,
        messageId: messageId as MessageGuid,
        shortcode,
      }),
    );
    return true;
  } catch (err) {
    log("warn", "seed reaction failed", { shortcode, error: errMessage(err) });
    return false;
  }
}

export interface MemberInfo {
  nickname: string;
  roleIds: string[];
}

/** The member, or undefined when they've left. Other failures throw. */
export async function memberInfo(userId: string): Promise<MemberInfo | undefined> {
  try {
    const m = await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId: userId as UserGuid }));
    await rememberNickname(userId, m.nickname).catch(() => undefined);
    return { nickname: m.nickname, roleIds: m.communityRoleIds };
  } catch (err) {
    const code = errorCode(err);
    if (code === ErrorCodeType.NotFound || code === ErrorCodeType.RequestValidationFailed) return undefined;
    throw err;
  }
}

/** Display name without a live lookup when possible (lists, rendering). */
export async function displayName(userId: string): Promise<string> {
  const known = await lastKnownNickname(userId);
  if (known) return known;
  try {
    return (await memberInfo(userId))?.nickname ?? "Unknown member";
  } catch {
    return "Unknown member";
  }
}

/** Private ping on the member's device. Titles and descriptions are clipped to Root's limits. */
export async function notifyMember(userId: string, title: string, description: string): Promise<void> {
  try {
    await write("notifications.send", () =>
      rootServer.community.notifications.send({
        title: truncate(title, 50),
        description: truncate(description, 150),
        userIds: [userId as UserGuid],
      }),
    );
  } catch (err) {
    log("warn", "notification failed", { error: errMessage(err) });
  }
}
