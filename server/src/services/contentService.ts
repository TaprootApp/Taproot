import { rootServer, ChannelGuid, Client, ErrorCodeType, UserGuid, WellKnownRootGuids } from "@rootsdk/server-app";
import { ContentServiceBase } from "@taproot/gen-server";
import {
  AddPanelRoleRequest,
  AddPanelRoleResponse,
  Announcement,
  AnnouncementList,
  CreateAnnouncementRequest,
  CreatePanelRequest,
  CustomCommandList,
  IdRequest,
  NameRequest,
  Panel,
  PanelList,
  PostMessageRequest,
  ReminderList,
  RemovePanelRoleRequest,
  Repeat,
  SaveCustomCommandRequest,
  SelfRoleList,
  SetSelfRoleRequest,
} from "@taproot/gen-shared";
import { isReservedName } from "../commands/registry";
import {
  deleteCustomCommand,
  findCustomCommand,
  listCustomCommands,
  NAME,
  saveCustomCommand,
} from "../features/customCommands";
import { emojiAsTyped } from "../features/emoji";
import * as reminders from "../features/reminders";
import * as roles from "../features/roles";
import { errorCode, read } from "../lib/api";
import { send } from "../messaging";
import { isPrivileged, Level, listRoles, memberRoleIds } from "../permissions";
import { settings } from "../settings";
import { act, invalid, notFound, requireLevel } from "./auth";
import { ChangeArea, onChange } from "./changes";
import { repeatFromWire, REPEAT_TO_WIRE } from "./wire";

// Custom commands, reaction panels and announcements for staff, plus the
// member-facing self roles and reminders. Every change goes through the same
// feature functions the text commands use, so the rules and side effects
// (panel edits, job scheduling, broadcasts) are identical.

const MAX_AHEAD = 5 * 365 * 86_400_000;

const CONTENT_AREAS = new Set<ChangeArea>(["commands", "panels", "announcements", "selfroles", "reminders"]);

// --- Lookups -------------------------------------------------------------------

const CHANNEL_TTL = 60_000;
const channelNames = new Map<string, { at: number; name: string }>();

/** A channel's name for display; lists shouldn't fail over one deleted channel. */
async function channelName(channelId: string): Promise<string> {
  const cached = channelNames.get(channelId);
  if (cached && Date.now() - cached.at < CHANNEL_TTL) return cached.name;
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    channelNames.set(channelId, { at: Date.now(), name: channel.name });
    return channel.name;
  } catch {
    return "unknown channel";
  }
}

/** Checks a channel from the GUI exists before posting to it. */
async function requireChannel(channelId: string): Promise<void> {
  if (!channelId) invalid("Pick a channel.");
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    channelNames.set(channelId, { at: Date.now(), name: channel.name });
  } catch (err) {
    if (errorCode(err) === ErrorCodeType.NotFound || errorCode(err) === ErrorCodeType.RequestValidationFailed) {
      invalid("That channel doesn't exist anymore.");
    }
    await act(() => Promise.reject(err));
  }
}

function required(text: string, what: string): string {
  const trimmed = text.trim();
  if (!trimmed) invalid(`${what} can't be empty.`);
  return trimmed;
}

// --- Conversions ---------------------------------------------------------------

async function toPanel(panel: roles.Panel): Promise<Panel> {
  const [entries, allRoles, channel] = await Promise.all([roles.panelEntries(panel.id), listRoles(), channelName(panel.channel_id)]);
  return {
    id: panel.id,
    channelId: panel.channel_id,
    channelName: channel,
    title: panel.title,
    roles: entries.map((e) => ({
      emoji: emojiAsTyped(e.shortcode),
      roleId: e.role_id,
      roleName: allRoles.find((r) => r.id === e.role_id)?.name ?? "deleted role",
      label: e.label,
    })),
  };
}

async function panelList(): Promise<PanelList> {
  return { panels: await Promise.all((await roles.listPanels()).map(toPanel)) };
}

async function requirePanel(id: number): Promise<roles.Panel> {
  return (await roles.panelById(id)) ?? notFound("That panel doesn't exist anymore.");
}

async function requireEmoji(raw: string): Promise<string> {
  return (await act(() => roles.resolveEmojiText(raw.trim()))) ?? invalid("Write the emoji as a :shortcode:, like :tada:.");
}

async function toAnnouncement(a: reminders.Announcement): Promise<Announcement> {
  return {
    id: a.id,
    channelId: a.channel_id,
    channelName: await channelName(a.channel_id),
    message: a.message,
    nextAtMs: a.next_at,
    repeat: REPEAT_TO_WIRE[a.repeat] ?? Repeat.ONCE,
  };
}

async function announcementList(): Promise<AnnouncementList> {
  return { announcements: await Promise.all((await reminders.listAnnouncements()).map(toAnnouncement)) };
}

async function commandList(): Promise<CustomCommandList> {
  return { commands: (await listCustomCommands()).map((c) => ({ name: c.name, response: c.response, uses: c.uses })) };
}

/** Self-assignable roles the caller can use, marked with whether they have each. */
async function selfRoleList(userId: UserGuid): Promise<SelfRoleList> {
  const [allRoles, mine] = await Promise.all([listRoles(), memberRoleIds(userId)]);
  const out: SelfRoleList["roles"] = [];
  for (const id of settings().selfRoles) {
    const role = allRoles.find((r) => r.id === id);
    // Deleted roles and ones that gained staff permissions can't be self-assigned.
    if (!role || isPrivileged(role)) continue;
    out.push({ roleId: role.id, name: role.name, colorHex: role.colorHex ?? "", has: mine.includes(role.id) });
  }
  return { roles: out };
}

async function reminderList(userId: UserGuid): Promise<ReminderList> {
  const list = await reminders.listReminders(userId);
  return {
    reminders: await Promise.all(
      list.map(async (r) => ({
        id: r.id,
        channelId: r.channel_id,
        channelName: await channelName(r.channel_id),
        message: r.message,
        dueAtMs: r.due_at,
      })),
    ),
  };
}

/**
 * Command names as typed in the GUI: lowercase, with a pasted prefix dropped.
 * A name that's already valid is kept whole, so a letter prefix like "t"
 * doesn't eat the start of "test" (stored names are always valid).
 */
function normalizeName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (NAME.test(trimmed)) return trimmed;
  const prefix = settings().prefix.toLowerCase();
  return prefix && trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
}

// --- Service ---------------------------------------------------------------------

class ContentService extends ContentServiceBase {
  // Custom commands (moderator+).

  async listCustomCommands(client: Client): Promise<CustomCommandList> {
    await requireLevel(client, Level.Moderator);
    return commandList();
  }

  async saveCustomCommand(request: SaveCustomCommandRequest, client: Client): Promise<CustomCommandList> {
    await requireLevel(client, Level.Moderator);
    const name = normalizeName(request.name);
    const response = required(request.response, "The response");
    // Same rules as "cc add/edit".
    if (!NAME.test(name)) invalid("Names use letters, numbers, - and _ (up to 32 characters).");
    if (isReservedName(name)) invalid(`\`${name}\` is a built-in command.`);
    const original = request.originalName !== undefined ? normalizeName(request.originalName) : undefined;
    if (original) {
      if (!(await findCustomCommand(original))) notFound(`No custom command called \`${original}\`.`);
      if (original !== name && (await findCustomCommand(name))) invalid(`\`${name}\` already exists.`);
    } else if (await findCustomCommand(name)) {
      invalid(`\`${name}\` already exists.`);
    }
    await saveCustomCommand(name, response, client.userId, original || undefined);
    return commandList();
  }

  async deleteCustomCommand(request: NameRequest, client: Client): Promise<CustomCommandList> {
    await requireLevel(client, Level.Moderator);
    const name = normalizeName(request.name);
    if (!(await deleteCustomCommand(name))) notFound(`No custom command called \`${name}\`.`);
    return commandList();
  }

  // Reaction panels (admin).

  async listPanels(client: Client): Promise<PanelList> {
    await requireLevel(client, Level.Admin);
    return act(panelList);
  }

  async createPanel(request: CreatePanelRequest, client: Client): Promise<Panel> {
    await requireLevel(client, Level.Admin);
    const title = required(request.title, "The title");
    await requireChannel(request.channelId);
    const panel = await act(() => roles.createPanel(request.channelId, title));
    return act(() => toPanel(panel));
  }

  async addPanelRole(request: AddPanelRoleRequest, client: Client): Promise<AddPanelRoleResponse> {
    await requireLevel(client, Level.Admin);
    const panel = await requirePanel(request.panelId);
    const shortcode = await requireEmoji(request.emoji);
    const role = await act(() => roles.roleById(request.roleId));
    if (!role || role.id === WellKnownRootGuids.CommunityRoles.EveryoneRole) invalid("I couldn't find that role.");
    // Same rule as "rr add".
    if (isPrivileged(role)) invalid("That role has staff permissions, so it can't be self-assigned.");
    const seeded = await act(() => roles.addPanelRole(panel, shortcode, role, request.label.trim()));
    return { panel: await act(() => toPanel(panel)), reactionSeeded: seeded };
  }

  async removePanelRole(request: RemovePanelRoleRequest, client: Client): Promise<Panel> {
    await requireLevel(client, Level.Admin);
    const panel = await requirePanel(request.panelId);
    const shortcode = await requireEmoji(request.emoji);
    if (!(await act(() => roles.removePanelRole(panel, shortcode)))) notFound("That emoji isn't on the panel.");
    return act(() => toPanel(panel));
  }

  async deletePanel(request: IdRequest, client: Client): Promise<PanelList> {
    await requireLevel(client, Level.Admin);
    const panel = await requirePanel(request.id);
    await act(() => roles.deletePanel(panel));
    return act(panelList);
  }

  // Announcements (moderator+).

  async listAnnouncements(client: Client): Promise<AnnouncementList> {
    await requireLevel(client, Level.Moderator);
    return act(announcementList);
  }

  async createAnnouncement(request: CreateAnnouncementRequest, client: Client): Promise<AnnouncementList> {
    await requireLevel(client, Level.Moderator);
    const message = required(request.message, "The message");
    const repeat = repeatFromWire(request.repeat) ?? invalid("Unknown repeat option.");
    if (!Number.isFinite(request.atMs) || request.atMs <= 0) invalid("Pick a time.");
    if (request.atMs > Date.now() + MAX_AHEAD) invalid("Pick a time within the next 5 years.");
    await requireChannel(request.channelId);
    const result = await act(() => reminders.createAnnouncement(request.channelId, message, new Date(request.atMs), repeat, client.userId));
    if ("problem" in result) invalid(result.problem);
    return act(announcementList);
  }

  async deleteAnnouncement(request: IdRequest, client: Client): Promise<AnnouncementList> {
    await requireLevel(client, Level.Moderator);
    if (!(await act(() => reminders.deleteAnnouncement(request.id)))) notFound("No announcement with that number.");
    return act(announcementList);
  }

  async postMessage(request: PostMessageRequest, client: Client): Promise<void> {
    await requireLevel(client, Level.Moderator);
    const message = required(request.message, "The message");
    await requireChannel(request.channelId);
    // Like "announce": posted as Taproot.
    await act(() => send(request.channelId, message));
  }

  // Self roles and reminders (anyone, their own only).

  async listSelfRoles(client: Client): Promise<SelfRoleList> {
    await requireLevel(client, Level.Member);
    return act(() => selfRoleList(client.userId));
  }

  async setSelfRole(request: SetSelfRoleRequest, client: Client): Promise<SelfRoleList> {
    await requireLevel(client, Level.Member);
    const role = await act(() => roles.roleById(request.roleId));
    if (!role || !settings().selfRoles.includes(role.id)) invalid("That role isn't self-assignable.");
    // Staff roles never go through self-service here, in either direction.
    if (isPrivileged(role)) invalid("That role has staff permissions, so it can't be self-assigned.");
    const problem = await act(() => roles.setSelfRole(client.userId, role, request.has));
    if (problem) invalid(problem.replace(/\*\*/g, ""));
    return act(() => selfRoleList(client.userId));
  }

  async listMyReminders(client: Client): Promise<ReminderList> {
    await requireLevel(client, Level.Member);
    return act(() => reminderList(client.userId));
  }

  async cancelReminder(request: IdRequest, client: Client): Promise<ReminderList> {
    await requireLevel(client, Level.Member);
    // Scoped to the caller: someone else's reminder looks the same as a missing one.
    if (!(await act(() => reminders.cancelReminder(request.id, client.userId)))) notFound("You don't have a reminder with that number.");
    return act(() => reminderList(client.userId));
  }
}

export const contentService = new ContentService();

onChange((area) => {
  if (CONTENT_AREAS.has(area)) contentService.broadcastContentChanged({ area }, "all");
  // The self-role list lives in the general settings (!selfrole, config GUI).
  if (area === "general") contentService.broadcastContentChanged({ area: "selfroles" }, "all");
});
