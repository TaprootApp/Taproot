import {
  rootServer,
  ChannelGuid,
  ChannelMessageEvent,
  ChannelMessageReactionCreatedEvent,
  ChannelMessageReactionDeletedEvent,
  CommunityRole,
  CommunityRoleGuid,
  MessageGuid,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { Token } from "../commands/parse";
import { CommandContext, register, UsageError } from "../commands/registry";
import { all, get, run } from "../db";
import { describeError, read, write } from "../lib/api";
import { log, errMessage } from "../lib/log";
import { roleMention, truncate, userMention } from "../lib/text";
import { nicknameOf } from "../members";
import { send } from "../messaging";
import { modLogNotice } from "../modlog";
import { canActOn, forgetMember, isPrivileged, Level, listRoles, memberRoleIds } from "../permissions";
import { notifyChange } from "../services/changes";
import { setSetting, settings } from "../settings";
import { emojiDisplay, emojiKey } from "./emoji";

// Bots have no buttons or menus, so self-service roles are reactions on a
// panel message Taproot posts, plus iam/iamnot commands.

export interface Panel {
  id: number;
  channel_id: string;
  message_id: string;
  title: string;
}

export interface ReactionRole {
  panel_id: number;
  emoji_key: string;
  shortcode: string;
  role_id: string;
  label: string;
}

// Every role change here (iam, reaction panels, the role command, the GUI)
// tells open Me pages to refetch their self roles.
async function addRole(userId: UserGuid, roleId: string): Promise<void> {
  await write("communityMemberRoles.add", () =>
    rootServer.community.communityMemberRoles.add({ communityRoleId: roleId as CommunityRoleGuid, userIds: [userId] }),
  );
  forgetMember(userId);
  notifyChange("selfroles");
}

async function removeRole(userId: UserGuid, roleId: string): Promise<void> {
  await write("communityMemberRoles.remove", () =>
    rootServer.community.communityMemberRoles.remove({ communityRoleId: roleId as CommunityRoleGuid, userIds: [userId] }),
  );
  forgetMember(userId);
  notifyChange("selfroles");
}

export async function roleById(roleId: string): Promise<CommunityRole | undefined> {
  return (await listRoles()).find((r) => r.id === roleId);
}

/** A role from a mention, or by name for members who can't mention roles. */
async function takeRole(ctx: CommandContext): Promise<CommunityRole> {
  const mention = ctx.args.mention("role");
  const roles = await listRoles();
  if (mention?.id) {
    const role = roles.find((r) => r.id === mention.id);
    if (role) return role;
  }
  const name = ctx.args.rest().replace(/^@/, "").toLowerCase();
  const role = name ? roles.find((r) => r.name.toLowerCase() === name) : undefined;
  if (!role) throw new UsageError("I couldn't find that role.");
  return role;
}

// --- Reaction panels ----------------------------------------------------------

async function renderPanel(panel: Panel): Promise<string> {
  const entries = await panelEntries(panel.id);
  const lines = [`**${panel.title}**`];
  if (entries.length === 0) lines.push("*No roles yet.*");
  else {
    lines.push("React to get a role; remove your reaction to drop it.", "");
    for (const e of entries) {
      const role = await roleById(e.role_id);
      lines.push(`${emojiDisplay(e.shortcode)}  **${role?.name ?? "deleted role"}**${e.label ? ` · ${e.label}` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function refreshPanel(panel: Panel): Promise<void> {
  const content = await renderPanel(panel);
  await write("channelMessages.edit", () =>
    rootServer.community.channelMessages.edit({
      channelId: panel.channel_id as ChannelGuid,
      id: panel.message_id as MessageGuid,
      content,
    }),
  );
}

/**
 * Turns what the admin typed into the shortcode Root uses for reactions.
 * Standard emoji are ":name:"; community emoji are looked up for their ID.
 */
async function resolveEmoji(token: Token | undefined): Promise<string | undefined> {
  if (!token) return undefined;
  return resolveEmojiText(token.kind === "emoji" ? token.id ?? token.text : token.text);
}

/** As resolveEmoji, for a :shortcode: typed into the GUI. */
export async function resolveEmojiText(raw: string): Promise<string | undefined> {
  if (!/^:[^:\s]+:/.test(raw)) return undefined;
  const name = emojiKey(raw);
  try {
    const custom = (await read("communityEmojis.list", () => rootServer.community.communityEmojis.list())).find(
      (e) => emojiKey(e.shortcode) === name,
    );
    if (custom) return `:${name}:${custom.id}:`;
  } catch {
    // Treat as a standard emoji.
  }
  return `:${name}:`;
}

export async function panelById(id: number): Promise<Panel | undefined> {
  return get<Panel>("SELECT * FROM reaction_panels WHERE id = ?", [id]);
}

// --- Shared with the GUI ------------------------------------------------------

export async function listPanels(): Promise<Panel[]> {
  return all<Panel>("SELECT * FROM reaction_panels ORDER BY id");
}

export async function panelEntries(panelId: number): Promise<ReactionRole[]> {
  return all<ReactionRole>("SELECT * FROM reaction_roles WHERE panel_id = ? ORDER BY rowid", [panelId]);
}

/** Posts an empty panel message and records it. */
export async function createPanel(channelId: string, title: string): Promise<Panel> {
  const msg = await send(channelId, `**${title}**\n*No roles yet.*`);
  const panel = { channel_id: channelId, message_id: msg.id, title: truncate(title, 200) };
  const { lastID } = await run("INSERT INTO reaction_panels (channel_id, message_id, title, created_at) VALUES (?, ?, ?, ?)", [
    panel.channel_id,
    panel.message_id,
    panel.title,
    Date.now(),
  ]);
  notifyChange("panels");
  return { id: lastID, ...panel };
}

/**
 * Adds (or replaces) an emoji's role on a panel and seeds the reaction.
 * Callers check the role isn't privileged. Returns false when the reaction
 * couldn't be seeded, so an admin has to react once themselves.
 */
export async function addPanelRole(panel: Panel, shortcode: string, role: CommunityRole, label: string): Promise<boolean> {
  await run("INSERT OR REPLACE INTO reaction_roles (panel_id, emoji_key, shortcode, role_id, label) VALUES (?, ?, ?, ?, ?)", [
    panel.id,
    emojiKey(shortcode),
    shortcode,
    role.id,
    truncate(label, 100),
  ]);
  notifyChange("panels");
  await refreshPanel(panel);
  let seeded = true;
  await write("channelMessages.reactionCreate", () =>
    rootServer.community.channelMessages.reactionCreate({
      channelId: panel.channel_id as ChannelGuid,
      messageId: panel.message_id as MessageGuid,
      shortcode,
    }),
  ).catch(() => (seeded = false));
  return seeded;
}

/** Removes an emoji from a panel. False if it wasn't on the panel. */
export async function removePanelRole(panel: Panel, shortcode: string): Promise<boolean> {
  const { changes } = await run("DELETE FROM reaction_roles WHERE panel_id = ? AND emoji_key = ?", [panel.id, emojiKey(shortcode)]);
  if (!changes) return false;
  notifyChange("panels");
  await refreshPanel(panel);
  await write("channelMessages.reactionDelete", () =>
    rootServer.community.channelMessages.reactionDelete({
      channelId: panel.channel_id as ChannelGuid,
      messageId: panel.message_id as MessageGuid,
      shortcode,
    }),
  ).catch(() => undefined);
  return true;
}

export async function deletePanel(panel: Panel): Promise<void> {
  await run("DELETE FROM reaction_roles WHERE panel_id = ?", [panel.id]);
  await run("DELETE FROM reaction_panels WHERE id = ?", [panel.id]);
  notifyChange("panels");
  await write("channelMessages.delete", () =>
    rootServer.community.channelMessages.delete({ channelId: panel.channel_id as ChannelGuid, id: panel.message_id as MessageGuid }),
  ).catch(() => undefined);
}

/**
 * Gives or removes one of the member's self-assignable roles. Returns why it
 * was refused, or undefined on success.
 */
export async function setSelfRole(userId: UserGuid, role: CommunityRole, has: boolean): Promise<string | undefined> {
  if (!settings().selfRoles.includes(role.id)) return `**${role.name}** isn't self-assignable.`;
  // The role may have gained staff permissions since it was made self-assignable.
  if (has && isPrivileged(role)) return "That role now has staff permissions, so it can't be self-assigned.";
  if (has) await addRole(userId, role.id);
  else await removeRole(userId, role.id);
  return undefined;
}

async function onReaction(evt: ChannelMessageReactionCreatedEvent | ChannelMessageReactionDeletedEvent, added: boolean) {
  // Taproot's own seed reaction (and other bots) never get panel roles.
  if (RootGuidUtils.toRootGuidType(evt.userId) === RootGuidType.App) return;
  const panel = await get<Panel>("SELECT * FROM reaction_panels WHERE message_id = ?", [evt.messageId]);
  if (!panel) return;
  const entry = await get<ReactionRole>("SELECT * FROM reaction_roles WHERE panel_id = ? AND emoji_key = ?", [
    panel.id,
    emojiKey(evt.shortcode),
  ]);
  if (!entry) return;
  try {
    if (added) {
      const role = await roleById(entry.role_id);
      if (!role || isPrivileged(role)) return;
      await addRole(evt.userId, entry.role_id);
    }
    else await removeRole(evt.userId, entry.role_id);
  } catch (err) {
    log("warn", "reaction role change failed", { error: errMessage(err) });
    await modLogNotice(
      `⚠️ Reaction role ${roleMention("role", entry.role_id)} couldn't be ${added ? "given to" : "removed from"} **${await nicknameOf(evt.userId)}**: ${describeError(err)}`,
    );
  }
}

// --- Commands ----------------------------------------------------------------

export function registerRoles(): void {
  const messages = rootServer.community.channelMessages;
  // Handlers never throw: an unhandled rejection restarts the server.
  const handle = (evt: ChannelMessageReactionCreatedEvent | ChannelMessageReactionDeletedEvent, added: boolean) =>
    onReaction(evt, added).catch((err) => log("error", "reaction handler failed", { error: errMessage(err) }));
  messages.on(ChannelMessageEvent.ChannelMessageReactionCreated, (evt) => void handle(evt, true));
  messages.on(ChannelMessageEvent.ChannelMessageReactionDeleted, (evt) => void handle(evt, false));

  register(
    {
      name: "rr",
      aliases: ["reactionrole", "reactionroles"],
      category: "Roles",
      level: Level.Admin,
      usage: "create #channel <title> | add <panel> <:emoji:> @role [label] | remove <panel> <:emoji:> | list | delete <panel>",
      description: "Reaction-role panels: members react to get roles.",
      details: [
        "1. `rr create #roles Pick your games` posts a panel and tells you its number.",
        "2. `rr add 1 :video_game: @Gamers Game nights` adds a role to panel 1.",
        "Emoji must be written as :shortcode:. Roles with staff permissions can't be added.",
      ],
      async run(ctx) {
        const action = ctx.args.word();
        if (action === "create") {
          const channel = ctx.args.mention("channel");
          const title = ctx.args.rest();
          if (!channel?.id || !title) throw new UsageError();
          const { id } = await createPanel(channel.id, title);
          return ctx.reply(`✅ Panel **#${id}** posted in ${channel.text}. Add roles with \`${ctx.prefix}rr add ${id} :emoji: @role\`.`);
        }
        if (action === "list" || !action) {
          const panels = await listPanels();
          if (panels.length === 0) return ctx.reply("No reaction-role panels.");
          const lines = await Promise.all(
            panels.map(async (p) => {
              const n = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM reaction_roles WHERE panel_id = ?", [p.id]))?.n ?? 0;
              return `#${p.id} · **${p.title}** · ${n} role(s)`;
            }),
          );
          return ctx.reply(lines.join("\n"));
        }

        const panel = await panelById(Number(ctx.args.word()));
        if (!panel) return ctx.reply("❌ No panel with that number. See `rr list`.");

        if (action === "delete") {
          await deletePanel(panel);
          return ctx.reply(`🗑️ Panel #${panel.id} deleted.`);
        }

        const shortcode = await resolveEmoji(ctx.args.next());
        if (!shortcode) throw new UsageError("Write the emoji as a :shortcode:, like :tada:.");

        if (action === "add") {
          const mention = ctx.args.mention("role");
          const role = mention?.id ? await roleById(mention.id) : undefined;
          if (!role) throw new UsageError("Mention the role after the emoji.");
          if (isPrivileged(role)) return ctx.reply("❌ That role has staff permissions, so it can't be self-assigned.");
          const seeded = await addPanelRole(panel, shortcode, role, ctx.args.rest());
          const hint = seeded ? "" : "\n⚠️ I couldn't add the reaction myself; react to the panel with it once so members can click it.";
          return ctx.reply(`✅ ${emojiDisplay(shortcode)} → **${role.name}** added to panel #${panel.id}.${hint}`);
        }

        if (action === "remove") {
          if (!(await removePanelRole(panel, shortcode))) return ctx.reply("❌ That emoji isn't on the panel.");
          return ctx.reply(`✅ Removed ${emojiDisplay(shortcode)} from panel #${panel.id}.`);
        }
        throw new UsageError();
      },
    },
    {
      name: "selfrole",
      aliases: ["selfroles"],
      category: "Roles",
      level: Level.Admin,
      usage: "<add|remove> @role",
      description: "Choose which roles members can give themselves with `iam`.",
      async run(ctx) {
        const action = ctx.args.word();
        const role = await takeRole(ctx);
        const current = settings().selfRoles;
        if (action === "add") {
          if (isPrivileged(role)) return ctx.reply("❌ That role has staff permissions, so it can't be self-assigned.");
          await setSetting("selfRoles", [...new Set([...current, role.id])]);
          return ctx.reply(`✅ Members can now use \`${ctx.prefix}iam ${role.name}\`.`);
        }
        if (action === "remove") {
          await setSetting("selfRoles", current.filter((id) => id !== role.id));
          return ctx.reply(`✅ **${role.name}** is no longer self-assignable.`);
        }
        throw new UsageError();
      },
    },
    {
      name: "roles",
      category: "Roles",
      level: Level.Member,
      usage: "",
      description: "List the roles you can give yourself.",
      async run(ctx) {
        const roles = await listRoles();
        const names = settings()
          .selfRoles.map((id) => roles.find((r) => r.id === id)?.name)
          .filter(Boolean);
        if (names.length === 0) return ctx.reply("There are no self-assignable roles yet.");
        await ctx.reply(`**Self-assignable roles:** ${names.map((n) => `\`${n}\``).join(", ")}\nUse \`${ctx.prefix}iam <role>\` or \`${ctx.prefix}iamnot <role>\`.`);
      },
    },
    {
      name: "iam",
      category: "Roles",
      level: Level.Member,
      usage: "<role name>",
      description: "Give yourself a self-assignable role.",
      async run(ctx) {
        const role = await takeRole(ctx);
        if (!settings().selfRoles.includes(role.id)) return ctx.reply(`❌ **${role.name}** isn't self-assignable. See \`${ctx.prefix}roles\`.`);
        const problem = await setSelfRole(ctx.authorId, role, true);
        if (problem) return ctx.reply(`❌ ${problem}`);
        await ctx.reply(`✅ You now have **${role.name}**.`);
      },
    },
    {
      name: "iamnot",
      category: "Roles",
      level: Level.Member,
      usage: "<role name>",
      description: "Remove a self-assignable role from yourself.",
      async run(ctx) {
        const role = await takeRole(ctx);
        const problem = await setSelfRole(ctx.authorId, role, false);
        if (problem) return ctx.reply(`❌ ${problem}`);
        await ctx.reply(`✅ Removed **${role.name}**.`);
      },
    },
    {
      name: "role",
      category: "Roles",
      level: Level.Moderator,
      usage: "@member @role",
      description: "Give a member a role, or take it away if they have it.",
      details: ["Only admins can hand out roles with staff permissions."],
      async run(ctx) {
        const user = ctx.args.mention("user");
        if (!user?.id) throw new UsageError("Mention the member first.");
        const target = user.id as UserGuid;
        const role = await takeRole(ctx);
        if (isPrivileged(role) && ctx.level < Level.Admin) return ctx.reply("❌ Only admins can change staff roles.");
        if (target !== ctx.authorId) {
          const problem = await canActOn(ctx.authorId, target);
          if (problem) return ctx.reply(`❌ ${problem}`);
        }
        forgetMember(target);
        const has = (await memberRoleIds(target)).includes(role.id);
        if (has) await removeRole(target, role.id);
        else await addRole(target, role.id);
        const who = userMention(await nicknameOf(target), target);
        await ctx.reply(has ? `➖ Removed **${role.name}** from ${who}.` : `➕ Gave ${who} **${role.name}**.`);
      },
    },
  );
}
