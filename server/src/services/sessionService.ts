import { rootServer, ChannelType, Client, WellKnownRootGuids } from "@rootsdk/server-app";
import { SessionServiceBase } from "@taproot/gen-server";
import { ChannelInfo, ChannelList, RoleList, Session, StaffLevel } from "@taproot/gen-shared";
import { read } from "../lib/api";
import { nicknameOf } from "../members";
import { isPrivileged, Level, levelOf, listRoles } from "../permissions";
import { settings } from "../settings";
import { act, requireLevel } from "./auth";

// Who the caller is, plus the channel and role lists the GUI's pickers use.

/** Every channel Taproot can see, in group order. App channels can't take messages, so they're left out. */
export async function visibleChannels(): Promise<ChannelInfo[]> {
  const out: ChannelInfo[] = [];
  const groups = await read("channelGroups.list", () => rootServer.community.channelGroups.list());
  for (const group of groups) {
    const channels = await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: group.id }));
    for (const channel of channels) {
      if (channel.channelType === ChannelType.App) continue;
      out.push({ id: channel.id, name: channel.name, groupName: group.name });
    }
  }
  return out;
}

/** Community roles except @everyone. */
export async function assignableRoles(): Promise<RoleList["roles"]> {
  return (await listRoles())
    .filter((r) => r.id !== WellKnownRootGuids.CommunityRoles.EveryoneRole)
    .map((r) => ({ id: r.id, name: r.name, colorHex: r.colorHex ?? "", privileged: isPrivileged(r) }));
}

class SessionService extends SessionServiceBase {
  async getSession(client: Client): Promise<Session> {
    const level = await levelOf(client.userId);
    return act(async () => {
      const [nickname, community] = await Promise.all([
        nicknameOf(client.userId),
        read("communities.get", () => rootServer.community.communities.get()),
      ]);
      return {
        level: level as number as StaffLevel,
        userId: client.userId,
        nickname,
        communityName: community.name,
        prefix: settings().prefix,
      };
    });
  }

  async listChannels(client: Client): Promise<ChannelList> {
    await requireLevel(client, Level.Moderator);
    return { channels: await act(visibleChannels) };
  }

  async listRoles(client: Client): Promise<RoleList> {
    await requireLevel(client, Level.Member);
    return { roles: await act(assignableRoles) };
  }
}

export const sessionService = new SessionService();
