import { CaseAction, PunishmentType, Repeat, StaffLevel } from "@taproot/gen-shared";
import type { BadgeTone } from "../components/Badge";

// Display names for the contract's enums, shared so every screen words
// things the same way.

export const STAFF_LEVEL_LABEL: Record<StaffLevel, string> = {
  [StaffLevel.MEMBER]: "Member",
  [StaffLevel.MODERATOR]: "Moderator",
  [StaffLevel.ADMIN]: "Admin",
  [StaffLevel.OWNER]: "Owner",
};

export const CASE_ACTION_LABEL: Record<CaseAction, string> = {
  [CaseAction.UNSPECIFIED]: "Unknown",
  [CaseAction.WARN]: "Warn",
  [CaseAction.MUTE]: "Mute",
  [CaseAction.UNMUTE]: "Unmute",
  [CaseAction.KICK]: "Kick",
  [CaseAction.BAN]: "Ban",
  [CaseAction.UNBAN]: "Unban",
  [CaseAction.PURGE]: "Purge",
  [CaseAction.LOCK]: "Lock",
  [CaseAction.UNLOCK]: "Unlock",
  [CaseAction.AUTOMOD]: "Auto-mod",
};

export const CASE_ACTION_TONE: Record<CaseAction, BadgeTone> = {
  [CaseAction.UNSPECIFIED]: "neutral",
  [CaseAction.WARN]: "warning",
  [CaseAction.MUTE]: "warning",
  [CaseAction.UNMUTE]: "success",
  [CaseAction.KICK]: "danger",
  [CaseAction.BAN]: "danger",
  [CaseAction.UNBAN]: "success",
  [CaseAction.PURGE]: "info",
  [CaseAction.LOCK]: "info",
  [CaseAction.UNLOCK]: "info",
  [CaseAction.AUTOMOD]: "brand",
};

export const PUNISHMENT_LABEL: Record<PunishmentType, string> = {
  [PunishmentType.UNSPECIFIED]: "None",
  [PunishmentType.MUTE]: "Mute",
  [PunishmentType.KICK]: "Kick",
  [PunishmentType.BAN]: "Ban",
};

export const REPEAT_LABEL: Record<Repeat, string> = {
  [Repeat.ONCE]: "Once",
  [Repeat.DAILY]: "Daily",
  [Repeat.WEEKLY]: "Weekly",
  [Repeat.MONTHLY]: "Monthly",
};
