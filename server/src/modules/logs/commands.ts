import { CommandContext, register, UsageError } from "../../commands/registry";
import { channelMention, MAX_MESSAGE } from "../../lib/text";
import { nicknameOf } from "../../members";
import { send } from "../../messaging";
import { Level } from "../../permissions";
import { saveModuleConfig } from "../../settings";
import { config, NAME, pruneMessageCache } from "./actionLog";
import { LOG_EVENTS, LogEventKey, LogsConfig, resolveEventNames } from "./events";
import { renderAnnouncement } from "./format";
import { templateError } from "./wire";

// !logs: the text-command side of the "Action log" settings page.

function ch(id: string | null): string {
  return id ? channelMention("channel", id) : "off";
}

async function save(change: (c: LogsConfig) => void): Promise<void> {
  const next = structuredClone(config());
  change(next);
  await saveModuleConfig(NAME, next);
  pruneMessageCache();
}

function eventNames(ctx: CommandContext): LogEventKey[] {
  const words = ctx.args.rest().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) throw new UsageError("Name the events, e.g. `delete edit`, a group like `voice`, or `all`.");
  const keys = new Set<LogEventKey>();
  for (const word of words) {
    const found = resolveEventNames(word);
    if (found.length === 0) throw new UsageError(`I don't know the event "${word}". See \`${ctx.prefix}logs events\`.`);
    for (const key of found) keys.add(key);
  }
  return [...keys];
}

function status(ctx: CommandContext): string {
  const c = config();
  const on = LOG_EVENTS.filter((e) => c.events[e.key].enabled);
  const routed = LOG_EVENTS.filter((e) => c.events[e.key].enabled && c.events[e.key].channel);
  const lines = [
    `**Action log:** ${c.channel ? `on, in ${ch(c.channel)}` : routed.length ? "only the events routed below" : "off"}`,
    `**Logging:** ${on.length ? on.map((e) => e.label.toLowerCase()).join(", ") : "nothing"}`,
  ];
  if (routed.length) lines.push(`**Routed:** ${routed.map((e) => `${e.label.toLowerCase()} → ${ch(c.events[e.key].channel)}`).join(" · ")}`);
  lines.push(`**Ignored channels:** ${c.ignoredChannels.length ? c.ignoredChannels.map(ch).join(", ") : "none"}`);
  const a = c.announce;
  const kinds = [a.bans && "bans", a.kicks && "kicks"].filter(Boolean).join(" and ") || "nothing";
  lines.push(`**Ban/kick announcements:** ${a.channel ? `${kinds} in ${ch(a.channel)}` : "off"}`);
  lines.push(`See \`${ctx.prefix}help logs\` to change these.`);
  return lines.join("\n");
}

function onOff(word: string | undefined): boolean {
  if (word === "on" || word === "yes") return true;
  if (word === "off" || word === "no") return false;
  throw new UsageError("Say `on` or `off`.");
}

async function announceCommand(ctx: CommandContext): Promise<void> {
  const action = ctx.args.word();
  const a = config().announce;
  switch (action) {
    case undefined:
      return ctx.reply(
        [
          `**Announcements:** ${a.channel ? `in ${ch(a.channel)}` : "off"} · bans ${a.bans ? "on" : "off"} · kicks ${a.kicks ? "on" : "off"}`,
          `**Ban template:** ${a.banTemplate}`,
          `**Kick template:** ${a.kickTemplate}`,
          "Placeholders: `{user.name}` `{user.id}` `{reason}` `{server}`",
        ].join("\n"),
      );
    case "channel": {
      const channel = ctx.args.mention("channel");
      if (channel?.id) {
        const id = channel.id;
        await save((c) => (c.announce.channel = id));
        return ctx.reply(`✅ Bans and kicks will be announced in ${channel.text}.`);
      }
      if (ctx.args.word() === "off") {
        await save((c) => (c.announce.channel = null));
        return ctx.reply("✅ Ban and kick announcements turned off.");
      }
      throw new UsageError("Mention a channel, or say `off`.");
    }
    case "bans":
    case "kicks": {
      const value = onOff(ctx.args.word());
      await save((c) => (c.announce[action] = value));
      return ctx.reply(`✅ ${action === "bans" ? "Ban" : "Kick"} announcements ${value ? "on" : "off"}.`);
    }
    case "ban":
    case "kick": {
      const text = ctx.args.rest();
      const error = templateError(text, action);
      if (error) throw new UsageError(error);
      await save((c) => (c.announce[action === "ban" ? "banTemplate" : "kickTemplate"] = text));
      return ctx.reply(`✅ ${action === "ban" ? "Ban" : "Kick"} announcement saved. Try \`${ctx.prefix}logs announce test\`.`);
    }
    case "test": {
      const name = await nicknameOf(ctx.authorId);
      const sample = { name, userId: ctx.authorId, reason: "Example reason", server: "this community" };
      return ctx.reply(
        [renderAnnouncement(a.banTemplate, sample), renderAnnouncement(a.kickTemplate, sample)].join("\n\n").slice(0, MAX_MESSAGE),
      );
    }
    default:
      throw new UsageError();
  }
}

export function registerLogCommands(): void {
  register({
    name: "logs",
    category: "Logging",
    level: Level.Admin,
    usage:
      "[channel <#channel|off> | on|off <events> | route <events> <#channel|default> | ignore <#channel> | events | announce …]",
    description: "Log deletes, edits, joins, leaves, bans, role, channel and voice changes to a staff channel.",
    details: [
      "`logs channel #mod-logs` picks the default log channel. Make it private: logs include deleted messages and member IDs.",
      "`logs off voice` or `logs on delete edit` turns events on or off (`all` works too). `logs events` lists the names.",
      "`logs route delete edit #message-log` sends some events to their own channel; `logs route delete default` undoes it.",
      "`logs ignore #channel` stops logging messages and voice in a channel (run again to undo).",
      "`logs announce channel #general` announces bans and kicks publicly. `logs announce bans|kicks on|off`, `logs announce ban|kick <template>`, `logs announce test`.",
      "Deleted-message content comes from messages Taproot saw in the last day while running; older ones show as not available.",
    ],
    async run(ctx) {
      const action = ctx.args.word();
      switch (action) {
        case undefined:
          return ctx.reply(status(ctx));
        case "channel": {
          const channel = ctx.args.mention("channel");
          if (channel?.id) {
            const id = channel.id;
            // Posting first checks Taproot can write there before saving.
            await send(id, "📋 Taproot will post the action log here.");
            await save((c) => (c.channel = id));
            return ctx.reply(`✅ Action log set to ${channel.text}.`);
          }
          if (ctx.args.word() === "off") {
            await save((c) => (c.channel = null));
            return ctx.reply("✅ Action log turned off (events routed to their own channel still post there).");
          }
          throw new UsageError("Mention a channel, or say `off`.");
        }
        case "on":
        case "off":
        case "enable":
        case "disable": {
          const enabled = action === "on" || action === "enable";
          const keys = eventNames(ctx);
          await save((c) => {
            for (const key of keys) c.events[key].enabled = enabled;
          });
          const labels = keys.map((k) => LOG_EVENTS.find((e) => e.key === k)!.label.toLowerCase());
          return ctx.reply(`✅ ${enabled ? "Logging" : "No longer logging"}: ${labels.join(", ")}.`);
        }
        case "route": {
          const words: string[] = [];
          let target: string | null | undefined;
          while (ctx.args.remaining > 0) {
            const channel = ctx.args.mention("channel");
            if (channel?.id) {
              target = channel.id;
              break;
            }
            const word = ctx.args.word();
            if (word === undefined) break;
            if (word === "default") {
              target = null;
              break;
            }
            words.push(word);
          }
          if (target === undefined || words.length === 0) throw new UsageError("Usage: `logs route <events> <#channel|default>`.");
          const keys = [...new Set(words.flatMap(resolveEventNames))];
          const unknown = words.find((w) => resolveEventNames(w).length === 0);
          if (unknown) throw new UsageError(`I don't know the event "${unknown}". See \`${ctx.prefix}logs events\`.`);
          if (target) await send(target, "📋 Taproot will post some action log events here.");
          await save((c) => {
            for (const key of keys) c.events[key].channel = target ?? null;
          });
          return ctx.reply(`✅ ${keys.length} event${keys.length === 1 ? "" : "s"} now go to ${target ? ch(target) : "the default log channel"}.`);
        }
        case "ignore": {
          const channel = ctx.args.mention("channel");
          if (!channel?.id) throw new UsageError("Mention a channel.");
          const id = channel.id;
          const ignored = config().ignoredChannels.includes(id);
          await save((c) => {
            c.ignoredChannels = ignored ? c.ignoredChannels.filter((x) => x !== id) : [...c.ignoredChannels, id];
          });
          return ctx.reply(ignored ? `✅ Logging ${channel.text} again.` : `✅ Messages and voice in ${channel.text} won't be logged.`);
        }
        case "events": {
          const c = config();
          const groups = [...new Set(LOG_EVENTS.map((e) => e.group))];
          return ctx.reply(
            groups
              .map(
                (g) =>
                  `**${g}:** ` +
                  LOG_EVENTS.filter((e) => e.group === g)
                    .map((e) => `\`${e.aliases[0]}\` ${e.label.toLowerCase()} ${c.events[e.key].enabled ? "✅" : "⛔"}`)
                    .join(" · "),
              )
              .join("\n"),
          );
        }
        case "announce":
          return announceCommand(ctx);
        default:
          throw new UsageError();
      }
    },
  });
}
