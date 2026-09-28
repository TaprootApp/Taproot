import { ChannelMessageCreatedEvent, UserGuid } from "@rootsdk/server-app";
import { Level } from "../permissions";
import { Args } from "./parse";

// Core categories; feature modules may add their own (listed after these in help).
export type Category =
  | "Moderation"
  | "Auto-mod"
  | "Custom commands"
  | "Welcome"
  | "Reminders"
  | "Roles"
  | "General"
  | (string & {});

export interface CommandContext {
  evt: ChannelMessageCreatedEvent;
  args: Args;
  authorId: UserGuid;
  channelId: string;
  messageId: string;
  prefix: string;
  /** The invoker's staff level, already checked against the command's. */
  level: Level;
  reply(content: string): Promise<void>;
}

export interface Command {
  name: string;
  aliases?: string[];
  category: Category;
  level: Level;
  /** Arguments after the command name, e.g. "@member [reason]". */
  usage: string;
  description: string;
  /** Extra lines shown by "help <command>". */
  details?: string[];
  run(ctx: CommandContext): Promise<void>;
}

const commands = new Map<string, Command>();
const lookup = new Map<string, Command>();

export function register(...list: Command[]): void {
  for (const command of list) {
    commands.set(command.name, command);
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      if (lookup.has(name)) throw new Error(`Duplicate command name: ${name}`);
      lookup.set(name, command);
    }
  }
}

export function findCommand(name: string): Command | undefined {
  return lookup.get(name);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

export function isReservedName(name: string): boolean {
  return lookup.has(name);
}

export class UsageError extends Error {}
