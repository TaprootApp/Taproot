import {
  rootServer,
  AccessRule,
  ChannelOrChannelGroupGuid,
  ChannelOverlayPermission,
  ErrorCodeType,
  RoleOrMemberGuid,
} from "@rootsdk/server-app";
import { errorCode, read, write } from "./api";

// Mutes and channel locks are access-rule overlays. A target may already have
// a rule for the same subject (say, a moderator granted someone a special
// permission). edit() replaces the whole overlay, so the original is merged
// with our change and saved, and restore() puts it back exactly: edited back
// if there was one, deleted if there wasn't.

/** Mute: no posting, reacting, attaching, or talking in voice. */
export const MUTE_PATCH: ChannelOverlayPermission = {
  channelCreateMessage: false,
  channelCreateMessageReaction: false,
  channelCreateMessageAttachment: false,
  channelVoiceTalk: false,
};

/** Lock: nobody but staff with explicit access can post. */
export const LOCK_PATCH: ChannelOverlayPermission = {
  channelCreateMessage: false,
  channelCreateMessageReaction: false,
};

export async function existingRulesForSubject(subjectId: string): Promise<Map<string, AccessRule>> {
  const rules = await read("accessRules.listByRoleOrMember", () =>
    rootServer.community.accessRules.listByRoleOrMember({ roleOrMemberId: subjectId as RoleOrMemberGuid }),
  );
  return new Map(rules.map((r) => [r.channelOrChannelGroupId as string, r]));
}

export async function existingRule(targetId: string, subjectId: string): Promise<AccessRule | undefined> {
  const rules = await read("accessRules.listByChannelOrChannelGroup", () =>
    rootServer.community.accessRules.listByChannelOrChannelGroup({
      channelOrChannelGroupId: targetId as ChannelOrChannelGroupGuid,
    }),
  );
  return rules.find((r) => r.roleOrMemberId === subjectId);
}

/** Applies the patch. Returns the prior overlay (null if there was no rule). */
export async function applyPatch(
  targetId: string,
  subjectId: string,
  patch: ChannelOverlayPermission,
  existing: AccessRule | undefined,
): Promise<ChannelOverlayPermission | null> {
  const channelOrChannelGroupId = targetId as ChannelOrChannelGroupGuid;
  const roleOrMemberId = subjectId as RoleOrMemberGuid;
  if (existing) {
    await write("accessRules.edit", () =>
      rootServer.community.accessRules.edit({
        channelOrChannelGroupId,
        roleOrMemberId,
        overlay: { ...existing.overlay, ...patch },
      }),
    );
    return existing.overlay;
  }
  await write("accessRules.create", () =>
    rootServer.community.accessRules.create({ channelOrChannelGroupId, roleOrMemberId, overlay: patch }),
  );
  return null;
}

export async function restorePatch(
  targetId: string,
  subjectId: string,
  original: ChannelOverlayPermission | null,
): Promise<void> {
  const channelOrChannelGroupId = targetId as ChannelOrChannelGroupGuid;
  const roleOrMemberId = subjectId as RoleOrMemberGuid;
  try {
    if (original) {
      await write("accessRules.edit", () =>
        rootServer.community.accessRules.edit({ channelOrChannelGroupId, roleOrMemberId, overlay: original }),
      );
    } else {
      await write("accessRules.delete", () =>
        rootServer.community.accessRules.delete({ channelOrChannelGroupId, roleOrMemberId }),
      );
    }
  } catch (err) {
    // Someone already removed the rule, or the channel is gone: nothing to undo.
    if (errorCode(err) !== ErrorCodeType.NotFound) throw err;
  }
}
