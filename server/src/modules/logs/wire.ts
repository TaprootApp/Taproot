import type { LogsConfig as WireLogsConfig } from "@taproot/gen-shared";
import { LOG_EVENTS, LogsConfig, TEMPLATE_MAX, isLogEventKey } from "./events";

// Conversions between the stored config and the proto message, plus the
// checks that don't need Root. Pure (type-only proto import) for the tests.

export function toWireLogsConfig(c: LogsConfig): WireLogsConfig {
  return {
    channelId: c.channel ?? undefined,
    events: LOG_EVENTS.map((e) => ({
      key: e.key,
      label: e.label,
      group: e.group,
      enabled: c.events[e.key].enabled,
      channelId: c.events[e.key].channel ?? undefined,
    })),
    ignoredChannelIds: [...c.ignoredChannels],
    announcements: {
      channelId: c.announce.channel ?? undefined,
      bans: c.announce.bans,
      kicks: c.announce.kicks,
      banTemplate: c.announce.banTemplate,
      kickTemplate: c.announce.kickTemplate,
    },
  };
}

/** Error message for an announcement template, or undefined when it's fine. */
export function templateError(text: string, name: string): string | undefined {
  if (!text.trim()) return `The ${name} template can't be empty.`;
  if (text.length > TEMPLATE_MAX) return `The ${name} template is too long (${TEMPLATE_MAX} characters max).`;
  return undefined;
}

/**
 * Builds the next config from a GUI request over the current one. Events the
 * request leaves out keep their setting and unknown keys are ignored. Channel
 * IDs are returned unchecked in `channelIds` for the caller to verify against Root.
 */
export function fromWireLogsConfig(
  request: WireLogsConfig,
  current: LogsConfig,
): { next: LogsConfig; channelIds: string[] } | { error: string } {
  const a = request.announcements;
  if (!a) return { error: "Announcement settings are missing." };
  const banError = templateError(a.banTemplate, "ban");
  if (banError) return { error: banError };
  const kickError = templateError(a.kickTemplate, "kick");
  if (kickError) return { error: kickError };

  const next: LogsConfig = structuredClone(current);
  next.channel = request.channelId || null;
  for (const e of request.events) {
    if (!isLogEventKey(e.key)) continue;
    next.events[e.key] = { enabled: e.enabled, channel: e.channelId || null };
  }
  next.ignoredChannels = [...new Set(request.ignoredChannelIds.filter(Boolean))];
  if (next.ignoredChannels.length > 200) return { error: "That's too many ignored channels (200 max)." };
  next.announce = {
    channel: a.channelId || null,
    bans: a.bans,
    kicks: a.kicks,
    banTemplate: a.banTemplate,
    kickTemplate: a.kickTemplate,
  };

  const channelIds = [
    next.channel,
    next.announce.channel,
    ...Object.values(next.events).map((e) => e.channel),
    ...next.ignoredChannels,
  ].filter((id): id is string => !!id);
  return { next, channelIds: [...new Set(channelIds)] };
}

/** Every channel ID a config already refers to (these stay valid even if Root stops listing them). */
export function savedChannelIds(c: LogsConfig): Set<string> {
  return new Set(
    [c.channel, c.announce.channel, ...Object.values(c.events).map((e) => e.channel), ...c.ignoredChannels].filter(
      (id): id is string => !!id,
    ),
  );
}
