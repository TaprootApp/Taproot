// Config for the automodplus module: the extra auto-mod filters, per-rule
// actions, channel rules (auto delete, slowmode) and join protection (autoban,
// raid). Stored as one JSON value under "module:automodplus" (settings.ts).
// Pure: no SDK imports, so the tests can cover the defaults and validation.

/** Every auto-mod rule that can have its own action. "duplicates" shares "spam". */
export const RULE_KEYS = [
  "words",
  "links",
  "mentions",
  "spam",
  "caps",
  "invites",
  "scam",
  "zalgo",
  "emoji",
  "newlines",
  "repeated",
  "attachments",
  "newMemberLinks",
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

export const RULE_LABELS: Record<RuleKey, string> = {
  words: "Blocked words",
  links: "Links",
  mentions: "Mass mentions",
  spam: "Spam",
  caps: "Caps",
  invites: "Invite links",
  scam: "Scam links",
  zalgo: "Zalgo text",
  emoji: "Emoji spam",
  newlines: "Wall of text",
  repeated: "Repeated characters",
  attachments: "Attachment spam",
  newMemberLinks: "New member links",
};

export const RULE_ACTIONS = ["delete", "warn", "mute", "kick", "ban"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export interface RuleSettings {
  /**
   * What happens after the message is deleted. "delete" is the original
   * behaviour: a notice plus a strike toward the automatic escalation mute.
   */
  action: RuleAction;
  /** For "mute". */
  muteMinutes: number;
  /** Replaces the default notice. Placeholders: {user} {user.name} {rule} {channel}. */
  response: string;
  /** Also post a short report here (the mod log gets its case either way). */
  logChannel: string | null;
  exemptChannels: string[];
  exemptRoles: string[];
}

export interface FilterConfig {
  invites: { enabled: boolean; allowCodes: string[] };
  scam: { enabled: boolean; extraDomains: string[] };
  zalgo: { enabled: boolean };
  emoji: { enabled: boolean; max: number };
  newlines: { enabled: boolean; maxLines: number; maxChars: number };
  repeated: { enabled: boolean; max: number };
  attachments: { enabled: boolean; max: number };
  newMemberLinks: { enabled: boolean; minutes: number };
}

export const ALLOW_TYPES = ["any", "images", "attachments", "links", "text", "commands"] as const;
export type AllowType = (typeof ALLOW_TYPES)[number];

export interface AutoDeleteRule {
  channelId: string;
  /** Messages that aren't this type are deleted at once ("any" = no type rule). */
  allow: AllowType;
  /** Delete every message this many minutes after it's posted (0 = off). */
  deleteAfterMinutes: number;
  /** Staff messages skip the type rule (timed deletion still applies). */
  exemptStaff: boolean;
}

export interface SlowmodeRule {
  channelId: string;
  seconds: number;
}

export interface AutobanConfig {
  enabled: boolean;
  /** Nickname patterns; * is a wildcard. Case-insensitive, match anywhere. */
  namePatterns: string[];
  /** Accounts younger than this many days (0 = off). */
  minAccountDays: number;
  action: "kick" | "ban";
  reason: string;
}

export interface RaidConfig {
  enabled: boolean;
  /** More than `joins` joins within `seconds` starts raid mode. */
  joins: number;
  seconds: number;
  lockChannels: string[];
  throttle: { enabled: boolean; refillCount: number; windowMinutes: number };
  /** End raid mode automatically after this long (0 = only "raid off"). */
  autoEndMinutes: number;
}

export interface PlusConfig {
  filters: FilterConfig;
  rules: Record<RuleKey, RuleSettings>;
  autoDelete: AutoDeleteRule[];
  slowmode: SlowmodeRule[];
  autoban: AutobanConfig;
  raid: RaidConfig;
}

export function defaultRule(): RuleSettings {
  return { action: "delete", muteMinutes: 10, response: "", logChannel: null, exemptChannels: [], exemptRoles: [] };
}

export function defaultConfig(): PlusConfig {
  const rules = {} as Record<RuleKey, RuleSettings>;
  for (const key of RULE_KEYS) rules[key] = defaultRule();
  return {
    filters: {
      invites: { enabled: false, allowCodes: [] },
      scam: { enabled: false, extraDomains: [] },
      zalgo: { enabled: false },
      emoji: { enabled: false, max: 10 },
      newlines: { enabled: false, maxLines: 15, maxChars: 2000 },
      repeated: { enabled: false, max: 15 },
      attachments: { enabled: false, max: 5 },
      newMemberLinks: { enabled: false, minutes: 10 },
    },
    rules,
    autoDelete: [],
    slowmode: [],
    autoban: { enabled: false, namePatterns: [], minAccountDays: 0, action: "kick", reason: "Autoban" },
    raid: {
      enabled: false,
      joins: 10,
      seconds: 10,
      lockChannels: [],
      throttle: { enabled: true, refillCount: 1, windowMinutes: 5 },
      autoEndMinutes: 30,
    },
  };
}

// --- Limits (shared by the commands and the GUI service) ---------------------

export const LIMITS = {
  muteMinutes: [1, 40_320],
  response: 500,
  exemptions: 50,
  emoji: [1, 200],
  lines: [2, 200],
  chars: [100, 9500],
  repeated: [3, 500],
  attachments: [1, 50],
  newMemberMinutes: [1, 10_080],
  deleteAfterMinutes: [0, 10_080],
  slowmodeSeconds: [1, 21_600],
  channelRules: 50,
  purges: 25,
  purgeEveryHours: [1, 720],
  accountDays: [0, 3650],
  namePatterns: 100,
  reason: 256,
  raidJoins: [2, 500],
  raidSeconds: [5, 3600],
  throttleCount: [1, 1000],
  throttleWindow: [1, 1440],
  autoEndMinutes: [0, 10_080],
  lockChannels: 50,
  inviteCodes: 50,
  scamDomains: 200,
} as const;

/** A whole number within [min, max], or an error message. */
export function checkInt(value: unknown, [min, max]: readonly [number, number], name: string): string | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return `${name} must be a whole number from ${min} to ${max}.`;
  }
  return undefined;
}

/** Nickname patterns: lowercased, trimmed, deduplicated; `*` alone isn't allowed. */
export function cleanPatterns(input: string[]): string[] | string {
  const out: string[] = [];
  for (const raw of input) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (/^\*+$/.test(p)) return "A pattern needs at least one character besides *.";
    if (p.length > 64) return "Patterns can be at most 64 characters.";
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Normalizes one rule's settings, returning an error message if something is out of range. */
export function checkRule(rule: RuleSettings, label: string): string | undefined {
  if (!(RULE_ACTIONS as readonly string[]).includes(rule.action)) return `${label}: unknown action.`;
  if (rule.action === "mute") {
    const err = checkInt(rule.muteMinutes, LIMITS.muteMinutes, `${label}: mute minutes`);
    if (err) return err;
  }
  if (rule.response.length > LIMITS.response) return `${label}: the response can be at most ${LIMITS.response} characters.`;
  if (rule.exemptChannels.length > LIMITS.exemptions || rule.exemptRoles.length > LIMITS.exemptions) {
    return `${label}: at most ${LIMITS.exemptions} exempt channels and roles.`;
  }
  return undefined;
}

/** The rule whose settings apply to a violation ("duplicates" is part of spam). */
export function ruleKeyOf(violationRule: string): RuleKey {
  if (violationRule === "duplicates") return "spam";
  return (RULE_KEYS as readonly string[]).includes(violationRule) ? (violationRule as RuleKey) : "spam";
}

/** Whether a rule is switched off for this channel or any of the member's roles. */
export function ruleExempt(rule: RuleSettings, channelId: string, roleIds: readonly string[]): boolean {
  return rule.exemptChannels.includes(channelId) || rule.exemptRoles.some((r) => roleIds.includes(r));
}

/** Command-line names for the rules (automod <rule> on|off, automod action <rule> ...). */
export const RULE_CLI: Record<string, RuleKey> = {
  words: "words",
  links: "links",
  mentions: "mentions",
  spam: "spam",
  caps: "caps",
  invites: "invites",
  scam: "scam",
  zalgo: "zalgo",
  emoji: "emoji",
  wall: "newlines",
  repeated: "repeated",
  attachments: "attachments",
  newlinks: "newMemberLinks",
};

export const CLI_OF: Record<RuleKey, string> = Object.fromEntries(
  Object.entries(RULE_CLI).map(([cli, key]) => [key, cli]),
) as Record<RuleKey, string>;

/** The extra filters' on/off switches, by rule. */
export const EXTRA_RULES = ["invites", "scam", "zalgo", "emoji", "newlines", "repeated", "attachments", "newMemberLinks"] as const;
export type ExtraRule = (typeof EXTRA_RULES)[number];

export function describeAction(rule: RuleSettings): string {
  switch (rule.action) {
    case "delete":
      return "delete";
    case "warn":
      return "delete + warn";
    case "mute":
      return `delete + mute ${rule.muteMinutes} min`;
    case "kick":
      return "delete + kick";
    case "ban":
      return "delete + ban";
  }
}

/** The rule a command names ("wall" -> newlines), or undefined. */
export function ruleFromCli(word: string | undefined): RuleKey | undefined {
  return word && Object.prototype.hasOwnProperty.call(RULE_CLI, word) ? RULE_CLI[word] : undefined;
}
