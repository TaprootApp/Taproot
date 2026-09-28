import { allCommands, Category, Command, findCommand, register, UsageError } from "../commands/registry";
import { get } from "../db";
import { channelMention } from "../lib/text";
import { PREFIX_RULE, validPrefix } from "../lib/validate";
import { Level, levelOf } from "../permissions";
import { setSetting, settings } from "../settings";

const CATEGORY_ORDER: Category[] = ["General", "Moderation", "Auto-mod", "Custom commands", "Welcome", "Reminders", "Roles"];
const LEVEL_LABEL: Record<Level, string> = {
  [Level.Member]: "everyone",
  [Level.Moderator]: "moderators",
  [Level.Admin]: "admins",
  [Level.Owner]: "owner",
};

function usageLine(prefix: string, c: Command): string {
  return `\`${prefix}${c.name}${c.usage ? ` ${c.usage}` : ""}\``;
}

export function registerGeneral(): void {
  register(
    {
      name: "help",
      aliases: ["commands"],
      category: "General",
      level: Level.Member,
      usage: "[command]",
      description: "List commands, or explain one.",
      async run(ctx) {
        const name = ctx.args.word()?.replace(ctx.prefix, "");
        if (name) {
          const c = findCommand(name);
          if (!c) return ctx.reply(`❌ No command called \`${name}\`.`);
          const lines = [usageLine(ctx.prefix, c), c.description, ...(c.details ?? [])];
          if (c.aliases?.length) lines.push(`Also: ${c.aliases.map((a) => `\`${ctx.prefix}${a}\``).join(" ")}`);
          lines.push(`*For ${LEVEL_LABEL[c.level]}.*`);
          return ctx.reply(lines.join("\n"));
        }
        const level = await levelOf(ctx.authorId);
        const visible = allCommands().filter((c) => c.level <= level);
        const lines = ["🌱 **Taproot commands**"];
        const extra = [...new Set(visible.map((c) => c.category))].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
        for (const category of [...CATEGORY_ORDER, ...extra]) {
          const list = visible.filter((c) => c.category === category);
          if (list.length) lines.push(`**${category}:** ${list.map((c) => `\`${c.name}\``).join(" ")}`);
        }
        lines.push(`Type \`${ctx.prefix}help <command>\` for details.`);
        await ctx.reply(lines.join("\n"));
      },
    },
    {
      name: "ping",
      category: "General",
      level: Level.Member,
      usage: "",
      description: "Check that Taproot is awake.",
      async run(ctx) {
        const started = Date.now();
        await get("SELECT 1");
        await ctx.reply(`🌱 Pong! Database answered in ${Date.now() - started} ms.`);
      },
    },
    {
      name: "prefix",
      category: "General",
      level: Level.Admin,
      usage: "<new prefix>",
      description: "Change the command prefix (default !).",
      async run(ctx) {
        const prefix = ctx.args.next()?.text;
        if (!validPrefix(prefix)) throw new UsageError(PREFIX_RULE);
        await setSetting("prefix", prefix);
        await ctx.reply(`✅ Prefix is now \`${prefix}\`. Try \`${prefix}help\`.`);
      },
    },
    {
      name: "config",
      aliases: ["settings"],
      category: "General",
      level: Level.Admin,
      usage: "",
      description: "Show Taproot's current setup for this community.",
      async run(ctx) {
        const s = settings();
        const ch = (id: string | null) => (id ? channelMention("channel", id) : "off");
        await ctx.reply(
          [
            "🌱 **Taproot setup**",
            `**Prefix:** \`${s.prefix}\``,
            `**Mod log:** ${ch(s.modLogChannel)}`,
            `**Welcome:** ${ch(s.welcomeChannel)} · **Goodbye:** ${ch(s.goodbyeChannel)}`,
            `**Autoroles:** ${s.autoroles.length} · **Self roles:** ${s.selfRoles.length}`,
            `**Auto-mod:** ${s.automod.enabled ? "on" : "off"} (\`${s.prefix}automod\` for details)`,
            "Moderators, admins and auto-mod exemptions are set on Taproot's settings page in Root.",
          ].join("\n"),
        );
      },
    },
  );
}
