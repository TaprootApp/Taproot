import { rootServer, ChannelGuid, CommunityMember, CommunityRole, RootGuidType, RootGuidUtils, UserGuid } from "@rootsdk/server-app";
import { CommandContext, register, UsageError } from "../../commands/registry";
import { read } from "../../lib/api";
import { formatDuration } from "../../lib/time";
import { nicknameOf } from "../../members";
import { isPrivileged, Level, levelOf, listRoles } from "../../permissions";
import { afkOf } from "./afk";
import { memberCanSeeChannel } from "./highlights";
import { guidTime } from "./shared";

// Info commands: whois, serverinfo, roleinfo, avatar, membercount, channelinfo.
// Replies name members and roles in bold instead of mentioning them, so
// looking someone up never pings them (or a whole role).

const LEVEL_LABEL: Record<Level, string> = {
  [Level.Member]: "Member",
  [Level.Moderator]: "Moderator",
  [Level.Admin]: "Admin",
  [Level.Owner]: "Owner",
};

// listAll() returns every member; keep it briefly so a burst of commands
// doesn't refetch the whole list each time.
const MEMBERS_TTL = 60_000;
let membersCache: { at: number; members: CommunityMember[] } | undefined;

async function allMembers(): Promise<CommunityMember[]> {
  if (membersCache && Date.now() - membersCache.at < MEMBERS_TTL) return membersCache.members;
  const members = await read("communityMembers.listAll", () => rootServer.community.communityMembers.listAll());
  membersCache = { at: Date.now(), members };
  return members;
}

function date(ms: number | undefined): string {
  if (!ms) return "unknown";
  const d = new Date(ms);
  const ago = Date.now() - ms;
  return `${d.toISOString().slice(0, 10)} (${ago > 60_000 ? `${formatDuration(ago)} ago` : "just now"})`;
}

function bold(text: string): string {
  return `**${text.replace(/\*/g, "")}**`;
}

function isUserId(text: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(text) === RootGuidType.Person;
  } catch {
    return false;
  }
}

/** A mentioned member, a raw user ID, or the invoker. */
function takeUser(ctx: CommandContext): UserGuid {
  const mention = ctx.args.mention("user");
  if (mention?.id) return mention.id as UserGuid;
  const next = ctx.args.peek();
  if (next?.kind === "word" && isUserId(next.text)) {
    ctx.args.next();
    return next.text as UserGuid;
  }
  if (next) throw new UsageError("Mention a member, or give their user ID.");
  return ctx.authorId;
}

async function getMember(userId: UserGuid): Promise<CommunityMember | undefined> {
  try {
    return await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId }));
  } catch {
    return undefined;
  }
}

/** A usable https link for a Root asset URI, when Root will give one. */
async function assetLink(uri: string | undefined): Promise<string | undefined> {
  if (!uri) return undefined;
  if (/^https?:\/\//.test(uri)) return uri;
  try {
    const { assets } = await read("assets.get", () => rootServer.dataStore.assets.get({ uris: [uri] }));
    const info = assets[uri] ?? Object.values(assets)[0];
    const link = info?.link;
    if (link?.oneofKind === "url") return link.url;
    if (link?.oneofKind === "image") {
      const best = [...link.image.assetLinks].sort((a, b) => b.largestDimensionLimit - a.largestDimensionLimit)[0];
      return best?.url;
    }
  } catch {
    // Fall through: no link.
  }
  return undefined;
}

async function findRole(ctx: CommandContext): Promise<CommunityRole | undefined> {
  const roles = await listRoles();
  const mention = ctx.args.mention("role");
  if (mention?.id) return roles.find((r) => r.id === mention.id);
  const text = ctx.args.rest().replace(/^@/, "").trim().toLowerCase();
  if (!text) throw new UsageError("Mention a role or type its name.");
  return roles.find((r) => r.name.toLowerCase() === text) ?? roles.find((r) => r.id === text);
}

const PERMISSION_LABELS: Array<[keyof CommunityRole["communityPermission"], string]> = [
  ["communityFullControl", "Full Control"],
  ["communityManageCommunity", "Manage Community"],
  ["communityManageRoles", "Manage Roles"],
  ["communityManageApps", "Manage Apps"],
  ["communityKick", "Kick"],
  ["communityCreateBan", "Ban"],
  ["communityManageBans", "Manage Bans"],
];

export function registerInfo(): void {
  register(
    {
      name: "whois",
      aliases: ["userinfo"],
      category: "Info",
      level: Level.Member,
      usage: "[@member | user ID]",
      description: "Show a member's name, ID, join date, roles and staff level.",
      async run(ctx) {
        const userId = takeUser(ctx);
        const member = await getMember(userId);
        if (!member) return ctx.reply("❌ That person isn't in this community.");
        const [roles, level, avatar, afk] = await Promise.all([listRoles(), levelOf(userId), assetLink(member.profilePictureAssetUri), afkOf(userId)]);
        const roleNames = member.communityRoleIds
          .map((id) => roles.find((r) => r.id === id)?.name)
          .filter((n): n is string => Boolean(n));
        const lines = [
          `👤 ${bold(member.nickname)}`,
          `**User ID:** \`${userId}\``,
          `**Joined:** ${date(member.joinedAt?.getTime())}`,
          `**Account created:** ${date(guidTime(userId))}`,
          `**Roles (${roleNames.length}):** ${roleNames.length ? roleNames.map(bold).join(", ") : "none"}`,
          `**Staff level:** ${LEVEL_LABEL[level]}`,
        ];
        if (afk) lines.push(`**AFK:** ${afk.message}`);
        lines.push(avatar ? `**Avatar:** [open](${avatar})` : "**Avatar:** none");
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "avatar",
      category: "Info",
      level: Level.Member,
      usage: "[@member | user ID]",
      description: "Link to a member's profile picture.",
      async run(ctx) {
        const userId = takeUser(ctx);
        const member = await getMember(userId);
        if (!member) return ctx.reply("❌ That person isn't in this community.");
        const link = await assetLink(member.profilePictureAssetUri);
        if (!link) return ctx.reply(`${bold(member.nickname)} has no profile picture.`);
        await ctx.reply(`🖼️ ${bold(member.nickname)}'s avatar: ${link}`);
      },
    },
    {
      name: "serverinfo",
      category: "Info",
      level: Level.Member,
      usage: "",
      description: "Show the community's owner, member count, roles, channels and age.",
      async run(ctx) {
        const community = await read("communities.get", () => rootServer.community.communities.get());
        const [owner, members, roles, groups] = await Promise.all([
          nicknameOf(community.ownerUserId),
          allMembers(),
          listRoles(),
          read("channelGroups.list", () => rootServer.community.channelGroups.list()),
        ]);
        let channels = 0;
        for (const group of groups) {
          channels += (await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: group.id }))).length;
        }
        const lines = [
          `🏠 ${bold(community.name)}`,
          community.description ? `> ${community.description.replace(/\s+/g, " ").slice(0, 300)}` : undefined,
          `**Owner:** ${bold(owner)}`,
          `**Members:** ${members.length.toLocaleString("en-US")}`,
          `**Roles:** ${roles.length}`,
          `**Channels:** ${channels} in ${groups.length} group${groups.length === 1 ? "" : "s"}`,
          `**Created:** ${date(guidTime(community.communityId))}`,
          `**Community ID:** \`${community.communityId}\``,
        ];
        await ctx.reply(lines.filter(Boolean).join("\n"));
      },
    },
    {
      name: "membercount",
      category: "Info",
      level: Level.Member,
      usage: "",
      description: "How many members the community has.",
      async run(ctx) {
        const members = await allMembers();
        const bots = members.filter((m) => {
          try {
            return RootGuidUtils.toRootGuidType(m.userId) === RootGuidType.App;
          } catch {
            return false;
          }
        }).length;
        const people = members.length - bots;
        await ctx.reply(`👥 **${people.toLocaleString("en-US")}** member${people === 1 ? "" : "s"}${bots ? ` (+${bots} app${bots === 1 ? "" : "s"})` : ""}.`);
      },
    },
    {
      name: "roleinfo",
      category: "Info",
      level: Level.Member,
      usage: "<@role | role name>",
      description: "Show a role's ID, color, member count and staff permissions.",
      async run(ctx) {
        const role = await findRole(ctx);
        if (!role) return ctx.reply("❌ I couldn't find that role.");
        const members = await allMembers();
        const count = members.filter((m) => m.communityRoleIds.includes(role.id)).length;
        const perms = PERMISSION_LABELS.filter(([key]) => role.communityPermission?.[key]).map(([, label]) => label);
        const lines = [
          `🏷️ ${bold(role.name)}`,
          `**Role ID:** \`${role.id}\``,
          `**Color:** ${role.colorHex ? `\`${role.colorHex}\`` : "none"}`,
          `**Members:** ${count.toLocaleString("en-US")}`,
          `**Mentionable:** ${role.isMentionable ? "yes" : "no"}`,
          `**Staff permissions:** ${perms.length ? perms.join(", ") : isPrivileged(role) ? "yes" : "none"}`,
        ];
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "channelinfo",
      category: "Info",
      level: Level.Member,
      usage: "[#channel]",
      description: "Show a channel's ID, group, topic and age.",
      async run(ctx) {
        const channelId = ctx.args.mention("channel")?.id ?? ctx.channelId;
        // A mention can name any channel by ID; members only learn about ones they can see.
        if (channelId !== ctx.channelId && ctx.level < Level.Moderator && !(await memberCanSeeChannel(ctx.authorId, channelId))) {
          return ctx.reply("❌ I couldn't find that channel.");
        }
        const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
        const group = await read("channelGroups.get", () => rootServer.community.channelGroups.get({ id: channel.channelGroupId })).catch(
          () => undefined,
        );
        const lines = [
          `#️⃣ ${bold(channel.name)}`,
          channel.description ? `> ${channel.description.replace(/\s+/g, " ").slice(0, 300)}` : undefined,
          `**Channel ID:** \`${channel.id}\``,
          `**Group:** ${group ? bold(group.name) : "unknown"}`,
          `**Permissions:** ${channel.useChannelGroupPermission ? "same as its group" : "its own"}`,
          `**Created:** ${date(guidTime(channel.id))}`,
        ];
        await ctx.reply(lines.filter(Boolean).join("\n"));
      },
    },
  );
}
