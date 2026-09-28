import { Client } from "@rootsdk/server-app";
import { AutomodplusServiceBase } from "@taproot/gen-server";
import {
  AutomodplusAction,
  AutomodplusAllowType,
  AutomodplusAutomodConfig,
  AutomodplusChannelRules,
  AutomodplusChannelRulesUpdate,
  AutomodplusJoinAction,
  AutomodplusJoinProtection,
  AutomodplusJoinProtectionUpdate,
  AutomodplusPurgeId,
  AutomodplusPurgeMode,
  AutomodplusPurgeSave,
  AutomodplusRaidModeRequest,
} from "@taproot/gen-shared";
import { get } from "../../db";
import { log, errMessage } from "../../lib/log";
import { normalizeDomain } from "../../lib/validate";
import { Level, listRoles } from "../../permissions";
import { act, invalid, notFound, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import { visibleChannels } from "../../services/sessionService";
import { UsageError } from "../../commands/registry";
import { deletePurge, listPurges, PurgeRow, runPurge, savePurge } from "./channelRules";
import {
  AllowType,
  AutoDeleteRule,
  checkInt,
  checkRule,
  cleanPatterns,
  LIMITS,
  PlusConfig,
  RULE_KEYS,
  RULE_LABELS,
  RuleAction,
  RuleKey,
  RuleSettings,
  SlowmodeRule,
} from "./config";
import { endRaid, raidStatus, startRaid } from "./joinProtection";
import { AREA, plusConfig, updatePlus } from "./state";

// GUI service for the module's three areas: the extra Auto-mod options,
// Channel rules and Join protection. Admins only, except raid on/off.
// Validation mirrors the text commands (same LIMITS), and every ID the GUI
// sends is checked against what Taproot can see, except IDs already saved.

// --- Wire mapping -------------------------------------------------------------

const ACTION_TO_WIRE: Record<RuleAction, AutomodplusAction> = {
  delete: AutomodplusAction.DELETE,
  warn: AutomodplusAction.WARN,
  mute: AutomodplusAction.MUTE,
  kick: AutomodplusAction.KICK,
  ban: AutomodplusAction.BAN,
};
const ACTION_FROM_WIRE = new Map([...Object.entries(ACTION_TO_WIRE)].map(([k, v]) => [v, k as RuleAction]));

const ALLOW_TO_WIRE: Record<AllowType, AutomodplusAllowType> = {
  any: AutomodplusAllowType.ANY,
  images: AutomodplusAllowType.IMAGES,
  attachments: AutomodplusAllowType.ATTACHMENTS,
  links: AutomodplusAllowType.LINKS,
  text: AutomodplusAllowType.TEXT,
  commands: AutomodplusAllowType.COMMANDS,
};
const ALLOW_FROM_WIRE = new Map([...Object.entries(ALLOW_TO_WIRE)].map(([k, v]) => [v, k as AllowType]));

function toWireAutomod(c: Readonly<PlusConfig>): AutomodplusAutomodConfig {
  const f = c.filters;
  return {
    filters: {
      invitesEnabled: f.invites.enabled,
      allowedInviteCodes: [...f.invites.allowCodes],
      scamEnabled: f.scam.enabled,
      scamDomains: [...f.scam.extraDomains],
      zalgoEnabled: f.zalgo.enabled,
      emojiEnabled: f.emoji.enabled,
      emojiMax: f.emoji.max,
      wallEnabled: f.newlines.enabled,
      wallMaxLines: f.newlines.maxLines,
      wallMaxChars: f.newlines.maxChars,
      repeatedEnabled: f.repeated.enabled,
      repeatedMax: f.repeated.max,
      attachmentsEnabled: f.attachments.enabled,
      attachmentsMax: f.attachments.max,
      newMemberLinksEnabled: f.newMemberLinks.enabled,
      newMemberMinutes: f.newMemberLinks.minutes,
    },
    rules: RULE_KEYS.map((key) => {
      const r = c.rules[key];
      return {
        rule: key,
        action: ACTION_TO_WIRE[r.action],
        muteMinutes: r.muteMinutes,
        response: r.response,
        logChannelId: r.logChannel ?? undefined,
        exemptChannelIds: [...r.exemptChannels],
        exemptRoleIds: [...r.exemptRoles],
      };
    }),
  };
}

function toWirePurge(r: PurgeRow) {
  return {
    id: r.id,
    channelId: r.channel_id,
    mode: r.mode === "daily" ? AutomodplusPurgeMode.DAILY : AutomodplusPurgeMode.INTERVAL,
    everyHours: r.every_hours,
    dailyMinuteUtc: r.daily_minute,
    keepPinned: r.keep_pinned === 1,
    nextRunAtMs: r.next_at,
    lastRunAtMs: r.last_run_at ?? 0,
    lastDeleted: r.last_deleted ?? 0,
  };
}

async function toWireChannels(): Promise<AutomodplusChannelRules> {
  const c = plusConfig();
  return {
    autoDelete: c.autoDelete.map((r) => ({
      channelId: r.channelId,
      allow: ALLOW_TO_WIRE[r.allow],
      deleteAfterMinutes: r.deleteAfterMinutes,
      exemptStaff: r.exemptStaff,
    })),
    slowmode: c.slowmode.map((r) => ({ channelId: r.channelId, seconds: r.seconds })),
    purges: (await listPurges()).map(toWirePurge),
  };
}

async function toWireJoin(): Promise<AutomodplusJoinProtection> {
  const { autoban: a, raid: r } = plusConfig();
  const s = await raidStatus();
  return {
    autoban: {
      enabled: a.enabled,
      namePatterns: [...a.namePatterns],
      minAccountDays: a.minAccountDays,
      action: a.action === "ban" ? AutomodplusJoinAction.BAN : AutomodplusJoinAction.KICK,
      reason: a.reason,
    },
    raid: {
      enabled: r.enabled,
      joins: r.joins,
      seconds: r.seconds,
      lockChannelIds: [...r.lockChannels],
      throttleEnabled: r.throttle.enabled,
      throttleCount: r.throttle.refillCount,
      throttleWindowMinutes: r.throttle.windowMinutes,
      autoEndMinutes: r.autoEndMinutes,
    },
    status: {
      active: s.active,
      startedAtMs: s.startedAt ?? 0,
      endsAtMs: s.endsAt ?? 0,
      lockedCount: s.lockedCount,
      throttled: s.throttled,
      reason: s.reason ?? "",
    },
  };
}

// --- Validation ---------------------------------------------------------------

function int(value: number, range: readonly [number, number], name: string): number {
  const err = checkInt(value, range, name);
  if (err) invalid(err);
  return value;
}

/**
 * ID checks for one request: channel IDs must be visible to Taproot and role
 * IDs must exist, unless they were already saved. Root is asked at most once
 * per request for each list.
 */
function idChecker() {
  let channels: Promise<Set<string>> | undefined;
  let roles: Promise<Set<string>> | undefined;
  return {
    async channels(ids: string[], saved: Iterable<string>, what: string): Promise<string[]> {
      const unique = [...new Set(ids.filter(Boolean))];
      const known = new Set(saved);
      if (unique.every((id) => known.has(id))) return unique;
      channels ??= act(visibleChannels).then((list) => new Set(list.map((c) => c.id)));
      const visible = await channels;
      for (const id of unique) {
        if (!visible.has(id) && !known.has(id)) invalid(`A ${what} channel doesn't exist or Taproot can't see it.`);
      }
      return unique;
    },
    async roles(ids: string[], saved: Iterable<string>, what: string): Promise<string[]> {
      const unique = [...new Set(ids.filter(Boolean))];
      const known = new Set(saved);
      if (unique.every((id) => known.has(id))) return unique;
      roles ??= act(listRoles).then((list) => new Set<string>(list.map((r) => r.id)));
      const existing = await roles;
      for (const id of unique) {
        if (!existing.has(id) && !known.has(id)) invalid(`A ${what} role doesn't exist.`);
      }
      return unique;
    },
  };
}

/** A UsageError from shared command code becomes INVALID_INPUT with its message. */
async function usage<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof UsageError) invalid(err.message || "That isn't allowed.");
    throw err;
  }
}

function savedRuleIds(c: Readonly<PlusConfig>, field: "exemptChannels" | "exemptRoles"): string[] {
  return RULE_KEYS.flatMap((k) => c.rules[k][field]);
}

// --- Service ------------------------------------------------------------------

class AutomodplusService extends AutomodplusServiceBase {
  constructor() {
    super();
    onChange((area) => {
      if (!area.startsWith("automodplus:")) return;
      try {
        this.broadcastAutomodplusChanged({ area }, "all");
      } catch (err) {
        log("warn", "automodplus broadcast failed", { area, error: errMessage(err) });
      }
    });
  }

  async getAutomodExtras(client: Client): Promise<AutomodplusAutomodConfig> {
    await requireLevel(client, Level.Admin);
    return toWireAutomod(plusConfig());
  }

  async updateAutomodExtras(request: AutomodplusAutomodConfig, client: Client): Promise<AutomodplusAutomodConfig> {
    await requireLevel(client, Level.Admin);
    const current = plusConfig();
    const f = request.filters;
    if (!f) invalid("Missing filters.");

    const codes: string[] = [];
    for (const raw of f.allowedInviteCodes) {
      const code = raw.trim().replace(/^.*\//, "");
      if (!code) continue;
      if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) invalid(`"${raw}" isn't an invite code.`);
      if (!codes.some((c) => c.toLowerCase() === code.toLowerCase())) codes.push(code);
    }
    if (codes.length > LIMITS.inviteCodes) invalid(`At most ${LIMITS.inviteCodes} invite codes.`);
    const domains: string[] = [];
    for (const raw of f.scamDomains) {
      if (!raw.trim()) continue;
      const domain = normalizeDomain(raw.trim().toLowerCase());
      if (!domain) invalid(`"${raw}" isn't a domain.`);
      if (!domains.includes(domain)) domains.push(domain);
    }
    if (domains.length > LIMITS.scamDomains) invalid(`At most ${LIMITS.scamDomains} scam domains.`);

    const check = idChecker();
    const rules = structuredClone(current.rules) as Record<RuleKey, RuleSettings>;
    const savedChannels = [...savedRuleIds(current, "exemptChannels"), ...RULE_KEYS.map((k) => current.rules[k].logChannel ?? "")];
    const savedRoles = savedRuleIds(current, "exemptRoles");
    for (const r of request.rules) {
      if (!(RULE_KEYS as readonly string[]).includes(r.rule)) invalid(`Unknown rule "${r.rule}".`);
      const key = r.rule as RuleKey;
      const action = ACTION_FROM_WIRE.get(r.action);
      if (!action) invalid(`${RULE_LABELS[key]}: pick an action.`);
      const next: RuleSettings = {
        action,
        muteMinutes: r.muteMinutes,
        response: r.response.trim(),
        logChannel: r.logChannelId || null,
        exemptChannels: await check.channels(r.exemptChannelIds, savedChannels, "exempt"),
        exemptRoles: await check.roles(r.exemptRoleIds, savedRoles, "exempt"),
      };
      if (next.logChannel) next.logChannel = (await check.channels([next.logChannel], savedChannels, "log"))[0];
      // A mute length only matters for mute; keep the saved one otherwise.
      if (action !== "mute" && checkInt(next.muteMinutes, LIMITS.muteMinutes, "")) next.muteMinutes = rules[key].muteMinutes;
      const err = checkRule(next, RULE_LABELS[key]);
      if (err) invalid(err);
      rules[key] = next;
    }

    await updatePlus(AREA.automod, (c) => {
      c.filters = {
        invites: { enabled: f.invitesEnabled, allowCodes: codes },
        scam: { enabled: f.scamEnabled, extraDomains: domains },
        zalgo: { enabled: f.zalgoEnabled },
        emoji: { enabled: f.emojiEnabled, max: int(f.emojiMax, LIMITS.emoji, "Max emoji") },
        newlines: {
          enabled: f.wallEnabled,
          maxLines: int(f.wallMaxLines, LIMITS.lines, "Max lines"),
          maxChars: int(f.wallMaxChars, LIMITS.chars, "Max characters"),
        },
        repeated: { enabled: f.repeatedEnabled, max: int(f.repeatedMax, LIMITS.repeated, "Max repeated characters") },
        attachments: { enabled: f.attachmentsEnabled, max: int(f.attachmentsMax, LIMITS.attachments, "Max attachments") },
        newMemberLinks: {
          enabled: f.newMemberLinksEnabled,
          minutes: int(f.newMemberMinutes, LIMITS.newMemberMinutes, "New member minutes"),
        },
      };
      c.rules = rules;
    });
    return toWireAutomod(plusConfig());
  }

  async getChannelRules(client: Client): Promise<AutomodplusChannelRules> {
    await requireLevel(client, Level.Admin);
    return toWireChannels();
  }

  async updateChannelRules(request: AutomodplusChannelRulesUpdate, client: Client): Promise<AutomodplusChannelRules> {
    await requireLevel(client, Level.Admin);
    const current = plusConfig();
    if (request.autoDelete.length > LIMITS.channelRules || request.slowmode.length > LIMITS.channelRules) {
      invalid(`At most ${LIMITS.channelRules} channels each.`);
    }

    const check = idChecker();
    const autoDelete: AutoDeleteRule[] = [];
    const savedDelete = current.autoDelete.map((r) => r.channelId);
    for (const r of request.autoDelete) {
      const [channelId] = await check.channels([r.channelId], savedDelete, "auto delete");
      if (!channelId) invalid("Pick a channel for every auto delete rule.");
      if (autoDelete.some((x) => x.channelId === channelId)) invalid("Each channel can have only one auto delete rule.");
      const allow = ALLOW_FROM_WIRE.get(r.allow);
      if (!allow) invalid("Pick what each auto delete channel allows.");
      const deleteAfterMinutes = int(r.deleteAfterMinutes, LIMITS.deleteAfterMinutes, "Delete after (minutes)");
      if (allow === "any" && deleteAfterMinutes === 0) invalid("An auto delete rule needs a message type or a delay.");
      autoDelete.push({ channelId, allow, deleteAfterMinutes, exemptStaff: r.exemptStaff });
    }

    const slowmode: SlowmodeRule[] = [];
    const savedSlow = current.slowmode.map((r) => r.channelId);
    for (const r of request.slowmode) {
      const [channelId] = await check.channels([r.channelId], savedSlow, "slowmode");
      if (!channelId) invalid("Pick a channel for every slowmode rule.");
      if (slowmode.some((x) => x.channelId === channelId)) invalid("Each channel can have only one slowmode.");
      slowmode.push({ channelId, seconds: int(r.seconds, LIMITS.slowmodeSeconds, "Slowmode seconds") });
    }

    await updatePlus(AREA.channels, (c) => {
      c.autoDelete = autoDelete;
      c.slowmode = slowmode;
    });
    return toWireChannels();
  }

  async savePurge(request: AutomodplusPurgeSave, client: Client): Promise<AutomodplusChannelRules> {
    await requireLevel(client, Level.Admin);
    const existing = request.id ? await get<PurgeRow>("SELECT * FROM automodplus_purges WHERE id = ?", [request.id]) : undefined;
    if (request.id && !existing) notFound("That auto purge no longer exists.");
    const [channelId] = await idChecker().channels([request.channelId], existing ? [existing.channel_id] : [], "purge");
    if (!channelId) invalid("Pick a channel.");
    let mode: "interval" | "daily";
    if (request.mode === AutomodplusPurgeMode.INTERVAL) mode = "interval";
    else if (request.mode === AutomodplusPurgeMode.DAILY) mode = "daily";
    else invalid("Pick how often to purge.");
    const everyHours = mode === "interval" ? int(request.everyHours, LIMITS.purgeEveryHours, "Hours") : 24;
    const dailyMinute = mode === "daily" ? int(request.dailyMinuteUtc, [0, 1439], "Time of day") : 0;
    await act(() =>
      usage(() =>
        savePurge({
          id: request.id || undefined,
          channelId,
          schedule: { mode, everyHours, dailyMinute },
          keepPinned: request.keepPinned,
          userId: client.userId,
        }),
      ),
    );
    return toWireChannels();
  }

  async deletePurge(request: AutomodplusPurgeId, client: Client): Promise<AutomodplusChannelRules> {
    await requireLevel(client, Level.Admin);
    if (!(await deletePurge(request.id))) notFound("That auto purge no longer exists.");
    return toWireChannels();
  }

  async runPurge(request: AutomodplusPurgeId, client: Client): Promise<AutomodplusChannelRules> {
    await requireLevel(client, Level.Admin);
    if (!(await get("SELECT 1 FROM automodplus_purges WHERE id = ?", [request.id]))) notFound("That auto purge no longer exists.");
    // Deleting runs at ~5 messages a second, far longer than an RPC should
    // wait; the page refreshes when the run's result is saved.
    runPurge(request.id).catch((err) => log("warn", "manual auto purge failed", { id: request.id, error: errMessage(err) }));
    return toWireChannels();
  }

  async getJoinProtection(client: Client): Promise<AutomodplusJoinProtection> {
    await requireLevel(client, Level.Admin);
    return toWireJoin();
  }

  async updateJoinProtection(request: AutomodplusJoinProtectionUpdate, client: Client): Promise<AutomodplusJoinProtection> {
    await requireLevel(client, Level.Admin);
    const a = request.autoban;
    const r = request.raid;
    if (!a || !r) invalid("Missing settings.");
    const patterns = cleanPatterns(a.namePatterns);
    if (typeof patterns === "string") invalid(patterns);
    if (patterns.length > LIMITS.namePatterns) invalid(`At most ${LIMITS.namePatterns} name patterns.`);
    const reason = a.reason.trim();
    if (reason.length > 200) invalid("The autoban reason can be at most 200 characters.");
    if (a.action !== AutomodplusJoinAction.KICK && a.action !== AutomodplusJoinAction.BAN) invalid("Pick kick or ban.");
    if (r.lockChannelIds.length > LIMITS.lockChannels) invalid(`At most ${LIMITS.lockChannels} channels to lock.`);
    const lockChannels = await idChecker().channels(r.lockChannelIds, plusConfig().raid.lockChannels, "lock");

    await updatePlus(AREA.join, (c) => {
      c.autoban = {
        enabled: a.enabled,
        namePatterns: patterns,
        minAccountDays: int(a.minAccountDays, LIMITS.accountDays, "Account age (days)"),
        action: a.action === AutomodplusJoinAction.BAN ? "ban" : "kick",
        reason: reason || "Autoban",
      };
      c.raid = {
        enabled: r.enabled,
        joins: int(r.joins, LIMITS.raidJoins, "Joins"),
        seconds: int(r.seconds, LIMITS.raidSeconds, "Seconds"),
        lockChannels,
        throttle: {
          enabled: r.throttleEnabled,
          refillCount: int(r.throttleCount, LIMITS.throttleCount, "Throttle joins"),
          windowMinutes: int(r.throttleWindowMinutes, LIMITS.throttleWindow, "Throttle minutes"),
        },
        autoEndMinutes: int(r.autoEndMinutes, LIMITS.autoEndMinutes, "Auto end (minutes)"),
      };
    });
    return toWireJoin();
  }

  async setRaidMode(request: AutomodplusRaidModeRequest, client: Client): Promise<AutomodplusJoinProtection> {
    await requireLevel(client, Level.Moderator);
    const ended = await act(() =>
      usage(async () => {
        if (!request.active) return endRaid({ moderatorId: client.userId });
        await startRaid({ reason: request.reason.trim().slice(0, 200) || "Started by staff", moderatorId: client.userId });
        return [];
      }),
    );
    if (!ended) invalid("Raid mode isn't on.");
    return toWireJoin();
  }
}

export const automodplusService = new AutomodplusService();
