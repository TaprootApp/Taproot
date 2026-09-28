import {
  rootServer,
  Channel,
  ChannelCreatedEvent,
  ChannelEditedEvent,
  ChannelEvent,
  ChannelGroupEvent,
  ChannelGroupGuid,
  ChannelMessageCreatedEvent,
  ChannelMessageDeletedEvent,
  ChannelMessageEditedEvent,
  ChannelMessageEvent,
  ChannelType,
  ChannelWebRtcEvent,
  ChannelWebRtcUserAttachEvent,
  ChannelWebRtcUserDetachEvent,
  CommunityEvent,
  CommunityJoinedEvent,
  CommunityLeaveEvent,
  CommunityLeaveReason,
  CommunityMemberBanCreatedEvent,
  CommunityMemberBanDeletedEvent,
  CommunityMemberBanEvent,
  CommunityMemberRoleCreatedEvent,
  CommunityMemberRoleEvent,
  CommunityRole,
  CommunityRoleCreatedEvent,
  CommunityRoleEvent,
  MessageType,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { all, get } from "../../db";
import { read } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { formatDuration } from "../../lib/time";
import { lastKnownNickname, nicknameOf } from "../../members";
import { send } from "../../messaging";
import type { ModCase } from "../../modlog";
import { onChange } from "../../services/changes";
import { moduleConfig, settings } from "../../settings";
import { MessageCache } from "./cache";
import { LogEventKey, LogsConfig, targetChannel } from "./events";
import {
  ChannelSnapshot,
  RoleSnapshot,
  channelChanges,
  memberLine,
  memberList,
  messageDeleted,
  messageEdited,
  renderAnnouncement,
  roleChanges,
  where,
  who,
} from "./format";
import { LogQueue } from "./queue";

// Dyno-style action log: server events posted to staff channels, plus public
// ban/kick announcements.
//
// Root doesn't send events for Taproot's own actions, so kicks, bans and
// unbans done through Taproot (commands, GUI, warn thresholds) are picked up
// from new mod-log cases instead. Role and channel names are snapshotted here
// because delete events carry only an ID, and message content is cached in
// memory (see cache.ts) because delete events carry no content.

export const NAME = "logs";

export function config(): LogsConfig {
  return moduleConfig<LogsConfig>(NAME);
}

const messages = new MessageCache();
const queue = new LogQueue({
  send: async (channelId, content) => void (await send(channelId, content)),
  onError: (channelId, err) => log("warn", "action log post failed", { channelId, error: errMessage(err) }),
});
// Announcements are public, so a ban wave shares a message and a stricter budget.
const announcements = new LogQueue({
  send: async (channelId, content) => void (await send(channelId, content)),
  onError: (channelId, err) => log("warn", "ban/kick announcement failed", { channelId, error: errMessage(err) }),
  perMinute: 6,
  burst: 3,
  maxPending: 30,
});

const roles = new Map<string, RoleSnapshot>();
const channels = new Map<string, ChannelSnapshot>();
const groups = new Map<string, string>();
/** Devices per member per voice channel, so a second device doesn't log a second join. */
const voice = new Map<string, number>();
/** "kick:<user>" etc. seen from mod cases, so a matching Root event isn't logged twice. */
const recent = new Map<string, number>();
const RECENT_MS = 2 * 60_000;

// --- Helpers -----------------------------------------------------------------

/** Wraps an event handler so it can never throw into the SDK. */
function safe<E>(name: string, fn: (evt: E) => Promise<void>): (evt: E) => void {
  return (evt) => {
    fn(evt).catch((err) => log("error", `action log: ${name} failed`, { error: errMessage(err) }));
  };
}

function emit(key: LogEventKey, entry: string): void {
  const channelId = targetChannel(config(), key);
  if (channelId) queue.push(channelId, entry);
}

function wants(...keys: LogEventKey[]): boolean {
  return keys.some((key) => targetChannel(config(), key) !== null);
}

/** Channels whose messages and voice activity are never logged. */
export function isIgnoredChannel(channelId: string): boolean {
  const c = config();
  if (c.ignoredChannels.includes(channelId)) return true;
  // The log's own channels and the mod log: logging them would only echo staff chatter.
  if (channelId === c.channel || channelId === settings().modLogChannel || channelId === c.announce.channel) return true;
  return Object.values(c.events).some((e) => e.channel === channelId);
}

function isApp(userId: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(userId) === RootGuidType.App;
  } catch {
    return false;
  }
}

function markRecent(kind: string, userId: string): void {
  const now = Date.now();
  for (const [key, at] of recent) if (now - at > RECENT_MS) recent.delete(key);
  recent.set(`${kind}:${userId}`, now);
}

function wasRecent(kind: string, userId: string): boolean {
  const at = recent.get(`${kind}:${userId}`);
  return at !== undefined && Date.now() - at < RECENT_MS;
}

function channelLabel(channelId: string): string {
  return where(channelId, channels.get(channelId)?.name);
}

async function groupName(id: string): Promise<string | undefined> {
  const known = groups.get(id);
  if (known) return known;
  try {
    const group = await read("channelGroups.get", () => rootServer.community.channelGroups.get({ id: id as ChannelGroupGuid }));
    groups.set(id, group.name);
    return group.name;
  } catch {
    return undefined;
  }
}

type RoleFields = "name" | "colorHex" | "isMentionable" | "isSelfAssignable" | "channelPermission" | "communityPermission";
type ChannelFields = "name" | "description" | "channelGroupId" | "useChannelGroupPermission" | "roleOrMemberIds";

function roleSnapshot(r: Pick<CommunityRole, RoleFields>): RoleSnapshot {
  return {
    name: r.name,
    colorHex: r.colorHex ?? "",
    isMentionable: r.isMentionable,
    isSelfAssignable: r.isSelfAssignable,
    permissions: JSON.stringify([r.channelPermission ?? null, r.communityPermission ?? null]),
  };
}

function channelSnapshot(c: Pick<Channel, ChannelFields> & { channelPermission?: Channel["channelPermission"] }): ChannelSnapshot {
  return {
    name: c.name,
    description: c.description ?? "",
    groupId: c.channelGroupId,
    useGroupPermission: c.useChannelGroupPermission,
    permissions: JSON.stringify([c.channelPermission ?? null, [...(c.roleOrMemberIds ?? [])].sort()]),
  };
}

let serverName: { at: number; name: string } | undefined;
async function communityName(): Promise<string> {
  if (serverName && Date.now() - serverName.at < 10 * 60_000) return serverName.name;
  try {
    const name = (await read("communities.get", () => rootServer.community.communities.get())).name;
    serverName = { at: Date.now(), name };
    return name;
  } catch {
    return serverName?.name ?? "the community";
  }
}

function accountAge(userId: string): string[] {
  try {
    const created = RootGuidUtils.toMilliseconds(userId);
    if (!created || created > Date.now()) return [];
    return [`**Account age:** ${formatDuration(Math.max(60_000, Date.now() - created))}`];
  } catch {
    return [];
  }
}

// --- Announcements -------------------------------------------------------------

async function announce(kind: "ban" | "kick", userId: string, name: string, reason: string): Promise<void> {
  const a = config().announce;
  if (!a.channel || (kind === "ban" ? !a.bans : !a.kicks)) return;
  const template = kind === "ban" ? a.banTemplate : a.kickTemplate;
  announcements.push(a.channel, renderAnnouncement(template, { name, userId, reason, server: await communityName() }));
}

// --- Messages ------------------------------------------------------------------

function onMessage(evt: ChannelMessageCreatedEvent): void {
  if (evt.messageType === MessageType.System || isApp(evt.userId)) return;
  // Only keep content while it could be logged, and never from ignored channels.
  if (!wants("messageDelete", "messageEdit") || isIgnoredChannel(evt.channelId)) return;
  messages.set(evt.id, { channelId: evt.channelId, userId: evt.userId, content: evt.messageContent ?? "" });
}

async function onEdit(evt: ChannelMessageEditedEvent): Promise<void> {
  if (evt.messageType === MessageType.System || isApp(evt.userId) || isIgnoredChannel(evt.channelId)) return;
  if (!wants("messageDelete", "messageEdit")) return;
  const before = messages.get(evt.id);
  const after = evt.messageContent ?? "";
  // Pins and reactions can arrive as edits; only a real text change is logged.
  if (before ? before.content === after.slice(0, 2000) : !evt.editedAt) return;
  messages.set(evt.id, { channelId: evt.channelId, userId: evt.userId, content: after });
  if (!wants("messageEdit")) return;
  emit(
    "messageEdit",
    messageEdited({
      author: { name: await nicknameOf(evt.userId), id: evt.userId },
      channel: channelLabel(evt.channelId),
      before: before?.content,
      after,
      messageId: evt.id,
    }),
  );
}

async function onDelete(evt: ChannelMessageDeletedEvent): Promise<void> {
  const cached = messages.take(evt.id);
  if (isIgnoredChannel(evt.channelId) || !wants("messageDelete")) return;
  const author = cached ? { name: await nicknameOf(cached.userId as UserGuid), id: cached.userId } : undefined;
  emit(
    "messageDelete",
    messageDeleted({ author, channel: channelLabel(evt.channelId), content: cached?.content, messageId: evt.id }),
  );
}

// --- Members -------------------------------------------------------------------

async function onJoin(evt: CommunityJoinedEvent): Promise<void> {
  if (!wants("memberJoin")) return;
  const name = await nicknameOf(evt.userId);
  emit("memberJoin", memberLine("📥", "Member joined", name, evt.userId, accountAge(evt.userId)));
}

async function onLeave(evt: CommunityLeaveEvent): Promise<void> {
  // Bans are logged from the ban event, which carries the reason.
  if (evt.leaveReason === CommunityLeaveReason.Banned) return;
  const kicked = evt.leaveReason === CommunityLeaveReason.Kicked;
  if (kicked && wasRecent("kick", evt.userId)) return;
  const name = (await lastKnownNickname(evt.userId)) ?? "Unknown member";
  if (kicked) {
    emit("memberKick", memberLine("👢", "Member kicked", name, evt.userId, ["*Kicked outside Taproot.*"]));
    await announce("kick", evt.userId, name, "");
  } else {
    emit("memberLeave", memberLine("📤", "Member left", name, evt.userId));
  }
}

async function onBan(evt: CommunityMemberBanCreatedEvent): Promise<void> {
  if (wasRecent("ban", evt.userId)) return;
  const name = await nicknameOf(evt.userId);
  const reason = evt.reason?.trim() ?? "";
  const extra = [`**Reason:** ${reason || "none given"}`, "*Banned outside Taproot.*"];
  emit("banAdd", memberLine("🔨", "Member banned", name, evt.userId, extra));
  await announce("ban", evt.userId, name, reason);
}

async function onUnban(evt: CommunityMemberBanDeletedEvent): Promise<void> {
  if (wasRecent("unban", evt.userId)) return;
  const name = (await lastKnownNickname(evt.userId)) ?? "Unknown member";
  emit("banRemove", memberLine("🕊️", "Member unbanned", name, evt.userId));
}

async function onMemberRole(evt: CommunityMemberRoleCreatedEvent, added: boolean): Promise<void> {
  const key: LogEventKey = added ? "memberRoleAdd" : "memberRoleRemove";
  if (!wants(key) || evt.userIds.length === 0) return;
  const role = roles.get(evt.communityRoleId)?.name ?? "unknown role";
  const members = await Promise.all(evt.userIds.slice(0, 10).map(async (id) => ({ id, name: await nicknameOf(id) })));
  const extra = evt.userIds.length - members.length;
  const list = memberList(members) + (extra > 0 ? ` and ${extra} more` : "");
  emit(key, `${added ? "➕" : "➖"} **Role ${added ? "given" : "taken"}:** @${role}\n**Member${evt.userIds.length === 1 ? "" : "s"}:** ${list}`);
}

// --- Taproot's own kicks, bans and unbans ----------------------------------------

let lastCaseId = 0;
let caseWork: Promise<void> = Promise.resolve();

async function processNewCases(): Promise<void> {
  const newest = (await get<{ id: number | null }>("SELECT MAX(id) AS id FROM mod_cases"))?.id ?? 0;
  if (newest <= lastCaseId) return;
  const cases = await all<ModCase>(
    "SELECT * FROM mod_cases WHERE id > ? AND id <= ? AND action IN ('kick', 'ban', 'unban') ORDER BY id",
    [lastCaseId, newest],
  );
  lastCaseId = newest;
  for (const c of cases) {
    markRecent(c.action, c.user_id);
    const extra = [`**Moderator:** ${c.moderator_name}`, `**Reason:** ${c.reason || "none given"}`];
    if (c.duration_ms) extra.push(`**Duration:** ${formatDuration(c.duration_ms)}`);
    extra.push(`*Case #${c.id}*`);
    if (c.action === "kick") {
      emit("memberKick", memberLine("👢", "Member kicked", c.user_name, c.user_id, extra));
      await announce("kick", c.user_id, c.user_name, c.reason);
    } else if (c.action === "ban") {
      emit("banAdd", memberLine("🔨", "Member banned", c.user_name, c.user_id, extra));
      await announce("ban", c.user_id, c.user_name, c.reason);
    } else {
      emit("banRemove", memberLine("🕊️", "Member unbanned", c.user_name, c.user_id, [extra[0], `*Case #${c.id}*`]));
    }
  }
}

// --- Roles ---------------------------------------------------------------------

function onRoleCreated(evt: CommunityRoleCreatedEvent): void {
  roles.set(evt.id, roleSnapshot(evt));
  emit("roleCreate", `🆕 **Role created:** @${evt.name}`);
}

function onRoleEdited(evt: CommunityRoleCreatedEvent): void {
  const after = roleSnapshot(evt);
  const changes = roleChanges(roles.get(evt.id), after);
  roles.set(evt.id, after);
  if (changes.length === 0) return;
  emit("roleEdit", [`🛠️ **Role edited:** @${evt.name}`, ...changes].join("\n"));
}

function onRoleDeleted(id: string): void {
  const before = roles.get(id);
  roles.delete(id);
  emit("roleDelete", `🗑️ **Role deleted:** ${before ? `@${before.name}` : `\`${id}\``}`);
}

// --- Channels ------------------------------------------------------------------

const CHANNEL_KIND: Record<number, string> = {
  [ChannelType.Text]: "Text",
  [ChannelType.ThreadedText]: "Threaded text",
  [ChannelType.Voice]: "Voice",
  [ChannelType.App]: "App",
};

async function onChannelCreated(evt: ChannelCreatedEvent): Promise<void> {
  channels.set(evt.id, channelSnapshot(evt));
  if (!wants("channelCreate")) return;
  const group = await groupName(evt.channelGroupId);
  emit(
    "channelCreate",
    [
      `🆕 **Channel created:** ${where(evt.id, evt.name)}`,
      `**Type:** ${CHANNEL_KIND[evt.channelType] ?? "Other"}${group ? ` · **Group:** ${group}` : ""}`,
    ].join("\n"),
  );
}

async function onChannelEdited(evt: ChannelEditedEvent): Promise<void> {
  const after = channelSnapshot(evt);
  const before = channels.get(evt.id);
  channels.set(evt.id, after);
  if (!wants("channelEdit")) return;
  // Resolve both group names first so the formatter stays synchronous.
  await Promise.all([groupName(evt.channelGroupId), before ? groupName(before.groupId) : undefined]);
  const changes = channelChanges(before, after, (id) => groups.get(id));
  if (changes.length === 0) return;
  emit("channelEdit", [`🛠️ **Channel edited:** ${where(evt.id, evt.name)}`, ...changes].join("\n"));
}

function onChannelDeleted(id: string): void {
  const before = channels.get(id);
  channels.delete(id);
  messages.dropChannel(id);
  for (const key of voice.keys()) if (key.startsWith(`${id}:`)) voice.delete(key);
  emit("channelDelete", `🗑️ **Channel deleted:** ${before ? `#${before.name}` : `\`${id}\``}`);
}

// --- Voice ---------------------------------------------------------------------

async function onVoice(evt: ChannelWebRtcUserAttachEvent | ChannelWebRtcUserDetachEvent, joined: boolean): Promise<void> {
  const key = `${evt.channelId}:${evt.userId}`;
  const before = voice.get(key) ?? 0;
  const after = Math.max(0, before + (joined ? 1 : -1));
  if (after === 0) voice.delete(key);
  else voice.set(key, after);
  // Log only the first device in and the last device out.
  if (joined ? before !== 0 : after !== 0) return;
  if (isIgnoredChannel(evt.channelId) || !wants(joined ? "voiceJoin" : "voiceLeave")) return;
  const name = await nicknameOf(evt.userId);
  const kicked = !joined && (evt as ChannelWebRtcUserDetachEvent).isKick;
  emit(
    joined ? "voiceJoin" : "voiceLeave",
    `${joined ? "🔊" : "🔈"} ${who(name, evt.userId)} ${joined ? "joined" : "left"} ${channelLabel(evt.channelId)}${kicked ? " (removed by a moderator)" : ""}`,
  );
}

// --- Startup -------------------------------------------------------------------

async function loadSnapshots(): Promise<void> {
  for (const role of await read("communityRoles.list", () => rootServer.community.communityRoles.list())) {
    roles.set(role.id, roleSnapshot(role));
  }
  for (const group of await read("channelGroups.list", () => rootServer.community.channelGroups.list())) {
    groups.set(group.id, group.name);
    for (const channel of await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: group.id }))) {
      channels.set(channel.id, channelSnapshot(channel));
    }
  }
}

/** Forgets cached message content (the log was turned off, or a channel became ignored). */
export function pruneMessageCache(): void {
  if (!wants("messageDelete", "messageEdit")) {
    messages.clear();
    return;
  }
  for (const id of config().ignoredChannels) messages.dropChannel(id);
}

export async function startActionLog(): Promise<void> {
  // A failure here only leaves names unknown until the next event; never fatal.
  await loadSnapshots().catch((err) => log("warn", "action log: loading roles/channels failed", { error: errMessage(err) }));
  lastCaseId = (await get<{ id: number | null }>("SELECT MAX(id) AS id FROM mod_cases"))?.id ?? 0;

  const c = rootServer.community;
  c.channelMessages.on(ChannelMessageEvent.ChannelMessageCreated, (evt) => {
    try {
      onMessage(evt);
    } catch (err) {
      log("error", "action log: message cache failed", { error: errMessage(err) });
    }
  });
  c.channelMessages.on(ChannelMessageEvent.ChannelMessageEdited, safe("edit", onEdit));
  c.channelMessages.on(ChannelMessageEvent.ChannelMessageDeleted, safe("delete", onDelete));

  c.communities.on(CommunityEvent.CommunityJoined, safe("join", onJoin));
  c.communities.on(CommunityEvent.CommunityLeave, safe("leave", onLeave));
  c.communityMemberBans.on(CommunityMemberBanEvent.CommunityMemberBanCreated, safe("ban", onBan));
  c.communityMemberBans.on(CommunityMemberBanEvent.CommunityMemberBanDeleted, safe("unban", onUnban));
  c.communityMemberRoles.on(
    CommunityMemberRoleEvent.CommunityMemberRoleCreated,
    safe("role add", (evt: CommunityMemberRoleCreatedEvent) => onMemberRole(evt, true)),
  );
  c.communityMemberRoles.on(
    CommunityMemberRoleEvent.CommunityMemberRoleDeleted,
    safe("role remove", (evt: CommunityMemberRoleCreatedEvent) => onMemberRole(evt, false)),
  );

  c.communityRoles.on(CommunityRoleEvent.CommunityRoleCreated, safe("role created", async (evt) => onRoleCreated(evt)));
  c.communityRoles.on(CommunityRoleEvent.CommunityRoleEdited, safe("role edited", async (evt) => onRoleEdited(evt)));
  c.communityRoles.on(CommunityRoleEvent.CommunityRoleDeleted, safe("role deleted", async (evt) => onRoleDeleted(evt.communityRoleId)));

  c.channels.on(ChannelEvent.ChannelCreated, safe("channel created", onChannelCreated));
  c.channels.on(ChannelEvent.ChannelEdited, safe("channel edited", onChannelEdited));
  c.channels.on(ChannelEvent.ChannelDeleted, safe("channel deleted", async (evt) => onChannelDeleted(evt.id)));
  c.channelGroups.on(ChannelGroupEvent.ChannelGroupCreated, (evt) => groups.set(evt.id, evt.name));
  c.channelGroups.on(ChannelGroupEvent.ChannelGroupEdited, (evt) => groups.set(evt.id, evt.name));

  // Voice events may be missing on older hosts; the rest of the log works without them.
  try {
    c.channelWebRtcs.on(ChannelWebRtcEvent.ChannelWebRtcUserAttach, safe("voice join", (evt) => onVoice(evt, true)));
    c.channelWebRtcs.on(ChannelWebRtcEvent.ChannelWebRtcUserDetach, safe("voice leave", (evt) => onVoice(evt, false)));
  } catch (err) {
    log("warn", "action log: voice events unavailable", { error: errMessage(err) });
  }

  onChange((area) => {
    if (area !== "cases") return;
    caseWork = caseWork
      .then(processNewCases)
      .catch((err) => log("error", "action log: reading new cases failed", { error: errMessage(err) }));
  });
}
