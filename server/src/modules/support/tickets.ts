import {
  rootServer,
  ChannelDeletedEvent,
  ChannelEditedEvent,
  ChannelEvent,
  ChannelGroupGuid,
  ChannelGuid,
  ChannelMessage,
  ChannelMessageEvent,
  ChannelMessageReactionCreatedEvent,
  ChannelOrChannelGroupGuid,
  ChannelOverlayPermission,
  ChannelType,
  ErrorCodeType,
  MessageDirectionTake,
  MessageGuid,
  RoleOrMemberGuid,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-app";
import { all, get, run } from "../../db";
import { emojiDisplay, emojiKey } from "../../features/emoji";
import { onReconcile } from "../../jobs";
import { describeError, errorCode, read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { channelMention, fillTemplate, MAX_MESSAGE, roleMention, truncate, userMention } from "../../lib/text";
import { nicknameOf } from "../../members";
import { deleteMessage, send, sendEphemeral } from "../../messaging";
import { Level, levelOf, listRoles, memberRoleIds } from "../../permissions";
import { notifyChange } from "../../services/changes";
import { settings } from "../../settings";
import { config, updateConfig } from "./config";
import { formatTranscript, ticketChannelName, TranscriptMessage, transcriptMessages } from "./logic";

// Tickets: a private text channel per request, visible only to the opener,
// the staff roles and Taproot. Root has no threads-as-tickets or DMs, so a
// channel with independent permissions is the private space. On close the
// channel's messages are saved as a plain-text transcript, posted to the log
// channel, and the channel is deleted.

export interface Ticket {
  id: number;
  channel_id: string;
  channel_name: string;
  opener_id: string;
  opener_name: string;
  topic: string;
  status: "pending" | "open" | "closed";
  claimed_by_id: string | null;
  claimed_by_name: string | null;
  opened_at: number;
  closed_at: number | null;
  closed_by_name: string | null;
  close_reason: string | null;
  transcript: string | null;
  message_count: number;
}

/** Ticket without the (possibly large) transcript, for lists. */
export type TicketSummary = Omit<Ticket, "transcript"> & { has_transcript: number };

const SUMMARY_COLUMNS =
  "id, channel_id, channel_name, opener_id, opener_name, topic, status, claimed_by_id, claimed_by_name, opened_at, closed_at, closed_by_name, close_reason, message_count, transcript IS NOT NULL AS has_transcript";

export async function createTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL DEFAULT '',
    channel_name TEXT NOT NULL DEFAULT '',
    opener_id TEXT NOT NULL,
    opener_name TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_by_id TEXT,
    claimed_by_name TEXT,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_by_name TEXT,
    close_reason TEXT,
    transcript TEXT,
    message_count INTEGER NOT NULL DEFAULT 0
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, id DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_support_tickets_opener ON support_tickets (opener_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_support_tickets_channel ON support_tickets (channel_id)`);
}

const changed = () => notifyChange("support:tickets");

// --- Lookups ------------------------------------------------------------------------

export async function ticketById(id: number): Promise<Ticket | undefined> {
  return get<Ticket>("SELECT * FROM support_tickets WHERE id = ?", [id]);
}

export async function openTicketInChannel(channelId: string): Promise<Ticket | undefined> {
  return get<Ticket>("SELECT * FROM support_tickets WHERE channel_id = ? AND status = 'open'", [channelId]);
}

export async function listTickets(status: "open" | "closed" | undefined, offset: number, limit: number) {
  const where = status ? "WHERE status = ?" : "WHERE status != 'pending'";
  const params = status ? [status] : [];
  const [rows, total] = await Promise.all([
    all<TicketSummary>(`SELECT ${SUMMARY_COLUMNS} FROM support_tickets ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ]),
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM support_tickets ${where}`, params),
  ]);
  return { rows, total: total?.n ?? 0 };
}

export async function listMyTickets(userId: string): Promise<TicketSummary[]> {
  return all<TicketSummary>(
    `SELECT ${SUMMARY_COLUMNS} FROM support_tickets WHERE opener_id = ? AND status != 'pending' ORDER BY id DESC LIMIT 20`,
    [userId],
  );
}

export async function deleteTicketRecord(id: number): Promise<boolean> {
  const { changes } = await run("DELETE FROM support_tickets WHERE id = ? AND status = 'closed'", [id]);
  if (changes) changed();
  return changes > 0;
}

// --- Who's who ---------------------------------------------------------------------

/**
 * Taproot's own member ID, for its access rule on ticket channels. Learned
 * from any message this module posts; before that, the App's ID, which is
 * what Root uses as an App's member ID.
 */
export function selfId(): string {
  return config().selfUserId ?? rootServer.appId;
}

/** Records Taproot's member ID from a message it just posted. */
export async function learnSelf(msg: ChannelMessage): Promise<void> {
  if (!msg.userId || msg.userId === config().selfUserId) return;
  await updateConfig((c) => {
    c.selfUserId = msg.userId;
  }).catch((err) => log("warn", "saving Taproot's member ID failed", { error: errMessage(err) }));
}

async function post(channelId: string, content: string): Promise<ChannelMessage> {
  const msg = await send(channelId, content);
  await learnSelf(msg);
  return msg;
}

/**
 * The roles that see every ticket: the configured ones, or when none are
 * picked, every role with moderator or admin permissions.
 */
export async function staffRoleIds(): Promise<string[]> {
  const roles = await listRoles();
  const configured = config().tickets.staffRoleIds.filter((id) => roles.some((r) => r.id === id));
  if (configured.length > 0) return configured;
  return roles
    .filter((r) => r.id !== WellKnownRootGuids.CommunityRoles.EveryoneRole)
    .filter((r) => {
      const p = r.communityPermission;
      return p && (p.communityFullControl || p.communityManageCommunity || p.communityKick || p.communityCreateBan || p.communityManageBans);
    })
    .map((r) => r.id);
}

/** Moderators and members holding a ticket staff role can work tickets. */
export async function isTicketStaff(userId: UserGuid): Promise<boolean> {
  if ((await levelOf(userId)) >= Level.Moderator) return true;
  const [mine, staff] = await Promise.all([memberRoleIds(userId), staffRoleIds()]);
  return mine.some((id) => staff.includes(id));
}

// --- Opening ---------------------------------------------------------------------------

const MEMBER_OVERLAY: ChannelOverlayPermission = {
  channelView: true,
  channelViewMessageHistory: true,
  channelCreateMessage: true,
  channelCreateMessageReaction: true,
  channelCreateMessageAttachment: true,
};

const STAFF_OVERLAY: ChannelOverlayPermission = {
  ...MEMBER_OVERLAY,
  channelDeleteMessageOther: true,
  channelManagePinnedMessages: true,
};

const SELF_OVERLAY: ChannelOverlayPermission = { channelFullControl: true, channelView: true };

export const MAX_TOPIC = 200;

// One open at a time per member, so a double click can't pass the limit twice.
const opening = new Set<string>();

export type OpenResult = { ticket: Ticket } | { problem: string };

/**
 * Opens a ticket for `userId`: checks the limits, creates the private
 * channel and posts the welcome message. Returns why not, for the caller to
 * show in chat or the GUI.
 */
export async function openTicket(userId: UserGuid, rawTopic: string): Promise<OpenResult> {
  const t = config().tickets;
  if (!t.enabled) return { problem: "Tickets are turned off in this community." };
  if (!t.channelGroupId) return { problem: "Tickets aren't set up yet: an admin needs to pick a channel group for them." };
  if (opening.has(userId)) return { problem: "Your ticket is already being opened." };
  opening.add(userId);
  try {
    const count = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM support_tickets WHERE opener_id = ? AND status IN ('open', 'pending')", [userId]))?.n ?? 0;
    if (count >= t.maxOpen) {
      return {
        problem: t.maxOpen === 1 ? "You already have an open ticket." : `You already have ${count} open tickets, the most allowed.`,
      };
    }
    const topic = truncate(rawTopic.replace(/\s+/g, " ").trim(), MAX_TOPIC);
    const nickname = await nicknameOf(userId);
    const now = Date.now();
    const { lastID: id } = await run(
      "INSERT INTO support_tickets (opener_id, opener_name, topic, status, opened_at) VALUES (?, ?, ?, 'pending', ?)",
      [userId, nickname, topic, now],
    );
    const name = ticketChannelName(id, nickname);
    const staff = await staffRoleIds();
    let channelId: string;
    try {
      const channel = await write("channels.create", () =>
        rootServer.community.channels.create({
          channelGroupId: t.channelGroupId as ChannelGroupGuid,
          name,
          description: truncate(topic ? `Ticket #${id}: ${topic}` : `Ticket #${id}`, 256),
          channelType: ChannelType.Text,
          useChannelGroupPermission: false,
          accessRuleCreates: [
            { roleOrMemberId: selfId() as RoleOrMemberGuid, overlay: SELF_OVERLAY },
            { roleOrMemberId: userId as unknown as RoleOrMemberGuid, overlay: MEMBER_OVERLAY },
            ...staff.map((roleId) => ({ roleOrMemberId: roleId as RoleOrMemberGuid, overlay: STAFF_OVERLAY })),
          ],
        }),
      );
      channelId = channel.id;
    } catch (err) {
      await run("DELETE FROM support_tickets WHERE id = ?", [id]);
      log("warn", "ticket channel create failed", { error: errMessage(err) });
      return { problem: `I couldn't create the ticket channel: ${describeError(err)}` };
    }
    await run("UPDATE support_tickets SET channel_id = ?, channel_name = ?, status = 'open' WHERE id = ?", [channelId, name, id]);
    changed();

    const ticket = (await ticketById(id))!;
    await postWelcome(ticket, staff).catch((err) => log("warn", "ticket welcome failed", { error: errMessage(err) }));
    await logToChannel(
      `🎫 Ticket **#${id}** opened by ${userMention(nickname, userId)} in ${channelMention(name, channelId)}${topic ? `: ${topic}` : ""}`,
    );
    return { ticket };
  } finally {
    opening.delete(userId);
  }
}

async function postWelcome(ticket: Ticket, staff: string[]): Promise<void> {
  const t = config().tickets;
  const prefix = settings().prefix;
  const text = fillTemplate(t.welcomeMessage || "", {
    user: userMention(ticket.opener_name, ticket.opener_id),
    "user.name": ticket.opener_name,
    topic: ticket.topic || "not given",
    ticket: `#${ticket.id}`,
  });
  const lines: string[] = [];
  if (t.pingStaff && staff.length > 0) {
    const roles = await listRoles();
    lines.push(staff.map((id) => roleMention(roles.find((r) => r.id === id)?.name ?? "staff", id)).join(" "));
  }
  if (text.trim()) lines.push(text.trim());
  lines.push(
    "",
    `*Close this ticket with \`${prefix}ticket close [reason]\`. Staff can also use \`${prefix}ticket claim\`, \`${prefix}ticket add @member\`, \`${prefix}ticket remove @member\` and \`${prefix}ticket rename <name>\`.*`,
  );
  await post(ticket.channel_id, lines.join("\n"));
}

/** Posts to the ticket log channel, if there is one. Best effort. */
async function logToChannel(content: string): Promise<void> {
  const channelId = config().tickets.logChannelId;
  if (!channelId) return;
  await post(channelId, content).catch((err) => log("warn", "ticket log post failed", { error: errMessage(err) }));
}

// --- Working a ticket -------------------------------------------------------------

export async function addToTicket(ticket: Ticket, userId: string): Promise<void> {
  await write("accessRules.create", () =>
    rootServer.community.accessRules.create({
      channelOrChannelGroupId: ticket.channel_id as ChannelOrChannelGroupGuid,
      roleOrMemberId: userId as RoleOrMemberGuid,
      overlay: MEMBER_OVERLAY,
    }),
  );
}

/** False when the member had no rule of their own on the channel. */
export async function removeFromTicket(ticket: Ticket, userId: string): Promise<boolean> {
  try {
    await write("accessRules.delete", () =>
      rootServer.community.accessRules.delete({
        channelOrChannelGroupId: ticket.channel_id as ChannelOrChannelGroupGuid,
        roleOrMemberId: userId as RoleOrMemberGuid,
      }),
    );
    return true;
  } catch (err) {
    if (errorCode(err) === ErrorCodeType.NotFound) return false;
    throw err;
  }
}

export async function setClaim(ticket: Ticket, userId: string | null): Promise<void> {
  const name = userId ? await nicknameOf(userId as UserGuid) : null;
  await run("UPDATE support_tickets SET claimed_by_id = ?, claimed_by_name = ? WHERE id = ?", [userId, name, ticket.id]);
  changed();
}

export async function renameTicket(ticket: Ticket, name: string): Promise<void> {
  const channel = await read("channels.get", () => rootServer.community.channels.get({ id: ticket.channel_id as ChannelGuid }));
  await write("channels.edit", () =>
    rootServer.community.channels.edit({
      id: channel.id,
      name,
      description: channel.description,
      updateIcon: false,
      useChannelGroupPermission: false,
    }),
  );
  await run("UPDATE support_tickets SET channel_name = ? WHERE id = ?", [name, ticket.id]);
  changed();
}

// --- Closing ------------------------------------------------------------------------------

const PAGE = 50;
/** 60 pages of 50: the newest 3,000 messages are kept. */
const MAX_PAGES = 60;

/** The channel's messages, newest first, paged backwards by time. */
async function fetchMessages(channelId: string): Promise<{ messages: ChannelMessage[]; truncated: boolean }> {
  const seen = new Map<string, ChannelMessage>();
  let dateAt = new Date(Date.now() + 60_000);
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await read("channelMessages.list", () =>
      rootServer.community.channelMessages.list({
        channelId: channelId as ChannelGuid,
        messageDirectionTake: MessageDirectionTake.Older,
        dateAt,
        limit: PAGE,
      }),
    );
    const fresh = res.messages.filter((m) => !seen.has(m.id));
    for (const m of fresh) seen.set(m.id, m);
    if (fresh.length === 0 || res.messages.length < PAGE) return { messages: [...seen.values()], truncated: false };
    const oldest = Math.min(...fresh.map((m) => RootGuidUtils.toMilliseconds(m.id)));
    dateAt = new Date(oldest);
  }
  return { messages: [...seen.values()], truncated: true };
}

async function buildTranscript(ticket: Ticket, closedBy: string, reason: string, closedAt: number) {
  const { messages, truncated } = await fetchMessages(ticket.channel_id);
  const names = new Map<string, string>();
  const nameOf = async (userId: UserGuid) => {
    if (!names.has(userId)) names.set(userId, userId === selfId() ? "Taproot" : await nicknameOf(userId));
    return names.get(userId)!;
  };
  const lines: TranscriptMessage[] = [];
  for (const m of messages) {
    if (m.deletedAt) continue;
    lines.push({
      atMs: RootGuidUtils.toMilliseconds(m.id),
      author: await nameOf(m.userId),
      content: m.messageContent ?? "",
      attachments: m.messageUris.filter((u) => u.attachment).map((u) => u.attachment!.fileName),
      edited: Boolean(m.editedAt),
    });
  }
  const text = formatTranscript(
    {
      id: ticket.id,
      topic: ticket.topic,
      opener: ticket.opener_name,
      openedAtMs: ticket.opened_at,
      closedBy,
      closedAtMs: closedAt,
      reason,
    },
    lines,
    truncated,
  );
  return { text, count: lines.length };
}

const closing = new Set<number>();

/**
 * Saves the transcript, posts it to the log channel and deletes the ticket
 * channel. The ticket is marked closed before the channel goes, so the
 * ChannelDeleted event doesn't treat it as deleted by hand.
 */
export async function closeTicket(ticket: Ticket, actorId: UserGuid, rawReason: string): Promise<{ problem?: string }> {
  if (ticket.status !== "open") return { problem: "That ticket is already closed." };
  if (closing.has(ticket.id)) return { problem: "That ticket is already closing." };
  closing.add(ticket.id);
  try {
    const reason = truncate(rawReason.replace(/\s+/g, " ").trim(), 300);
    const closedBy = await nicknameOf(actorId);
    const closedAt = Date.now();
    let transcript: string | null = null;
    let count = 0;
    try {
      ({ text: transcript, count } = await buildTranscript(ticket, closedBy, reason, closedAt));
    } catch (err) {
      if (errorCode(err) === ErrorCodeType.NotFound) {
        await markGone(ticket);
        return { problem: "The ticket's channel was already deleted, so it's closed without a transcript." };
      }
      // Without a transcript the channel stays, so nothing is lost.
      log("warn", "ticket transcript failed", { error: errMessage(err) });
      return { problem: `I couldn't read the ticket's messages, so it's still open: ${describeError(err)}` };
    }
    const { changes } = await run(
      "UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by_name = ?, close_reason = ?, transcript = ?, message_count = ? WHERE id = ? AND status = 'open'",
      [closedAt, closedBy, reason, transcript, count, ticket.id],
    );
    if (!changes) return { problem: "That ticket is already closed." };
    changed();

    await postTranscript({ ...ticket, closed_by_name: closedBy, close_reason: reason, message_count: count }, transcript);
    try {
      await write("channels.delete", () => rootServer.community.channels.delete({ id: ticket.channel_id as ChannelGuid }));
    } catch (err) {
      if (errorCode(err) !== ErrorCodeType.NotFound) {
        log("warn", "ticket channel delete failed", { error: errMessage(err) });
        return { problem: `The ticket is closed and saved, but I couldn't delete its channel: ${describeError(err)}` };
      }
    }
    // A private ping (Apps can't DM); no reason, since it shows on lock screens.
    await write("notifications.send", () =>
      rootServer.community.notifications.send({
        userIds: [ticket.opener_id as UserGuid],
        title: "Ticket closed",
        description: `Your ticket #${ticket.id} was closed. Thanks for reaching out!`,
      }),
    ).catch(() => undefined);
    return {};
  } finally {
    closing.delete(ticket.id);
  }
}

/** Longest transcript posted in full, in messages. */
const MAX_TRANSCRIPT_MESSAGES = 10;

async function postTranscript(ticket: Ticket, transcript: string): Promise<void> {
  const t = config().tickets;
  if (!t.logChannelId) return;
  const summary = [
    `🔒 Ticket **#${ticket.id}** closed by **${ticket.closed_by_name}**${ticket.close_reason ? `: ${ticket.close_reason}` : ""}`,
    `Opened by ${userMention(ticket.opener_name, ticket.opener_id)}${ticket.topic ? ` · ${ticket.topic}` : ""} · ${ticket.message_count} message(s)`,
  ].join("\n");
  if (t.transcriptMode !== "full") {
    await logToChannel(`${summary}\nThe transcript is on the **Tickets** page in the Taproot channel.`);
    return;
  }
  const parts = transcriptMessages(transcript, MAX_MESSAGE, MAX_TRANSCRIPT_MESSAGES);
  if (!parts) {
    await logToChannel(`${summary}\nThe transcript is too long to post; it's on the **Tickets** page in the Taproot channel.`);
    return;
  }
  await logToChannel(summary);
  for (const part of parts) await logToChannel(part);
}

// --- Reconcile --------------------------------------------------------------------------

async function markGone(ticket: Ticket): Promise<void> {
  const { changes } = await run(
    "UPDATE support_tickets SET status = 'closed', closed_at = ?, closed_by_name = ?, close_reason = ? WHERE id = ? AND status = 'open'",
    [Date.now(), "Nobody (channel deleted)", "The ticket channel was deleted outside Taproot, so there's no transcript.", ticket.id],
  );
  if (!changes) return;
  changed();
  await logToChannel(`🗑️ Ticket **#${ticket.id}** (${ticket.opener_name}) was closed because its channel was deleted. No transcript was saved.`);
}

/**
 * Closes tickets whose channels are gone, drops half-opened ones left by a
 * restart, and clears transcripts past the retention period.
 */
async function reconcile(): Promise<void> {
  await run("DELETE FROM support_tickets WHERE status = 'pending' AND opened_at < ?", [Date.now() - 10 * 60_000]);
  const open = await all<Ticket>("SELECT * FROM support_tickets WHERE status = 'open'");
  for (const ticket of open) {
    try {
      await read("channels.get", () => rootServer.community.channels.get({ id: ticket.channel_id as ChannelGuid }));
    } catch (err) {
      const code = errorCode(err);
      if (code === ErrorCodeType.NotFound || code === ErrorCodeType.RequestValidationFailed) await markGone(ticket);
    }
  }
  const days = config().tickets.retentionDays;
  if (days > 0) {
    const { changes } = await run(
      "UPDATE support_tickets SET transcript = NULL WHERE status = 'closed' AND transcript IS NOT NULL AND closed_at < ?",
      [Date.now() - days * 86_400_000],
    );
    if (changes) changed();
  }
}

// --- Panel -----------------------------------------------------------------------------------

/** Posts (or re-posts) the "react to open a ticket" message. */
export async function postPanel(channelId: string, title: string, description: string, shortcode: string): Promise<void> {
  await removePanel();
  const body = [`**${title}**`, description, "", `React with ${emojiDisplay(shortcode)} to open a private ticket with the staff.`]
    .filter((line, i) => i !== 1 || line)
    .join("\n");
  const msg = await post(channelId, body);
  await updateConfig((c) => {
    c.tickets.panel = { channelId, messageId: msg.id, emoji: shortcode };
  });
  await write("channelMessages.reactionCreate", () =>
    rootServer.community.channelMessages.reactionCreate({ channelId: channelId as ChannelGuid, messageId: msg.id, shortcode }),
  ).catch(() => undefined);
}

export async function removePanel(): Promise<void> {
  const panel = config().tickets.panel;
  if (!panel.channelId || !panel.messageId) return;
  await deleteMessage(panel.channelId, panel.messageId).catch(() => undefined);
  await updateConfig((c) => {
    c.tickets.panel = { ...c.tickets.panel, channelId: null, messageId: null };
  });
}

async function onPanelReaction(evt: ChannelMessageReactionCreatedEvent): Promise<void> {
  const panel = config().tickets.panel;
  if (!panel.messageId || evt.messageId !== panel.messageId) return;
  if (emojiKey(evt.shortcode) !== emojiKey(panel.emoji)) return;
  if (RootGuidUtils.toRootGuidType(evt.userId) === RootGuidType.App) return;
  const result = await openTicket(evt.userId, "");
  const who = userMention(await nicknameOf(evt.userId), evt.userId);
  if ("problem" in result) sendEphemeral(evt.channelId, `🎫 ${who}: ${result.problem}`);
  else {
    const t = result.ticket;
    sendEphemeral(evt.channelId, `🎫 ${who}, your ticket is open: ${channelMention(t.channel_name, t.channel_id)}`, 15_000);
  }
  // Clear the reactions so the next click fires again, then put Taproot's back.
  const messages = rootServer.community.channelMessages;
  const target = { channelId: evt.channelId, messageId: evt.messageId as MessageGuid, shortcode: evt.shortcode };
  await write("channelMessages.reactionDeleteFull", () => messages.reactionDeleteFull(target)).catch(() => undefined);
  await write("channelMessages.reactionCreate", () => messages.reactionCreate({ ...target, shortcode: panel.emoji })).catch(
    () => undefined,
  );
}

// --- Events -------------------------------------------------------------------------------

export function registerTicketEvents(): void {
  const channels = rootServer.community.channels;
  // Handlers never throw: an unhandled rejection restarts the server.
  channels.on(ChannelEvent.ChannelDeleted, (evt: ChannelDeletedEvent) => {
    openTicketInChannel(evt.id)
      .then((ticket) => (ticket ? markGone(ticket) : undefined))
      .catch((err) => log("error", "ticket channel-deleted handler failed", { error: errMessage(err) }));
  });
  channels.on(ChannelEvent.ChannelEdited, (evt: ChannelEditedEvent) => {
    run("UPDATE support_tickets SET channel_name = ? WHERE channel_id = ? AND status = 'open' AND channel_name != ?", [
      evt.name,
      evt.id,
      evt.name,
    ])
      .then(({ changes }) => changes && changed())
      .catch((err) => log("error", "ticket channel-edited handler failed", { error: errMessage(err) }));
  });
  rootServer.community.channelMessages.on(ChannelMessageEvent.ChannelMessageReactionCreated, (evt) => {
    onPanelReaction(evt).catch((err) => log("error", "ticket panel reaction failed", { error: errMessage(err) }));
  });
  onReconcile(reconcile);
}

