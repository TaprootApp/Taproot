import { rootServer, ChannelGuid, RootGuidType, RootGuidUtils } from "@rootsdk/server-app";
import { read } from "../../lib/api";

// Small lookups shared by the utility module's features.

export const NAME = "utility";

export function isBot(userId: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(userId) === RootGuidType.App;
  } catch {
    return false;
  }
}

/** When a Root GUID was minted (GUIDs are time-ordered), or undefined if unreadable. */
export function guidTime(id: string): number | undefined {
  try {
    const ms = RootGuidUtils.toMilliseconds(id);
    // Anything before 2020 means the GUID wasn't time-based after all.
    return Number.isFinite(ms) && ms > Date.UTC(2020, 0, 1) ? ms : undefined;
  } catch {
    return undefined;
  }
}

const CHANNEL_TTL = 5 * 60_000;
const channels = new Map<string, { at: number; name: string }>();

/** A channel's name for display; "unknown channel" when it's gone. */
export async function channelName(channelId: string): Promise<string> {
  const cached = channels.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_TTL) return cached.name;
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    channels.set(channelId, { at: Date.now(), name: channel.name });
    return channel.name;
  } catch {
    return "unknown channel";
  }
}

let communityName: { at: number; name: string } | undefined;

export async function serverName(): Promise<string> {
  if (communityName && Date.now() - communityName.at < CHANNEL_TTL) return communityName.name;
  const community = await read("communities.get", () => rootServer.community.communities.get());
  communityName = { at: Date.now(), name: community.name };
  return community.name;
}
