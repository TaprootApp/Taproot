import { rootServer, Client, CommunityRole, RootGuidType, RootGuidUtils, RootServerException, UserGuid } from "@rootsdk/server-app";
import { ModtoolsServiceBase } from "@taproot/gen-server";
import {
  ModtoolsAddNoteRequest,
  ModtoolsAddTempRoleRequest,
  ModtoolsConfig as WireConfig,
  ModtoolsDurationRequest,
  ModtoolsIdRequest,
  ModtoolsMemberInfo,
  ModtoolsNote,
  ModtoolsResult,
  ModtoolsTempRole,
  ModtoolsTempRoleList,
  ModtoolsUserRequest,
  ModtoolsVoiceAction,
  ModtoolsVoiceRequest,
  TaprootError,
} from "@taproot/gen-shared";
import { lastKnownNickname, nicknameOf } from "../../members";
import { log, errMessage } from "../../lib/log";
import { isPrivileged, Level, levelOf, listRoles } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import { changeDuration, DurationRefused } from "./durations";
import { MAX_NOTE, ModtoolsConfig, normalizeTimedAutoroles } from "./logic";
import { addNote, deleteNote, NoteRow, notesFor } from "./notes";
import { config, NAME, saveConfig } from "./store";
import { activeTempRoles, endTempRole, giveTempRole, TempRoleRefused, TempRoleRow } from "./tempRoles";
import { findVoiceChannel, isVoiceMuted, voiceKick, voiceMute, VoiceRefused, voiceUnmute } from "./voice";

// GUI for the mod tools module: the Members page's notes, temp roles and
// voice cards, the duration editor, and the admin "Mod tools" settings page.

function userIdOf(text: string): UserGuid {
  const id = text.trim();
  let type: RootGuidType | undefined;
  try {
    type = RootGuidUtils.toRootGuidType(id);
  } catch {
    type = undefined;
  }
  if (type !== RootGuidType.Person) invalid("That isn't a valid member ID.");
  return id as UserGuid;
}

/** Refusals become NOT_AUTHORIZED/INVALID_INPUT; Root failures ACTION_FAILED (see act). */
async function perform<T>(op: () => Promise<T>): Promise<T> {
  return act(async () => {
    try {
      return await op();
    } catch (err) {
      if (err instanceof TempRoleRefused || err instanceof VoiceRefused || err instanceof DurationRefused) {
        throw new RootServerException(TaprootError.INVALID_INPUT, err.message);
      }
      throw err;
    }
  });
}

function toWireNote(n: NoteRow): ModtoolsNote {
  return {
    id: n.id,
    userId: n.user_id,
    text: n.text,
    authorId: n.author_id,
    authorName: n.author_name,
    createdAtMs: n.created_at,
  };
}

async function toWireTempRole(r: TempRoleRow, roleNames: Map<string, string>): Promise<ModtoolsTempRole> {
  return {
    id: r.id,
    userId: r.user_id,
    userName: (await lastKnownNickname(r.user_id)) ?? (await nicknameOf(r.user_id as UserGuid)),
    roleId: r.role_id,
    roleName: roleNames.get(r.role_id) ?? r.role_name,
    expiresAtMs: r.expires_at,
    addedByName: r.added_by_name,
    createdAtMs: r.created_at,
  };
}

async function roleNames(): Promise<Map<string, string>> {
  try {
    return new Map((await listRoles()).map((r) => [r.id, r.name]));
  } catch {
    return new Map();
  }
}

function toWireConfig(c: ModtoolsConfig): WireConfig {
  return {
    timedAutoroles: c.timedAutoroles.map((r) => ({ roleId: r.roleId, delayMs: r.delayMs })),
    notifyWarn: c.notify.warn,
    notifyMute: c.notify.mute,
    notifyKick: c.notify.kick,
    notifyBan: c.notify.ban,
  };
}

// --- Broadcasts --------------------------------------------------------------

const BROADCAST_DELAY = 500;
const pendingAreas = new Set<string>();
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;

async function staffClients(): Promise<Client[]> {
  const clients = rootServer.clients.getClients();
  const levels = await Promise.all(clients.map((c) => levelOf(c.userId).catch(() => Level.Member)));
  return clients.filter((_, i) => levels[i] >= Level.Moderator);
}

class ModtoolsService extends ModtoolsServiceBase {
  constructor() {
    super();
    onChange((area) => {
      if (!area.startsWith(`${NAME}:`)) return;
      pendingAreas.add(area.slice(NAME.length + 1));
      if (broadcastTimer) return;
      broadcastTimer = setTimeout(() => {
        broadcastTimer = undefined;
        const areas = [...pendingAreas];
        pendingAreas.clear();
        this.send(areas).catch((err) => log("warn", "modtools broadcast failed", { error: errMessage(err) }));
      }, BROADCAST_DELAY);
    });
  }

  private async send(areas: string[]): Promise<void> {
    const audience = await staffClients();
    if (audience.length === 0) return;
    for (const area of areas) this.broadcastModtoolsChanged({ area }, audience);
  }

  // --- Member card -------------------------------------------------------------

  async getMember(request: ModtoolsUserRequest, client: Client): Promise<ModtoolsMemberInfo> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const [notes, temps, names, voiceMuted] = await Promise.all([
      notesFor(userId),
      activeTempRoles(userId),
      roleNames(),
      isVoiceMuted(userId),
    ]);
    let channel: { id: string; name: string } | undefined;
    try {
      channel = await findVoiceChannel(userId);
    } catch (err) {
      // The rest of the card is still useful without voice presence.
      log("warn", "voice lookup failed", { error: errMessage(err) });
    }
    return {
      notes: notes.map(toWireNote),
      tempRoles: await Promise.all(temps.map((t) => toWireTempRole(t, names))),
      voiceMuted,
      voiceChannelId: channel?.id ?? "",
      voiceChannelName: channel?.name ?? "",
    };
  }

  async addNote(request: ModtoolsAddNoteRequest, client: Client): Promise<ModtoolsNote> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const text = request.text.trim();
    if (!text) invalid("Write the note first.");
    if (text.length > MAX_NOTE) invalid(`Notes can be at most ${MAX_NOTE} characters.`);
    return toWireNote(await addNote(userId, client.userId, text));
  }

  async deleteNote(request: ModtoolsIdRequest, client: Client): Promise<void> {
    await requireLevel(client, Level.Moderator);
    if (!(await deleteNote(request.id))) notFound("That note was already deleted.");
  }

  // --- Temp roles ------------------------------------------------------------------

  async listTempRoles(client: Client): Promise<ModtoolsTempRoleList> {
    await requireLevel(client, Level.Moderator);
    const names = await roleNames();
    return { tempRoles: await Promise.all((await activeTempRoles()).map((t) => toWireTempRole(t, names))) };
  }

  async addTempRole(request: ModtoolsAddTempRoleRequest, client: Client): Promise<ModtoolsResult> {
    const level = await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const roleId = request.roleId.trim();
    if (!roleId) invalid("Pick a role.");
    const durationMs = Math.round(request.durationMs);
    const result = await perform(() => giveTempRole({ actorId: client.userId, actorLevel: level, userId, roleId, durationMs }));
    return {
      message: result.extended
        ? `${result.name} keeps ${result.row.role_name} until the new end time.`
        : `Gave ${result.name} ${result.row.role_name} (temp role #${result.row.id}).`,
    };
  }

  async removeTempRole(request: ModtoolsIdRequest, client: Client): Promise<ModtoolsResult> {
    await requireLevel(client, Level.Moderator);
    const row = await perform(() => endTempRole(request.id, client.userId));
    if (!row) notFound("That temp role already ended.");
    return { message: `Took ${row.role_name} back.` };
  }

  // --- Voice and durations ----------------------------------------------------------

  async voiceAction(request: ModtoolsVoiceRequest, client: Client): Promise<ModtoolsResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    switch (request.action) {
      case ModtoolsVoiceAction.MUTE:
        return { message: await perform(() => voiceMute(client.userId, userId)) };
      case ModtoolsVoiceAction.UNMUTE:
        return { message: await perform(() => voiceUnmute(client.userId, userId)) };
      case ModtoolsVoiceAction.KICK:
        return { message: await perform(() => voiceKick(client.userId, userId)) };
      default:
        invalid("Unknown voice action.");
    }
  }

  async changeDuration(request: ModtoolsDurationRequest, client: Client): Promise<ModtoolsResult> {
    await requireLevel(client, Level.Moderator);
    if (!Number.isInteger(request.caseId) || request.caseId < 1) invalid("That isn't a case number.");
    return { message: await perform(() => changeDuration(client.userId, request.caseId, Math.round(request.durationMs))) };
  }

  // --- Settings (admin) --------------------------------------------------------------

  async getConfig(client: Client): Promise<WireConfig> {
    await requireLevel(client, Level.Admin);
    return toWireConfig(config());
  }

  async updateConfig(request: WireConfig, client: Client): Promise<WireConfig> {
    await requireLevel(client, Level.Admin);
    const list = normalizeTimedAutoroles(request.timedAutoroles.map((r) => ({ roleId: r.roleId, delayMs: r.delayMs })));
    if (typeof list === "string") invalid(list);
    const roles = new Map<string, CommunityRole>((await act(() => listRoles())).map((r) => [r.id, r]));
    for (const entry of list) {
      const role = roles.get(entry.roleId);
      if (!role) invalid("One of the timed autoroles no longer exists.");
      if (isPrivileged(role)) invalid(`${role.name} has staff permissions, so it can't be given automatically.`);
    }
    const next: ModtoolsConfig = {
      timedAutoroles: list,
      notify: {
        warn: Boolean(request.notifyWarn),
        mute: Boolean(request.notifyMute),
        kick: Boolean(request.notifyKick),
        ban: Boolean(request.notifyBan),
      },
    };
    await saveConfig(next);
    return toWireConfig(next);
  }
}

export const modtoolsService = new ModtoolsService();
