import { ChannelMessageCreatedEvent } from "@rootsdk/server-app";
import { describeError } from "../lib/api";
import { log, errMessage } from "../lib/log";
import { reply } from "../messaging";
import { Level, levelOf } from "../permissions";
import { settings } from "../settings";
import { parseCommand, ParsedCommand } from "./parse";
import { CommandContext, findCommand, UsageError } from "./registry";

type Fallback = (evt: ChannelMessageCreatedEvent, parsed: ParsedCommand) => Promise<boolean>;
let fallback: Fallback | undefined;

/** Runs for prefixed words that aren't built-in commands (custom commands). */
export function setCommandFallback(fn: Fallback): void {
  fallback = fn;
}

const LEVEL_NAMES: Record<Level, string> = {
  [Level.Member]: "members",
  [Level.Moderator]: "moderators",
  [Level.Admin]: "admins",
  [Level.Owner]: "the owner",
};

/** Returns true when the message was a command (handled or rejected). */
export async function handleCommand(evt: ChannelMessageCreatedEvent): Promise<boolean> {
  const prefix = settings().prefix;
  const parsed = parseCommand(evt.messageContent ?? "", prefix);
  if (!parsed) return false;

  const command = findCommand(parsed.name);
  if (!command) return fallback ? fallback(evt, parsed) : false;

  const respond = async (content: string) => {
    await reply(evt.channelId, evt.id, content);
  };

  const level = await levelOf(evt.userId);
  if (level < command.level) {
    await respond(`🔒 \`${prefix}${command.name}\` is for ${LEVEL_NAMES[command.level]} only.`);
    return true;
  }

  const ctx: CommandContext = {
    evt,
    args: parsed.args,
    authorId: evt.userId,
    channelId: evt.channelId,
    messageId: evt.id,
    prefix,
    level,
    reply: respond,
  };

  try {
    await command.run(ctx);
  } catch (err) {
    if (err instanceof UsageError) {
      const hint = err.message ? `${err.message}\n` : "";
      await respond(`${hint}Usage: \`${prefix}${command.name} ${command.usage}\``.trim()).catch(() => undefined);
    } else {
      log("error", `command ${command.name} failed`, { error: errMessage(err) });
      await respond(`⚠️ ${describeError(err)}`).catch(() => undefined);
    }
  }
  return true;
}
