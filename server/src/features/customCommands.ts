import { rootServer } from "@rootsdk/server-app";
import { isReservedName, register, UsageError } from "../commands/registry";
import { setCommandFallback } from "../commands/router";
import { all, get, run } from "../db";
import { read } from "../lib/api";
import { channelMention, fillTemplate, userMention } from "../lib/text";
import { nicknameOf } from "../members";
import { reply } from "../messaging";
import { Level } from "../permissions";
import { notifyChange } from "../services/changes";

export interface CustomCommand {
  name: string;
  response: string;
  created_by: string;
  uses: number;
}

export const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
let communityName: string | undefined;

const PLACEHOLDERS =
  "`{user}` mentions whoever ran it · `{user.name}` their name · `{target}` the first member they mentioned · `{args}` text after the command · `{channel}` · `{server}`";

// --- Shared with the GUI ------------------------------------------------------

export async function findCustomCommand(name: string): Promise<CustomCommand | undefined> {
  return get<CustomCommand>("SELECT * FROM custom_commands WHERE name = ?", [name]);
}

export async function listCustomCommands(): Promise<CustomCommand[]> {
  return all<CustomCommand>("SELECT * FROM custom_commands ORDER BY name");
}

/**
 * Creates or updates a command. With `originalName` set to a different name
 * the command is renamed, keeping its use count. Callers check the name rules.
 */
export async function saveCustomCommand(name: string, response: string, authorId: string, originalName?: string): Promise<void> {
  if (originalName && originalName !== name) {
    await run("UPDATE custom_commands SET name = ?, response = ? WHERE name = ?", [name, response, originalName]);
  } else {
    await run(
      `INSERT INTO custom_commands (name, response, created_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET response = excluded.response`,
      [name, response, authorId, Date.now()],
    );
  }
  notifyChange("commands");
}

export async function deleteCustomCommand(name: string): Promise<boolean> {
  const { changes } = await run("DELETE FROM custom_commands WHERE name = ?", [name]);
  if (changes) notifyChange("commands");
  return changes > 0;
}

// --- Commands ----------------------------------------------------------------

export function registerCustomCommands(): void {
  setCommandFallback(async (evt, parsed) => {
    const command = await findCustomCommand(parsed.name);
    if (!command) return false;
    const authorName = await nicknameOf(evt.userId);
    const target = evt.referenceMaps?.users?.[0];
    communityName ??= (await read("communities.get", () => rootServer.community.communities.get())).name;
    const content = fillTemplate(command.response, {
      user: userMention(authorName, evt.userId),
      "user.name": authorName,
      target: target ? userMention(target.name, target.userId) : userMention(authorName, evt.userId),
      args: parsed.args.rest(),
      channel: channelMention(evt.referenceMaps?.channels?.find((c) => c.channelId === evt.channelId)?.name ?? "this channel", evt.channelId),
      server: communityName,
    });
    await reply(evt.channelId, evt.id, content);
    await run("UPDATE custom_commands SET uses = uses + 1 WHERE name = ?", [command.name]);
    return true;
  });

  register({
    name: "cc",
    aliases: ["customcommand", "tag"],
    category: "Custom commands",
    level: Level.Member,
    usage: "<add|edit|remove|show> <name> [response] | list",
    description: "Custom commands: canned replies anyone can trigger with the prefix. Staff manage them.",
    details: ["`cc add rules Please read the rules channel, {user}!` then anyone can type `!rules`.", `Placeholders: ${PLACEHOLDERS}`],
    async run(ctx) {
      const action = ctx.args.word() ?? "list";
      if (action === "list") {
        const rows = await all<CustomCommand>("SELECT name, uses FROM custom_commands ORDER BY name");
        if (rows.length === 0) return ctx.reply(`No custom commands yet. Staff can add one with \`${ctx.prefix}cc add <name> <response>\`.`);
        return ctx.reply(`**Custom commands (${rows.length}):** ${rows.map((r) => `\`${ctx.prefix}${r.name}\``).join(" ")}`);
      }

      const name = ctx.args.word()?.replace(new RegExp(`^${escape(ctx.prefix)}`), "");
      if (!name) throw new UsageError("Give the command a name.");
      const existing = await findCustomCommand(name);

      if (action === "show") {
        if (!existing) return ctx.reply(`❌ No custom command called \`${name}\`.`);
        return ctx.reply(`**${ctx.prefix}${name}** (used ${existing.uses} times):\n\`\`\`\n${existing.response}\n\`\`\``);
      }

      if (ctx.level < Level.Moderator) return ctx.reply("🔒 Only staff can change custom commands.");

      if (action === "remove" || action === "delete") {
        if (!existing) return ctx.reply(`❌ No custom command called \`${name}\`.`);
        await deleteCustomCommand(name);
        return ctx.reply(`🗑️ Removed \`${ctx.prefix}${name}\`.`);
      }

      if (action === "add" || action === "edit") {
        if (!NAME.test(name)) throw new UsageError("Names use letters, numbers, - and _ (up to 32 characters).");
        if (isReservedName(name)) return ctx.reply(`❌ \`${name}\` is a built-in command.`);
        const response = ctx.args.rest();
        if (!response) throw new UsageError("Give the response text.");
        if (action === "add" && existing) return ctx.reply(`❌ \`${name}\` already exists. Use \`${ctx.prefix}cc edit\`.`);
        if (action === "edit" && !existing) return ctx.reply(`❌ No custom command called \`${name}\`.`);
        await saveCustomCommand(name, response, ctx.authorId);
        return ctx.reply(`✅ \`${ctx.prefix}${name}\` ${action === "add" ? "created" : "updated"}.`);
      }
      throw new UsageError();
    },
  });
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
