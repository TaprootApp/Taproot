// The action log's event types and config shape. Pure: no SDK imports, so
// the tests can cover it without a Root connection.

export const LOG_EVENTS = [
  { key: "messageDelete", label: "Message deleted", group: "Messages", aliases: ["delete", "deletes"] },
  { key: "messageEdit", label: "Message edited", group: "Messages", aliases: ["edit", "edits"] },
  { key: "memberJoin", label: "Member joined", group: "Members", aliases: ["join", "joins"] },
  { key: "memberLeave", label: "Member left", group: "Members", aliases: ["leave", "leaves"] },
  { key: "memberKick", label: "Member kicked", group: "Members", aliases: ["kick", "kicks"] },
  { key: "banAdd", label: "Member banned", group: "Members", aliases: ["ban", "bans"] },
  { key: "banRemove", label: "Member unbanned", group: "Members", aliases: ["unban", "unbans"] },
  { key: "memberRoleAdd", label: "Role given to a member", group: "Members", aliases: ["roleadd"] },
  { key: "memberRoleRemove", label: "Role taken from a member", group: "Members", aliases: ["roleremove"] },
  { key: "roleCreate", label: "Role created", group: "Roles", aliases: ["rolecreate"] },
  { key: "roleEdit", label: "Role edited", group: "Roles", aliases: ["roleedit"] },
  { key: "roleDelete", label: "Role deleted", group: "Roles", aliases: ["roledelete"] },
  { key: "channelCreate", label: "Channel created", group: "Channels", aliases: ["channelcreate"] },
  { key: "channelEdit", label: "Channel edited", group: "Channels", aliases: ["channeledit"] },
  { key: "channelDelete", label: "Channel deleted", group: "Channels", aliases: ["channeldelete"] },
  { key: "voiceJoin", label: "Joined voice", group: "Voice", aliases: ["voicejoin"] },
  { key: "voiceLeave", label: "Left voice", group: "Voice", aliases: ["voiceleave"] },
] as const;

export type LogEventKey = (typeof LOG_EVENTS)[number]["key"];

export const LOG_EVENT_KEYS: LogEventKey[] = LOG_EVENTS.map((e) => e.key);

export interface LogEventConfig {
  enabled: boolean;
  /** Overrides the default channel for this event; null = default. */
  channel: string | null;
}

export interface LogsConfig {
  /** Default log channel; null turns the action log off. */
  channel: string | null;
  events: Record<LogEventKey, LogEventConfig>;
  /** Message and voice events in these channels aren't logged. */
  ignoredChannels: string[];
  announce: {
    channel: string | null;
    bans: boolean;
    kicks: boolean;
    banTemplate: string;
    kickTemplate: string;
  };
}

// Joins and leaves are noisy in big communities and voice more so, so they
// start off; everything else starts on once a channel is picked.
const OFF_BY_DEFAULT = new Set<LogEventKey>(["voiceJoin", "voiceLeave"]);

export const TEMPLATE_MAX = 1000;

export function defaultLogsConfig(): LogsConfig {
  const events = {} as Record<LogEventKey, LogEventConfig>;
  for (const key of LOG_EVENT_KEYS) events[key] = { enabled: !OFF_BY_DEFAULT.has(key), channel: null };
  return {
    channel: null,
    events,
    ignoredChannels: [],
    announce: {
      channel: null,
      bans: true,
      kicks: true,
      banTemplate: "🔨 **{user.name}** was banned. Reason: {reason}",
      kickTemplate: "👢 **{user.name}** was kicked. Reason: {reason}",
    },
  };
}

/** Event keys matching a typed name: a key ("messageDelete"), an alias ("delete"), a group ("voice") or "all". */
export function resolveEventNames(input: string): LogEventKey[] {
  const name = input.toLowerCase().replace(/[\s_-]/g, "");
  if (name === "all" || name === "everything") return [...LOG_EVENT_KEYS];
  const group = LOG_EVENTS.filter((e) => [name, `${name}s`].includes(e.group.toLowerCase()));
  if (group.length > 0) return group.map((e) => e.key);
  const single = LOG_EVENTS.find((e) => e.key.toLowerCase() === name || (e.aliases as readonly string[]).includes(name));
  return single ? [single.key] : [];
}

export function isLogEventKey(key: string): key is LogEventKey {
  return (LOG_EVENT_KEYS as string[]).includes(key);
}

/** Where an event should be posted, or null when it's off. */
export function targetChannel(config: LogsConfig, key: LogEventKey): string | null {
  const event = config.events[key];
  if (!event?.enabled) return null;
  return event.channel ?? config.channel;
}
