import { channelMention, fillTemplate, truncate } from "../../lib/text";

// Action-log entry text. Pure: no SDK imports.
//
// Members are shown by name and ID rather than as mentions, so the log never
// pings anyone (the mod log does the same). Message content is quoted in a
// code block: mentions and @All inside it stay inert and Markdown can't break
// the rest of the entry.

/** Longest quoted content per message in an entry. */
export const QUOTE_MAX = 1500;

export function who(name: string, userId: string): string {
  return `**${escapeInline(name)}** \`${userId}\``;
}

/** A channel mention when Taproot knows the channel's name, otherwise its ID. */
export function where(channelId: string, name: string | undefined): string {
  return name ? channelMention(name, channelId) : `\`${channelId}\``;
}

/** Fenced code block that survives backticks in the text. */
export function codeBlock(text: string, max = QUOTE_MAX): string {
  const body = truncate(text, max).replace(/\r\n?/g, "\n");
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${body}\n${fence}`;
}

/** The quoted content, or a note when it's empty (attachments only) or wasn't seen. */
export function quote(content: string | undefined): string {
  if (content === undefined) return "*Content not available (sent before Taproot last started, or over a day ago).*";
  if (!content.trim()) return "*No text (attachments only).*";
  return codeBlock(content);
}

function escapeInline(text: string): string {
  return text.replace(/([*_`~\\[\]])/g, "\\$1");
}

export function messageDeleted(o: {
  author?: { name: string; id: string };
  channel: string;
  content: string | undefined;
  messageId: string;
}): string {
  return [
    `🗑️ **Message deleted** in ${o.channel}`,
    o.author ? `**Author:** ${who(o.author.name, o.author.id)}` : "**Author:** unknown",
    quote(o.content),
    `*Message ID ${o.messageId}*`,
  ].join("\n");
}

export function messageEdited(o: {
  author: { name: string; id: string };
  channel: string;
  before: string | undefined;
  after: string;
  messageId: string;
}): string {
  return [
    `✏️ **Message edited** in ${o.channel}`,
    `**Author:** ${who(o.author.name, o.author.id)}`,
    "**Before:**",
    quote(o.before),
    "**After:**",
    quote(o.after),
    `*Message ID ${o.messageId}*`,
  ].join("\n");
}

export function memberLine(icon: string, title: string, name: string, userId: string, extra: string[] = []): string {
  return [`${icon} **${title}**`, `**Member:** ${who(name, userId)}`, ...extra].join("\n");
}

/** "Name (id)" list for role changes that hit several members at once. */
export function memberList(members: Array<{ name: string; id: string }>, max = 10): string {
  const shown = members.slice(0, max).map((m) => who(m.name, m.id));
  const more = members.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export interface RoleSnapshot {
  name: string;
  colorHex: string;
  isMentionable: boolean;
  isSelfAssignable: boolean;
  /** JSON of both permission sets, only compared. */
  permissions: string;
}

/** Human-readable differences between two versions of a role; empty when nothing we show changed. */
export function roleChanges(before: RoleSnapshot | undefined, after: RoleSnapshot): string[] {
  if (!before) return ["*Previous settings not known.*"];
  const out: string[] = [];
  if (before.name !== after.name) out.push(`**Name:** ${escapeInline(before.name)} → ${escapeInline(after.name)}`);
  if ((before.colorHex || "none") !== (after.colorHex || "none")) {
    out.push(`**Color:** ${before.colorHex || "none"} → ${after.colorHex || "none"}`);
  }
  if (before.isMentionable !== after.isMentionable) out.push(`**Mentionable:** ${yesNo(before.isMentionable)} → ${yesNo(after.isMentionable)}`);
  if (before.isSelfAssignable !== after.isSelfAssignable) {
    out.push(`**Self-assignable:** ${yesNo(before.isSelfAssignable)} → ${yesNo(after.isSelfAssignable)}`);
  }
  if (before.permissions !== after.permissions) out.push("**Permissions** changed");
  return out;
}

export interface ChannelSnapshot {
  name: string;
  description: string;
  groupId: string;
  useGroupPermission: boolean;
  /** JSON of the permission set and access-rule targets, only compared. */
  permissions: string;
}

export function channelChanges(
  before: ChannelSnapshot | undefined,
  after: ChannelSnapshot,
  groupName: (id: string) => string | undefined,
): string[] {
  if (!before) return ["*Previous settings not known.*"];
  const out: string[] = [];
  if (before.name !== after.name) out.push(`**Name:** ${escapeInline(before.name)} → ${escapeInline(after.name)}`);
  if (before.description !== after.description) {
    out.push(`**Description:** ${before.description ? escapeInline(truncate(before.description, 200)) : "none"} → ${after.description ? escapeInline(truncate(after.description, 200)) : "none"}`);
  }
  if (before.groupId !== after.groupId) {
    out.push(`**Group:** ${groupName(before.groupId) ?? "unknown"} → ${groupName(after.groupId) ?? "unknown"}`);
  }
  if (before.useGroupPermission !== after.useGroupPermission) {
    out.push(after.useGroupPermission ? "**Permissions** now synced with the group" : "**Permissions** no longer synced with the group");
  } else if (before.permissions !== after.permissions) {
    out.push("**Permissions** changed");
  }
  return out;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Fills a public ban/kick announcement. */
export function renderAnnouncement(template: string, o: { name: string; userId: string; reason: string; server: string }): string {
  return fillTemplate(template, {
    "user.name": o.name,
    "user.id": o.userId,
    reason: o.reason.trim() || "No reason given",
    server: o.server,
  });
}
