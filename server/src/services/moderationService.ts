import {
  rootServer,
  Client,
  CommunityMember,
  ErrorCodeType,
  RootGuidType,
  RootGuidUtils,
  RootServerException,
  UserGuid,
} from "@rootsdk/server-app";
import { ModerationServiceBase } from "@taproot/gen-server";
import {
  ActionResult,
  BanList,
  CaseAction as ProtoCaseAction,
  CaseList,
  IdRequest,
  ListCasesRequest,
  MemberDetail,
  MemberList,
  MemberRef,
  MemberSearchRequest,
  ModActionRequest,
  ModCase as ProtoModCase,
  ModStats,
  MuteList,
  RoleInfo,
  StaffLevel,
  TaprootError,
  UpdateReasonRequest,
  UserRequest,
  WarnAction as ProtoWarnAction,
  WarnActionList,
  WarnCountRequest,
} from "@taproot/gen-shared";
import { get } from "../db";
import {
  ActionOutcome,
  ActionRefused,
  banMember,
  deleteWarnAction,
  kickMember,
  listBans as cachedBans,
  listWarnActions,
  MAX_BAN_REASON,
  muteAction,
  setWarnAction,
  unbanMember,
  unmuteAction,
  warnMember,
} from "../features/modActions";
import { activeMute, activeMutes } from "../features/mute";
import { errorCode, read } from "../lib/api";
import { log, errMessage } from "../lib/log";
import { formatDuration } from "../lib/time";
import { lastKnownNickname, nicknameOf } from "../members";
import { activeWarnings, casesFor, CaseAction, getCase, queryCases, updateReason, voidWarning } from "../modlog";
import { isPrivileged, Level, levelOf, listRoles } from "../permissions";
import { act, invalid, notFound, requireLevel } from "./auth";
import { onChange } from "./changes";
import { caseActionFromWire, punishmentFromWire, toWireCase, toWireWarnAction } from "./wire";

// Cases, member lookups and the moderation actions for the GUI. The actions
// go through features/modActions.ts, the same code the text commands use.

const DAY = 86_400_000;
const MAX_DURATION = 5 * 365 * DAY;

// --- Mapping (see wire.ts) -------------------------------------------------

async function warnActionList(): Promise<WarnActionList> {
  return { actions: (await listWarnActions()).map(toWireWarnAction) };
}

// --- Input helpers -----------------------------------------------------------

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

/** 0 means none; anything else must be a sane positive length. */
function durationOf(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DURATION) invalid("That duration isn't valid.");
  const rounded = Math.round(ms);
  return rounded > 0 ? rounded : undefined;
}

/** Runs a shared action: rank refusals and Root failures become TaprootErrors. */
async function perform<T>(op: () => Promise<T>): Promise<T> {
  return act(async () => {
    try {
      return await op();
    } catch (err) {
      if (err instanceof ActionRefused) throw new RootServerException(TaprootError.NOT_AUTHORIZED, err.message);
      throw err;
    }
  });
}

function result(outcome: ActionOutcome, headline: string): ActionResult {
  return { caseId: outcome.modCase.id, message: [headline, ...outcome.notes].join("\n") };
}

/** Where a name is only for display, avoid an API call per row. */
async function displayName(userId: string): Promise<string> {
  return (await lastKnownNickname(userId)) ?? nicknameOf(userId as UserGuid);
}

// --- Member search -----------------------------------------------------------

const MEMBERS_TTL = 30_000;
const SEARCH_LIMIT = 25;
let membersCache: { at: number; members: Promise<CommunityMember[]> } | undefined;

function allMembers(): Promise<CommunityMember[]> {
  if (membersCache && Date.now() - membersCache.at < MEMBERS_TTL) return membersCache.members;
  const members = read("communityMembers.listAll", () => rootServer.community.communityMembers.listAll());
  membersCache = { at: Date.now(), members };
  // Don't cache a failure.
  members.catch(() => {
    if (membersCache?.members === members) membersCache = undefined;
  });
  return members;
}

function isPersonId(text: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(text) === RootGuidType.Person;
  } catch {
    return false;
  }
}

// --- Broadcasts --------------------------------------------------------------

// Staff levels come from pickers, role permissions and ownership, which no
// single member group captures, so the audience is the attached clients whose
// level is moderator or above. Bursts (a mute makes a case, then updates the
// mute row) are coalesced into one broadcast.
// One second keeps a raid (auto-mod making a case per message) from turning
// into a flood of refetches from every open staff client.
const BROADCAST_DELAY = 1000;
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;

async function staffClients(): Promise<Client[]> {
  const clients = rootServer.clients.getClients();
  const levels = await Promise.all(clients.map((c) => levelOf(c.userId).catch(() => Level.Member)));
  return clients.filter((_, i) => levels[i] >= Level.Moderator);
}

class ModerationService extends ModerationServiceBase {
  constructor() {
    super();
    onChange((area) => {
      // Warn thresholds change rarely and only from an admin, so no coalescing.
      if (area === "punishments") {
        this.sendChanged("punishments").catch((err) => log("warn", "punishments broadcast failed", { error: errMessage(err) }));
        return;
      }
      if (area !== "cases" || broadcastTimer) return;
      broadcastTimer = setTimeout(() => {
        broadcastTimer = undefined;
        this.sendChanged("cases").catch((err) => log("warn", "cases broadcast failed", { error: errMessage(err) }));
      }, BROADCAST_DELAY);
    });
  }

  // CasesChanged carries "cases" or "punishments" (warn thresholds).
  private async sendChanged(area: "cases" | "punishments"): Promise<void> {
    const audience = await staffClients();
    if (audience.length === 0) return;
    this.broadcastCasesChanged({ area }, audience);
  }

  // --- Reads -----------------------------------------------------------------

  async getStats(client: Client): Promise<ModStats> {
    await requireLevel(client, Level.Moderator);
    const now = Date.now();
    const count = async (sql: string, params: unknown[]) => (await get<{ n: number }>(sql, params))?.n ?? 0;
    const [day, week, automod, mutes] = await Promise.all([
      count("SELECT COUNT(*) AS n FROM mod_cases WHERE created_at >= ?", [now - DAY]),
      count("SELECT COUNT(*) AS n FROM mod_cases WHERE created_at >= ?", [now - 7 * DAY]),
      count("SELECT COUNT(*) AS n FROM mod_cases WHERE action = 'automod' AND created_at >= ?", [now - DAY]),
      count("SELECT COUNT(*) AS n FROM mutes WHERE active = 1", []),
    ]);
    let bans = 0;
    try {
      bans = (await cachedBans()).length;
    } catch (err) {
      // The rest of the dashboard is still useful without the ban count.
      log("warn", "ban count failed", { error: errMessage(err) });
    }
    return { casesLast24H: day, casesLast7D: week, activeMutes: mutes, activeBans: bans, automodLast24H: automod };
  }

  async listCases(request: ListCasesRequest, client: Client): Promise<CaseList> {
    await requireLevel(client, Level.Moderator);
    const limit = request.limit > 0 ? Math.min(request.limit, 100) : 25;
    let action: CaseAction | undefined;
    if (request.action !== ProtoCaseAction.UNSPECIFIED) {
      action = caseActionFromWire(request.action);
      if (!action) invalid("Unknown case type.");
    }
    const rows = await queryCases({
      userId: request.userId?.trim() || undefined,
      action,
      beforeId: request.beforeId > 0 ? request.beforeId : undefined,
      limit: limit + 1,
    });
    return { cases: rows.slice(0, limit).map(toWireCase), hasMore: rows.length > limit };
  }

  async searchMembers(request: MemberSearchRequest, client: Client): Promise<MemberList> {
    await requireLevel(client, Level.Moderator);
    const query = request.query.trim();
    if (!query) return { members: [] };
    const members = await act(() => allMembers());

    if (isPersonId(query)) {
      const found = members.find((m) => m.userId === query);
      if (found) return { members: [{ userId: found.userId, nickname: found.nickname }] };
      // Not in the community (left or banned): still searchable by ID for unban.
      const known = await lastKnownNickname(query);
      return { members: [{ userId: query, nickname: known ?? "Unknown member" }] };
    }

    const needle = query.toLowerCase();
    const out: MemberRef[] = [];
    for (const m of members) {
      if (!m.nickname.toLowerCase().includes(needle)) continue;
      out.push({ userId: m.userId, nickname: m.nickname });
      if (out.length >= SEARCH_LIMIT) break;
    }
    return { members: out };
  }

  async getMember(request: UserRequest, client: Client): Promise<MemberDetail> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);

    let member: CommunityMember | undefined;
    try {
      member = await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId }));
    } catch {
      member = undefined;
    }

    let roles: RoleInfo[] = [];
    if (member) {
      const byId = new Map((await act(() => listRoles())).map((r) => [r.id, r]));
      roles = member.communityRoleIds.flatMap((id) => {
        const r = byId.get(id);
        return r ? [{ id: r.id, name: r.name, colorHex: r.colorHex ?? "", privileged: isPrivileged(r) }] : [];
      });
    }

    const [level, warnings, mute, banned, cases, nickname] = await Promise.all([
      levelOf(userId),
      activeWarnings(userId),
      activeMute(userId),
      isBanned(userId),
      casesFor(userId, 20),
      member ? Promise.resolve(member.nickname) : lastKnownNickname(userId).then((n) => n ?? "Unknown member"),
    ]);

    return {
      userId,
      nickname,
      joinedAtMs: member?.joinedAt ? new Date(member.joinedAt).getTime() : 0,
      roles,
      level: level as number as StaffLevel,
      activeWarnings: warnings.length,
      muted: Boolean(mute),
      muteExpiresAtMs: mute?.expires_at ?? 0,
      banned,
      recentCases: cases.map(toWireCase),
      inCommunity: Boolean(member),
    };
  }

  async listActiveMutes(client: Client): Promise<MuteList> {
    await requireLevel(client, Level.Moderator);
    const mutes = await activeMutes();
    return {
      mutes: await Promise.all(
        mutes.map(async (m) => ({
          userId: m.user_id,
          nickname: await displayName(m.user_id),
          expiresAtMs: m.expires_at ?? 0,
          caseId: m.case_id ?? 0,
        })),
      ),
    };
  }

  async listBans(client: Client): Promise<BanList> {
    await requireLevel(client, Level.Moderator);
    const bans = await act(cachedBans);
    return {
      bans: await Promise.all(
        bans.map(async (b) => ({
          userId: b.userId,
          // Banned users aren't members, so asking Root for their name would
          // just fail, once per row on every refresh.
          nickname: (await lastKnownNickname(b.userId)) ?? "Unknown member",
          reason: b.reason ?? "",
          expiresAtMs: b.expiresAt ? new Date(b.expiresAt).getTime() : 0,
        })),
      ),
    };
  }

  // --- Actions ---------------------------------------------------------------

  async warn(request: ModActionRequest, client: Client): Promise<ActionResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const reason = request.reason.trim();
    if (!reason) invalid("Give a reason for the warning.");
    const outcome = await perform(() => warnMember({ actorId: client.userId, userId, reason }));
    return result(outcome, `Warned ${outcome.name} (case #${outcome.modCase.id}, warning ${outcome.count}).`);
  }

  async mute(request: ModActionRequest, client: Client): Promise<ActionResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const durationMs = durationOf(request.durationMs);
    const reason = request.reason.trim();
    const outcome = await perform(() => muteAction({ actorId: client.userId, userId, durationMs, reason }));
    const length = durationMs ? ` for ${formatDuration(durationMs)}` : "";
    const headline = outcome.extended
      ? `Updated ${outcome.name}'s mute${length} (case #${outcome.modCase.id}).`
      : `Muted ${outcome.name}${length} (case #${outcome.modCase.id}).`;
    return result(outcome, headline);
  }

  async unmute(request: ModActionRequest, client: Client): Promise<ActionResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const outcome = await perform(() => unmuteAction({ actorId: client.userId, userId, reason: request.reason.trim() }));
    if (!outcome) invalid("That member isn't muted.");
    return result(outcome, `Unmuted ${outcome.name} (case #${outcome.modCase.id}).`);
  }

  async kick(request: ModActionRequest, client: Client): Promise<ActionResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const outcome = await perform(() => kickMember({ actorId: client.userId, userId, reason: request.reason.trim() }));
    return result(outcome, `Kicked ${outcome.name} (case #${outcome.modCase.id}).`);
  }

  async ban(request: ModActionRequest, client: Client): Promise<ActionResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const durationMs = durationOf(request.durationMs);
    const reason = request.reason.trim();
    if (reason.length > MAX_BAN_REASON) invalid(`Ban reasons can be at most ${MAX_BAN_REASON} characters.`);
    const outcome = await perform(() => banMember({ actorId: client.userId, userId, durationMs, reason }));
    const length = durationMs ? ` for ${formatDuration(durationMs)}` : "";
    return result(outcome, `Banned ${outcome.name}${length} (case #${outcome.modCase.id}).`);
  }

  async unban(request: ModActionRequest, client: Client): Promise<ActionResult> {
    await requireLevel(client, Level.Moderator);
    const userId = userIdOf(request.userId);
    const outcome = await perform(() => unbanMember({ actorId: client.userId, userId, reason: request.reason.trim() }));
    return result(outcome, `Unbanned ${outcome.name} (case #${outcome.modCase.id}).`);
  }

  // --- Cases -----------------------------------------------------------------

  async voidWarning(request: IdRequest, client: Client): Promise<ProtoModCase> {
    await requireLevel(client, Level.Moderator);
    const voided = await voidWarning(request.id);
    if (voided) return toWireCase(voided);
    if (await getCase(request.id)) invalid("That case isn't a warning.");
    notFound("No case with that number.");
  }

  async updateCaseReason(request: UpdateReasonRequest, client: Client): Promise<ProtoModCase> {
    await requireLevel(client, Level.Moderator);
    const reason = request.reason.trim();
    if (!reason) invalid("Give the new reason.");
    if (!(await updateReason(request.caseId, reason))) notFound("No case with that number.");
    return toWireCase((await getCase(request.caseId))!);
  }

  // --- Warn thresholds (admin) -------------------------------------------------

  async listWarnActions(client: Client): Promise<WarnActionList> {
    await requireLevel(client, Level.Admin);
    return warnActionList();
  }

  async setWarnAction(request: ProtoWarnAction, client: Client): Promise<WarnActionList> {
    await requireLevel(client, Level.Admin);
    if (!Number.isInteger(request.warnCount) || request.warnCount < 1 || request.warnCount > 100) {
      invalid("Warning count must be a whole number from 1 to 100.");
    }
    const action = punishmentFromWire(request.action);
    if (!action) invalid("Pick mute, kick or ban.");
    await setWarnAction(request.warnCount, action, durationOf(request.durationMs));
    return warnActionList();
  }

  async deleteWarnAction(request: WarnCountRequest, client: Client): Promise<WarnActionList> {
    await requireLevel(client, Level.Admin);
    await deleteWarnAction(request.warnCount);
    return warnActionList();
  }
}

/** Root answers NotFound when the member has no ban. */
async function isBanned(userId: UserGuid): Promise<boolean> {
  try {
    await read("communityMemberBans.get", () => rootServer.community.communityMemberBans.get({ userId }));
    return true;
  } catch (err) {
    if (errorCode(err) === ErrorCodeType.NotFound) return false;
    log("warn", "ban lookup failed", { error: errMessage(err) });
    return false;
  }
}

export const moderationService = new ModerationService();
