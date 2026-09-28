import {
  rootServer,
  CommunityEvent,
  CommunityJoinedEvent,
  CommunityLeaveEvent,
  CommunityLeaveReason,
  CommunityRoleGuid,
} from "@rootsdk/server-app";
import { CommandContext, register, UsageError } from "../commands/registry";
import { read, write, describeError } from "../lib/api";
import { log, errMessage } from "../lib/log";
import { channelMention, fillTemplate, roleMention, userMention } from "../lib/text";
import { lastKnownNickname, nicknameOf } from "../members";
import { send } from "../messaging";
import { modLogNotice } from "../modlog";
import { forgetMember, Level, listRoles } from "../permissions";
import { setSetting, settings } from "../settings";

async function communityName(): Promise<string> {
  return (await read("communities.get", () => rootServer.community.communities.get())).name;
}

/** Fills a welcome/goodbye template. Also used by the GUI's preview. */
export async function renderTemplate(template: string, userId: string, name: string): Promise<string> {
  return fillTemplate(template, {
    user: userMention(name, userId),
    "user.name": name,
    server: await communityName(),
  });
}

async function onJoin(evt: CommunityJoinedEvent): Promise<void> {
  const s = settings();
  const name = await nicknameOf(evt.userId);

  for (const roleId of s.autoroles) {
    try {
      await write("communityMemberRoles.add", () =>
        rootServer.community.communityMemberRoles.add({ communityRoleId: roleId as CommunityRoleGuid, userIds: [evt.userId] }),
      );
    } catch (err) {
      log("warn", "autorole failed", { roleId, error: errMessage(err) });
      await modLogNotice(`⚠️ Couldn't give the autorole ${roleMention("role", roleId)} to **${name}**: ${describeError(err)}`);
    }
  }
  forgetMember(evt.userId);

  if (s.welcomeChannel) await send(s.welcomeChannel, await renderTemplate(s.welcomeMessage, evt.userId, name));
}

async function onLeave(evt: CommunityLeaveEvent): Promise<void> {
  const s = settings();
  forgetMember(evt.userId);
  // Kicks and bans already show up in the mod log; goodbye is for people who left.
  if (!s.goodbyeChannel || evt.leaveReason !== CommunityLeaveReason.User) return;
  const name = (await lastKnownNickname(evt.userId)) ?? "A member";
  await send(s.goodbyeChannel, await renderTemplate(s.goodbyeMessage, evt.userId, name));
}

async function configure(ctx: CommandContext, kind: "welcome" | "goodbye"): Promise<void> {
  const channelKey = kind === "welcome" ? "welcomeChannel" : "goodbyeChannel";
  const messageKey = kind === "welcome" ? "welcomeMessage" : "goodbyeMessage";
  const action = ctx.args.word();
  const s = settings();

  switch (action) {
    case "channel": {
      const channel = ctx.args.mention("channel");
      if (!channel?.id) throw new UsageError("Mention a channel.");
      await setSetting(channelKey, channel.id);
      return ctx.reply(`✅ ${capitalize(kind)} messages will go to ${channel.text}.`);
    }
    case "message": {
      const text = ctx.args.rest();
      if (!text) throw new UsageError("Give the message text.");
      await setSetting(messageKey, text);
      return ctx.reply(`✅ ${capitalize(kind)} message saved. Try \`${ctx.prefix}${kind} test\`.`);
    }
    case "off":
      await setSetting(channelKey, null);
      return ctx.reply(`✅ ${capitalize(kind)} messages turned off.`);
    case "test":
      return ctx.reply(await renderTemplate(s[messageKey], ctx.authorId, await nicknameOf(ctx.authorId)));
    case undefined: {
      const channelId = s[channelKey];
      return ctx.reply(
        [
          `**${capitalize(kind)} messages:** ${channelId ? `on, in ${channelMention("channel", channelId)}` : "off"}`,
          `**Message:** ${s[messageKey]}`,
          "Placeholders: `{user}` mention · `{user.name}` name · `{server}` community name",
        ].join("\n"),
      );
    }
    default:
      throw new UsageError();
  }
}

function capitalize(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

export function registerWelcome(): void {
  rootServer.community.communities.on(CommunityEvent.CommunityJoined, (evt) => {
    onJoin(evt).catch((err) => log("error", "welcome/autorole failed", { error: errMessage(err) }));
  });
  rootServer.community.communities.on(CommunityEvent.CommunityLeave, (evt) => {
    onLeave(evt).catch((err) => log("error", "goodbye failed", { error: errMessage(err) }));
  });

  register(
    {
      name: "welcome",
      category: "Welcome",
      level: Level.Admin,
      usage: "[channel #channel | message <text> | test | off]",
      description: "Greet new members in a channel.",
      details: ["`welcome message Welcome to {server}, {user}! Read the rules first.`"],
      run: (ctx) => configure(ctx, "welcome"),
    },
    {
      name: "goodbye",
      category: "Welcome",
      level: Level.Admin,
      usage: "[channel #channel | message <text> | test | off]",
      description: "Post a message when a member leaves (not for kicks or bans).",
      run: (ctx) => configure(ctx, "goodbye"),
    },
    {
      name: "autorole",
      category: "Welcome",
      level: Level.Admin,
      usage: "<add|remove> @role | list",
      description: "Roles given to every new member when they join.",
      details: ["Taproot can only give roles it's allowed to manage."],
      async run(ctx) {
        const action = ctx.args.word() ?? "list";
        const current = settings().autoroles;
        if (action === "list") {
          if (current.length === 0) return ctx.reply("No autoroles set.");
          const roles = await listRoles();
          const names = current.map((id) => roleMention(roles.find((r) => r.id === id)?.name ?? "deleted-role", id));
          return ctx.reply(`**Autoroles:** ${names.join(", ")}`);
        }
        const role = ctx.args.mention("role");
        if (!role?.id || role.id === "All" || role.id === "Here") throw new UsageError("Mention a role.");
        if (action === "add") {
          await setSetting("autoroles", [...new Set([...current, role.id])]);
          return ctx.reply(`✅ New members will get ${role.text}.`);
        }
        if (action === "remove") {
          await setSetting("autoroles", current.filter((id) => id !== role.id));
          return ctx.reply(`✅ ${role.text} removed from autoroles.`);
        }
        throw new UsageError();
      },
    },
  );
}
