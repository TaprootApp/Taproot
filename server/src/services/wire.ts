import {
  CaseAction as ProtoCaseAction,
  Config,
  ModCase as ProtoModCase,
  PunishmentType,
  Repeat as ProtoRepeat,
  WarnAction as ProtoWarnAction,
} from "@taproot/gen-shared";
import type { WarnAction } from "../features/modActions";
import type { Repeat } from "../features/reminders";
import type { CaseAction, ModCase } from "../modlog";
import type { Settings } from "../settings";

// Conversions between the database/settings shapes and the proto messages.
// Pure (type-only imports of feature code), so the tests can cover them
// without a Root connection.

// --- Cases -------------------------------------------------------------------

export const CASE_ACTION_TO_WIRE: Record<CaseAction, ProtoCaseAction> = {
  warn: ProtoCaseAction.WARN,
  mute: ProtoCaseAction.MUTE,
  unmute: ProtoCaseAction.UNMUTE,
  kick: ProtoCaseAction.KICK,
  ban: ProtoCaseAction.BAN,
  unban: ProtoCaseAction.UNBAN,
  purge: ProtoCaseAction.PURGE,
  lock: ProtoCaseAction.LOCK,
  unlock: ProtoCaseAction.UNLOCK,
  automod: ProtoCaseAction.AUTOMOD,
};

const CASE_ACTION_FROM_WIRE = new Map<ProtoCaseAction, CaseAction>(
  Object.entries(CASE_ACTION_TO_WIRE).map(([k, v]) => [v, k as CaseAction]),
);

/** Undefined for UNSPECIFIED (meaning "all actions") or an unknown value. */
export function caseActionFromWire(action: ProtoCaseAction): CaseAction | undefined {
  return CASE_ACTION_FROM_WIRE.get(action);
}

export function toWireCase(c: ModCase): ProtoModCase {
  return {
    id: c.id,
    action: CASE_ACTION_TO_WIRE[c.action] ?? ProtoCaseAction.UNSPECIFIED,
    userId: c.user_id,
    userName: c.user_name,
    moderatorId: c.moderator_id,
    moderatorName: c.moderator_name,
    reason: c.reason,
    durationMs: c.duration_ms ?? 0,
    voided: Boolean(c.voided),
    createdAtMs: c.created_at,
  };
}

// --- Warn thresholds ---------------------------------------------------------

const PUNISHMENT_TO_WIRE: Record<WarnAction["action"], PunishmentType> = {
  mute: PunishmentType.MUTE,
  kick: PunishmentType.KICK,
  ban: PunishmentType.BAN,
};

/** Undefined for UNSPECIFIED or an unknown value. */
export function punishmentFromWire(type: PunishmentType): WarnAction["action"] | undefined {
  return (Object.keys(PUNISHMENT_TO_WIRE) as WarnAction["action"][]).find((k) => PUNISHMENT_TO_WIRE[k] === type);
}

export function toWireWarnAction(w: WarnAction): ProtoWarnAction {
  return { warnCount: w.warn_count, action: PUNISHMENT_TO_WIRE[w.action], durationMs: w.duration_ms ?? 0 };
}

// --- Announcements -----------------------------------------------------------

export const REPEAT_TO_WIRE: Record<Repeat, ProtoRepeat> = {
  once: ProtoRepeat.ONCE,
  daily: ProtoRepeat.DAILY,
  weekly: ProtoRepeat.WEEKLY,
  monthly: ProtoRepeat.MONTHLY,
};

const REPEAT_FROM_WIRE = new Map<ProtoRepeat, Repeat>(Object.entries(REPEAT_TO_WIRE).map(([k, v]) => [v, k as Repeat]));

export function repeatFromWire(repeat: ProtoRepeat): Repeat | undefined {
  return REPEAT_FROM_WIRE.get(repeat);
}

// --- Settings ----------------------------------------------------------------

export function toWireConfig(s: Readonly<Settings>): Config {
  const a = s.automod;
  return {
    general: {
      prefix: s.prefix,
      modLogChannelId: s.modLogChannel ?? undefined,
      selfRoleIds: [...s.selfRoles],
    },
    welcome: {
      welcomeChannelId: s.welcomeChannel ?? undefined,
      welcomeMessage: s.welcomeMessage,
      goodbyeChannelId: s.goodbyeChannel ?? undefined,
      goodbyeMessage: s.goodbyeMessage,
      autoroleIds: [...s.autoroles],
    },
    automod: {
      enabled: a.enabled,
      wordsEnabled: a.words.enabled,
      words: [...a.words.list],
      linksEnabled: a.links.enabled,
      allowedDomains: [...a.links.allow],
      mentionsEnabled: a.mentions.enabled,
      maxMentions: a.mentions.max,
      blockAllMentions: a.mentions.blockAll,
      spamEnabled: a.spam.enabled,
      spamMessages: a.spam.messages,
      spamSeconds: a.spam.seconds,
      spamDuplicates: a.spam.duplicates,
      capsEnabled: a.caps.enabled,
      capsPercent: a.caps.percent,
      capsMinLength: a.caps.minLength,
      strikeCount: a.strikes.count,
      strikeWindowMinutes: a.strikes.windowMinutes,
      strikeMuteMinutes: a.strikes.muteMinutes,
      ignoredChannelIds: [...a.ignoredChannels],
    },
  };
}
