import {
  rootServer,
  CommunityEvent,
  CommunityRole,
  CommunityRoleEvent,
  CommunityRoleGuid,
  ReadOnlyMemberGroup,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { read } from "./lib/api";
import { log, errMessage } from "./lib/log";

// Who counts as staff. Root has no "effective permissions of member X" API, so
// a member's level comes from three sources, highest wins:
//   - the community owner is always the top level;
//   - the "Admins" / "Moderators" pickers in Taproot's settings page;
//   - community roles whose permissions imply the level (Full Control or
//     Manage Community -> admin; Kick or Ban -> moderator).
// The role fallback means Taproot works for staff before anyone opens settings.

export enum Level {
  Member = 0,
  Moderator = 1,
  Admin = 2,
  Owner = 3,
}

let ownerUserId: UserGuid | undefined;
let rolesCache: { at: number; roles: Map<CommunityRoleGuid, CommunityRole> } | undefined;
const memberRolesCache = new Map<UserGuid, { at: number; roleIds: CommunityRoleGuid[] }>();
const ROLES_TTL = 5 * 60_000;
const MEMBER_TTL = 30_000;

export async function initPermissions(): Promise<void> {
  const community = await read("communities.get", () => rootServer.community.communities.get());
  ownerUserId = community.ownerUserId;
  rootServer.community.communities.on(CommunityEvent.CommunityEdited, (evt) => {
    ownerUserId = evt.ownerUserId;
  });
  const invalidate = () => (rolesCache = undefined);
  rootServer.community.communityRoles.on(CommunityRoleEvent.CommunityRoleCreated, invalidate);
  rootServer.community.communityRoles.on(CommunityRoleEvent.CommunityRoleEdited, invalidate);
  rootServer.community.communityRoles.on(CommunityRoleEvent.CommunityRoleDeleted, invalidate);
}

export function isOwner(userId: string): boolean {
  return userId === ownerUserId;
}

async function communityRoles(): Promise<Map<CommunityRoleGuid, CommunityRole>> {
  if (rolesCache && Date.now() - rolesCache.at < ROLES_TTL) return rolesCache.roles;
  const list = await read("communityRoles.list", () => rootServer.community.communityRoles.list());
  rolesCache = { at: Date.now(), roles: new Map(list.map((r) => [r.id, r])) };
  return rolesCache.roles;
}

export async function listRoles(): Promise<CommunityRole[]> {
  return [...(await communityRoles()).values()];
}

export async function memberRoleIds(userId: UserGuid): Promise<CommunityRoleGuid[]> {
  const cached = memberRolesCache.get(userId);
  if (cached && Date.now() - cached.at < MEMBER_TTL) return cached.roleIds;
  const member = await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId }));
  memberRolesCache.set(userId, { at: Date.now(), roleIds: member.communityRoleIds });
  return member.communityRoleIds;
}

export function forgetMember(userId: UserGuid): void {
  memberRolesCache.delete(userId);
}

function picker(key: "admins" | "moderators" | "exempt"): ReadOnlyMemberGroup | undefined {
  return rootServer.globalSettings?.general?.[key] as ReadOnlyMemberGroup | undefined;
}

async function inPicker(key: "admins" | "moderators" | "exempt", userId: UserGuid): Promise<boolean> {
  const group = picker(key);
  if (!group) return false;
  try {
    return await group.isMember({ userId });
  } catch (err) {
    log("warn", `isMember(${key}) failed`, { error: errMessage(err) });
    return false;
  }
}

export async function levelOf(userId: UserGuid): Promise<Level> {
  if (isOwner(userId)) return Level.Owner;
  if (await inPicker("admins", userId)) return Level.Admin;

  let level = (await inPicker("moderators", userId)) ? Level.Moderator : Level.Member;
  try {
    const roles = await communityRoles();
    for (const roleId of await memberRoleIds(userId)) {
      const p = roles.get(roleId)?.communityPermission;
      if (!p) continue;
      if (p.communityFullControl || p.communityManageCommunity) return Level.Admin;
      if (p.communityKick || p.communityCreateBan || p.communityManageBans) level = Level.Moderator;
    }
  } catch (err) {
    // Fail closed: a lookup failure never grants staff powers.
    log("warn", "role lookup failed during permission check", { error: errMessage(err) });
  }
  return level;
}

/** Staff and members in the "Exempt from auto-mod" picker skip auto-mod. */
export async function isAutomodExempt(userId: UserGuid): Promise<boolean> {
  if (await inPicker("exempt", userId)) return true;
  return (await levelOf(userId)) >= Level.Moderator;
}

/**
 * Whether `actor` may take moderation action against `target`. Staff can only
 * act on members ranked below them; the owner can act on anyone but themself.
 */
export async function canActOn(actor: UserGuid, target: UserGuid): Promise<string | undefined> {
  if (actor === target) return "You can't do that to yourself.";
  if (isOwner(target)) return "The community owner can't be moderated.";
  if (RootGuidUtils.toRootGuidType(target) === RootGuidType.App) return "Bots and apps can't be moderated.";
  const [a, t] = await Promise.all([levelOf(actor), levelOf(target)]);
  if (a !== Level.Owner && t >= a) return "That member is staff at or above your level.";
  return undefined;
}

/** Roles that carry staff powers are never handed out by self-service. */
export function isPrivileged(role: CommunityRole): boolean {
  const p = role.communityPermission;
  return Boolean(
    p &&
      (p.communityFullControl ||
        p.communityManageCommunity ||
        p.communityManageRoles ||
        p.communityKick ||
        p.communityCreateBan ||
        p.communityManageBans ||
        p.communityManageApps),
  );
}
