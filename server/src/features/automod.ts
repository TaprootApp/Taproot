import {
  ChannelMessageCreatedEvent,
  ChannelMessageEditedEvent,
  MessageType,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
} from "@rootsdk/server-app";
import { register, UsageError } from "../commands/registry";
import { get, run } from "../db";
import { onReconcile } from "../jobs";
import { log, errMessage } from "../lib/log";
import { channelMention, fillTemplate, userMention } from "../lib/text";
import { parseDuration } from "../lib/time";
import { normalizeDomain } from "../lib/validate";
import { deleteMessage, sendEphemeral } from "../messaging";
import { nicknameOf } from "../members";
import { createCase } from "../modlog";
import { isAutomodExempt, Level, memberRoleIds } from "../permissions";
import { AutomodConfig, settings, updateAutomod } from "../settings";
import { checkMessage, externalLinks, SpamTracker, Violation } from "./automodRules";
import { muting, postRuleLog, takeRuleAction } from "../modules/automodplus/actions";
import {
  checkInt,
  CLI_OF,
  describeAction,
  ExtraRule,
  FilterConfig,
  LIMITS,
  PlusConfig,
  RULE_ACTIONS,
  RULE_CLI,
  RULE_KEYS,
  ruleFromCli,
  RULE_LABELS,
  RuleKey,
  RuleSettings,
  ruleExempt,
  ruleKeyOf,
} from "../modules/automodplus/config";
import { checkExtraFilters, checkPriorityFilters, countAttachments, ExtraFacts } from "../modules/automodplus/filters";
import { memberForMs } from "../modules/automodplus/joinTimes";
import { AREA, plusConfig, updatePlus } from "../modules/automodplus/state";
import { activeMute, muteMember } from "./mute";

const tracker = new SpamTracker();
const exemptCache = new Map<string, { at: number; exempt: boolean }>();
const EXEMPT_TTL = 60_000;
// One notice and one mod-log case per member per window, so a spam burst
// doesn't turn into a flood of bot messages. Every offending message is
// still deleted.
const lastNotice = new Map<string, number>();
const NOTICE_WINDOW = 30_000;

async function exempt(userId: UserGuid): Promise<boolean> {
  const cached = exemptCache.get(userId);
  if (cached && Date.now() - cached.at < EXEMPT_TTL) return cached.exempt;
  const result = await isAutomodExempt(userId);
  exemptCache.set(userId, { at: Date.now(), exempt: result });
  return result;
}

function factsOf(evt: ChannelMessageCreatedEvent | ChannelMessageEditedEvent): ExtraFacts {
  return {
    userId: evt.userId,
    content: evt.messageContent ?? "",
    uris: evt.messageUris.map((u) => u.uri),
    mentionedUserIds: evt.referenceMaps?.users?.map((u) => u.userId) ?? [],
    mentionedRoleIds: evt.referenceMaps?.roles?.map((r) => r.communityRoleId) ?? [],
    attachmentCount: countAttachments(evt.messageUris),
    at: Date.now(),
  };
}

/**
 * Turns off every rule that's exempt for this channel or one of the member's
 * roles (per-rule exemptions from the automodplus module). Role IDs are only
 * looked up when some rule has role exemptions.
 */
async function effectiveRules(
  config: AutomodConfig,
  plus: Readonly<PlusConfig>,
  channelId: string,
  userId: UserGuid,
  isEdit: boolean,
): Promise<{ core: AutomodConfig; filters: FilterConfig }> {
  const needsRoles = RULE_KEYS.some((k) => plus.rules[k].exemptRoles.length > 0);
  const roleIds = needsRoles ? await memberRoleIds(userId).catch(() => [] as string[]) : [];
  const on = (key: RuleKey, enabled: boolean) => enabled && !ruleExempt(plus.rules[key], channelId, roleIds);
  const f = plus.filters;
  return {
    core: {
      ...config,
      words: { ...config.words, enabled: on("words", config.words.enabled) },
      links: { ...config.links, enabled: on("links", config.links.enabled) },
      mentions: { ...config.mentions, enabled: on("mentions", config.mentions.enabled) },
      // Edits are only checked for content rules; spam counters count new messages.
      spam: { ...config.spam, enabled: !isEdit && on("spam", config.spam.enabled) },
      caps: { ...config.caps, enabled: on("caps", config.caps.enabled) },
    },
    filters: {
      invites: { ...f.invites, enabled: on("invites", f.invites.enabled) },
      scam: { ...f.scam, enabled: on("scam", f.scam.enabled) },
      zalgo: { enabled: on("zalgo", f.zalgo.enabled) },
      emoji: { ...f.emoji, enabled: on("emoji", f.emoji.enabled) },
      newlines: { ...f.newlines, enabled: on("newlines", f.newlines.enabled) },
      repeated: { ...f.repeated, enabled: on("repeated", f.repeated.enabled) },
      attachments: { ...f.attachments, enabled: !isEdit && on("attachments", f.attachments.enabled) },
      newMemberLinks: { ...f.newMemberLinks, enabled: on("newMemberLinks", f.newMemberLinks.enabled) },
    },
  };
}

/** Returns true when the message broke a rule and was removed. */
export async function automodMessage(
  evt: ChannelMessageCreatedEvent | ChannelMessageEditedEvent,
  isEdit = false,
): Promise<boolean> {
  const config = settings().automod;
  if (!config.enabled) return false;
  if (evt.messageType === MessageType.System) return false;
  if (RootGuidUtils.toRootGuidType(evt.userId) !== RootGuidType.Person) return false;
  if (config.ignoredChannels.includes(evt.channelId)) return false;
  if (await exempt(evt.userId)) return false;

  const plus = plusConfig();
  const { core, filters } = await effectiveRules(config, plus, evt.channelId, evt.userId, isEdit);
  const facts = factsOf(evt);
  if (filters.newMemberLinks.enabled && externalLinks(facts).length > 0) facts.memberForMs = await memberForMs(evt.userId);

  // Scam and invite links first, so they get their own action rather than the links rule's.
  const violation = checkPriorityFilters(facts, filters) ?? checkMessage(facts, core, tracker) ?? checkExtraFilters(facts, filters);
  if (!violation) return false;

  await deleteMessage(evt.channelId, evt.id).catch((err) =>
    log("warn", "auto-mod delete failed", { error: errMessage(err) }),
  );
  await enforce(evt.userId, evt.channelId, violation, facts.content);
  return true;
}

function noticeFor(rule: RuleSettings, key: RuleKey, vars: { mention: string; name: string; channelId: string }, fallback: string): string {
  if (!rule.response.trim()) return fallback;
  return fillTemplate(rule.response, {
    user: vars.mention,
    "user.name": vars.name,
    rule: RULE_LABELS[key],
    channel: channelMention("channel", vars.channelId),
  });
}

async function enforce(userId: UserGuid, channelId: string, violation: Violation, content: string): Promise<void> {
  const key = ruleKeyOf(violation.rule);
  const rule = plusConfig().rules[key];
  const now = Date.now();
  const quiet = now - (lastNotice.get(userId) ?? 0) < NOTICE_WINDOW;
  const name = await nicknameOf(userId);
  const mention = userMention(name, userId);
  const vars = { mention, name, channelId };

  // Any action beyond plain delete is the rule's own punishment, in place of strikes.
  if (rule.action !== "delete") {
    const { outcome } = await takeRuleAction(userId, key, rule, violation.message);
    if (!outcome && quiet) return;
    lastNotice.set(userId, now);
    const fallback = outcome ? `🌱 ${mention} ${outcome} by auto-mod: ${violation.message}.` : `🌱 ${mention}, ${violation.message}.`;
    sendEphemeral(channelId, noticeFor(rule, key, vars, fallback), outcome ? 15_000 : 8000);
    await postRuleLog(rule, key, { userId, channelId, content, outcome });
    return;
  }

  const { strikes } = settings().automod;
  await run("INSERT INTO automod_strikes (user_id, rule, created_at) VALUES (?, ?, ?)", [userId, violation.rule, now]);
  const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM automod_strikes WHERE user_id = ? AND created_at >= ?", [
    userId,
    now - strikes.windowMinutes * 60_000,
  ]);

  let escalate = (row?.n ?? 0) >= strikes.count && !muting.has(userId);
  if (escalate) {
    // Marked before the await so concurrent violations don't mute twice.
    muting.add(userId);
    try {
      if (await activeMute(userId)) escalate = false;
      else {
        await run("DELETE FROM automod_strikes WHERE user_id = ?", [userId]);
        await muteMember({
          userId,
          durationMs: strikes.muteMinutes * 60_000,
          reason: `Auto-mod: ${strikes.count} violations in ${strikes.windowMinutes} min (last: ${violation.rule})`,
        });
      }
    } finally {
      muting.delete(userId);
    }
  }
  if (escalate) {
    lastNotice.set(userId, now);
    sendEphemeral(channelId, `🔇 ${mention} was muted for ${strikes.muteMinutes} min by auto-mod.`, 15_000);
    await postRuleLog(rule, key, { userId, channelId, content, outcome: `muted for ${strikes.muteMinutes} min (repeat offender)` });
    return;
  }
  if (quiet) return;
  lastNotice.set(userId, now);
  sendEphemeral(channelId, noticeFor(rule, key, vars, `🌱 ${mention}, ${violation.message}.`));
  await createCase({ action: "automod", userId, reason: `${violation.rule}: ${violation.message}` });
  await postRuleLog(rule, key, { userId, channelId, content });
}

// --- Commands ----------------------------------------------------------------

const CORE_RULES = ["words", "links", "mentions", "spam", "caps"] as const;
type CoreRule = (typeof CORE_RULES)[number];

function describeConfig(c: AutomodConfig): string {
  const onOff = (b: boolean) => (b ? "✅ on" : "⬜ off");
  const plus = plusConfig();
  const f = plus.filters;
  const act = (key: RuleKey) => {
    const r = plus.rules[key];
    const extras = [
      r.action !== "delete" ? describeAction(r) : "",
      r.exemptChannels.length || r.exemptRoles.length ? `${r.exemptChannels.length + r.exemptRoles.length} exemption(s)` : "",
      r.logChannel ? `logs to ${channelMention("channel", r.logChannel)}` : "",
    ].filter(Boolean);
    return extras.length ? ` · ${extras.join(" · ")}` : "";
  };
  return [
    `**Auto-mod is ${c.enabled ? "ON" : "OFF"}**`,
    `**words** ${onOff(c.words.enabled)} · ${c.words.list.length} blocked word(s)${act("words")}`,
    `**links** ${onOff(c.links.enabled)} · allowed: ${c.links.allow.length ? c.links.allow.join(", ") : "none"}${act("links")}`,
    `**mentions** ${onOff(c.mentions.enabled)} · max ${c.mentions.max} per message · @All/@Here ${c.mentions.blockAll ? "blocked" : "allowed"}${act("mentions")}`,
    `**spam** ${onOff(c.spam.enabled)} · more than ${c.spam.messages} messages in ${c.spam.seconds}s, or the same message ${c.spam.duplicates} times${act("spam")}`,
    `**caps** ${onOff(c.caps.enabled)} · ${c.caps.percent}% capitals in messages of ${c.caps.minLength}+ letters${act("caps")}`,
    `**invites** ${onOff(f.invites.enabled)} · links to other Root communities${f.invites.allowCodes.length ? ` · allowed codes: ${f.invites.allowCodes.join(", ")}` : ""}${act("invites")}`,
    `**scam** ${onOff(f.scam.enabled)} · lookalike domains and scam phrases${f.scam.extraDomains.length ? ` · +${f.scam.extraDomains.length} domain(s)` : ""}${act("scam")}`,
    `**zalgo** ${onOff(f.zalgo.enabled)}${act("zalgo")}`,
    `**emoji** ${onOff(f.emoji.enabled)} · more than ${f.emoji.max} per message${act("emoji")}`,
    `**wall** ${onOff(f.newlines.enabled)} · more than ${f.newlines.maxLines} lines or ${f.newlines.maxChars} characters${act("newlines")}`,
    `**repeated** ${onOff(f.repeated.enabled)} · one character more than ${f.repeated.max} times in a row${act("repeated")}`,
    `**attachments** ${onOff(f.attachments.enabled)} · more than ${f.attachments.max} per message${act("attachments")}`,
    `**newlinks** ${onOff(f.newMemberLinks.enabled)} · no links from members who joined under ${f.newMemberLinks.minutes} min ago${act("newMemberLinks")}`,
    `**Escalation:** ${c.strikes.count} violations in ${c.strikes.windowMinutes} min → muted for ${c.strikes.muteMinutes} min (rules set to plain delete)`,
    `**Ignored channels:** ${c.ignoredChannels.length ? c.ignoredChannels.map((id) => channelMention("channel", id)).join(", ") : "none"}`,
  ].join("\n");
}

/** The rule named in a command, e.g. "wall" -> newlines. */
function takeRule(word: string | undefined): RuleKey {
  const key = ruleFromCli(word);
  if (!key) throw new UsageError(`Rules: ${Object.keys(RULE_CLI).join(", ")}.`);
  return key;
}

async function setRuleEnabled(key: RuleKey, on: boolean): Promise<void> {
  if ((CORE_RULES as readonly string[]).includes(key)) {
    await updateAutomod((c) => (c[key as CoreRule].enabled = on));
  } else {
    await updatePlus(AREA.automod, (p) => (p.filters[key as ExtraRule].enabled = on));
  }
}

async function setFilterNumber(
  value: string | undefined,
  range: readonly [number, number],
  name: string,
  apply: (p: PlusConfig, n: number) => void,
): Promise<void> {
  const n = Number(value);
  const err = checkInt(n, range, name);
  if (err) throw new UsageError(err);
  await updatePlus(AREA.automod, (p) => apply(p, n));
}

function positiveInt(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a whole number above 0.`);
  return n;
}

export function registerAutomod(): void {
  setInterval(() => tracker.prune(Date.now(), 120_000), 60_000).unref();
  onReconcile(async () => {
    await run("DELETE FROM automod_strikes WHERE created_at < ?", [Date.now() - 86_400_000]);
  });

  register(
    {
      name: "automod",
      category: "Auto-mod",
      level: Level.Admin,
      usage: "[on | off | <rule> on|off | ignore #channel | unignore #channel | action | response | log | exempt]",
      description:
        "Show or change auto-mod. Rules: words, links, mentions, spam, caps, invites, scam, zalgo, emoji, wall, repeated, attachments, newlinks.",
      details: [
        "`automod on` turns auto-mod on. `automod links on` turns one rule on.",
        "`automod action <rule> <delete|warn|mute [duration]|kick|ban>` picks what happens after the message is deleted. Plain delete counts strikes toward the escalation mute.",
        "`automod response <rule> <text|off>` replaces the notice. Placeholders: {user} {user.name} {rule} {channel}.",
        "`automod log <rule> <#channel|off>` also reports that rule's removals in a channel.",
        "`automod exempt <rule> <#channel|@role>` turns one rule off for a channel or role (run again to undo).",
        "Staff, and anyone in the Exempt picker on Taproot's settings page, are never filtered.",
        "See also: `badword`, `allowlink`, `automodset`.",
      ],
      async run(ctx) {
        const first = ctx.args.word();
        if (!first) return ctx.reply(describeConfig(settings().automod));
        if (first === "on" || first === "off") {
          await updateAutomod((c) => (c.enabled = first === "on"));
          return ctx.reply(`✅ Auto-mod turned **${first}**.`);
        }
        if (first === "ignore" || first === "unignore") {
          const channel = ctx.args.mention("channel");
          if (!channel?.id) throw new UsageError("Mention a channel.");
          await updateAutomod((c) => {
            c.ignoredChannels = c.ignoredChannels.filter((id) => id !== channel.id);
            if (first === "ignore") c.ignoredChannels.push(channel.id!);
          });
          return ctx.reply(`✅ Auto-mod will ${first === "ignore" ? "ignore" : "watch"} ${channel.text}.`);
        }
        if (first === "action") {
          const key = takeRule(ctx.args.word());
          const action = ctx.args.word();
          if (!action || !(RULE_ACTIONS as readonly string[]).includes(action)) {
            throw new UsageError("Action must be delete, warn, mute, kick or ban.");
          }
          let muteMinutes = plusConfig().rules[key].muteMinutes;
          if (action === "mute") {
            const text = ctx.args.word();
            if (text) {
              const ms = parseDuration(text);
              if (ms === undefined) throw new UsageError("Give the mute length like `10m` or `2h`.");
              muteMinutes = Math.round(ms / 60_000);
              const err = checkInt(muteMinutes, LIMITS.muteMinutes, "The mute length in minutes");
              if (err) throw new UsageError(err);
            }
          }
          await updatePlus(AREA.automod, (p) => Object.assign(p.rules[key], { action, muteMinutes }));
          return ctx.reply(`✅ **${CLI_OF[key]}**: ${describeAction(plusConfig().rules[key])}.`);
        }
        if (first === "response") {
          const key = takeRule(ctx.args.word());
          const text = ctx.args.rest();
          if (!text) throw new UsageError("Give the text, or `off` for the default notice.");
          if (text.length > LIMITS.response) throw new UsageError(`Responses can be at most ${LIMITS.response} characters.`);
          const response = text.toLowerCase() === "off" ? "" : text;
          await updatePlus(AREA.automod, (p) => (p.rules[key].response = response));
          return ctx.reply(response ? `✅ New notice for **${CLI_OF[key]}** saved.` : `✅ **${CLI_OF[key]}** uses the default notice.`);
        }
        if (first === "log") {
          const key = takeRule(ctx.args.word());
          const channel = ctx.args.mention("channel");
          if (!channel?.id && ctx.args.word() !== "off") throw new UsageError("Mention a channel, or say off.");
          await updatePlus(AREA.automod, (p) => (p.rules[key].logChannel = channel?.id ?? null));
          return ctx.reply(channel ? `✅ **${CLI_OF[key]}** removals are reported in ${channel.text}.` : `✅ **${CLI_OF[key]}** log channel removed.`);
        }
        if (first === "exempt") {
          const key = takeRule(ctx.args.word());
          const channel = ctx.args.mention("channel");
          const role = channel ? undefined : ctx.args.mention("role");
          const target = channel ?? role;
          if (!target?.id) throw new UsageError("Mention a channel or a role.");
          const field = channel ? "exemptChannels" : "exemptRoles";
          const list = plusConfig().rules[key][field];
          const removing = list.includes(target.id);
          if (!removing && list.length >= LIMITS.exemptions) throw new UsageError(`At most ${LIMITS.exemptions} per rule.`);
          await updatePlus(AREA.automod, (p) => {
            const current = p.rules[key][field].filter((id) => id !== target.id);
            p.rules[key][field] = removing ? current : [...current, target.id!];
          });
          return ctx.reply(
            removing
              ? `✅ **${CLI_OF[key]}** applies to ${target.text} again.`
              : `✅ **${CLI_OF[key]}** no longer applies to ${target.text}.`,
          );
        }
        const ruleKey = ruleFromCli(first);
        if (ruleKey) {
          const key = ruleKey;
          const state = ctx.args.word();
          if (state !== "on" && state !== "off") throw new UsageError(`Say \`${first} on\` or \`${first} off\`.`);
          await setRuleEnabled(key, state === "on");
          const hint = settings().automod.enabled ? "" : `\nAuto-mod itself is off; turn it on with \`${ctx.prefix}automod on\`.`;
          return ctx.reply(`✅ The **${first}** rule is ${state}.${hint}`);
        }
        throw new UsageError();
      },
    },
    {
      name: "automodset",
      category: "Auto-mod",
      level: Level.Admin,
      usage: "<setting> <value>",
      description: "Tune auto-mod thresholds.",
      details: [
        "`mentions <n>` max mentions per message · `everyone on|off` block @All/@Here",
        "`spam <messages> <seconds>` · `duplicates <n>` · `caps <percent>`",
        "`strikes <count> <minutes>` violations that trigger a mute · `mutetime <minutes>`",
        "`emoji <n>` · `lines <n>` · `chars <n>` (wall of text) · `repeated <n>` · `attachments <n>` · `newmember <minutes>`",
        "`invite add|remove <code>` allows your own invite codes · `scamdomain add|remove <domain>` adds known scam domains",
      ],
      async run(ctx) {
        const key = ctx.args.word();
        const a = ctx.args.word();
        const b = ctx.args.word();
        switch (key) {
          case "mentions":
            await updateAutomod((c) => (c.mentions.max = positiveInt(a, "Max mentions")));
            break;
          case "everyone":
            if (a !== "on" && a !== "off") throw new UsageError("Say on or off.");
            await updateAutomod((c) => (c.mentions.blockAll = a === "on"));
            break;
          case "spam": {
            const messages = positiveInt(a, "Messages");
            const seconds = positiveInt(b, "Seconds");
            await updateAutomod((c) => Object.assign(c.spam, { messages, seconds }));
            break;
          }
          case "duplicates": {
            const n = positiveInt(a, "Duplicates");
            if (n < 2) throw new UsageError("Duplicates must be at least 2.");
            await updateAutomod((c) => (c.spam.duplicates = n));
            break;
          }
          case "caps": {
            const percent = positiveInt(a, "Percent");
            if (percent > 100) throw new UsageError("Percent must be 100 or less.");
            await updateAutomod((c) => (c.caps.percent = percent));
            break;
          }
          case "strikes": {
            const count = positiveInt(a, "Count");
            const windowMinutes = positiveInt(b, "Minutes");
            await updateAutomod((c) => Object.assign(c.strikes, { count, windowMinutes }));
            break;
          }
          case "mutetime":
            await updateAutomod((c) => (c.strikes.muteMinutes = positiveInt(a, "Minutes")));
            break;
          case "emoji":
            await setFilterNumber(a, LIMITS.emoji, "Max emoji", (p, n) => (p.filters.emoji.max = n));
            break;
          case "lines":
            await setFilterNumber(a, LIMITS.lines, "Max lines", (p, n) => (p.filters.newlines.maxLines = n));
            break;
          case "chars":
            await setFilterNumber(a, LIMITS.chars, "Max characters", (p, n) => (p.filters.newlines.maxChars = n));
            break;
          case "repeated":
            await setFilterNumber(a, LIMITS.repeated, "Max repeats", (p, n) => (p.filters.repeated.max = n));
            break;
          case "attachments":
            await setFilterNumber(a, LIMITS.attachments, "Max attachments", (p, n) => (p.filters.attachments.max = n));
            break;
          case "newmember":
            await setFilterNumber(a, LIMITS.newMemberMinutes, "Minutes", (p, n) => (p.filters.newMemberLinks.minutes = n));
            break;
          case "invite": {
            const code = b?.replace(/^.*\//, "");
            if ((a !== "add" && a !== "remove") || !code || !/^[a-z0-9_-]{3,64}$/i.test(code)) {
              throw new UsageError("Say `invite add <code>` or `invite remove <code>`.");
            }
            await updatePlus(AREA.automod, (p) => {
              const rest = p.filters.invites.allowCodes.filter((c) => c.toLowerCase() !== code.toLowerCase());
              p.filters.invites.allowCodes = a === "add" ? [...rest, code].slice(0, LIMITS.inviteCodes) : rest;
            });
            break;
          }
          case "scamdomain": {
            const domain = normalizeDomain(b);
            if ((a !== "add" && a !== "remove") || !domain) throw new UsageError("Say `scamdomain add <domain>` or `scamdomain remove <domain>`.");
            await updatePlus(AREA.automod, (p) => {
              const rest = p.filters.scam.extraDomains.filter((d) => d !== domain);
              p.filters.scam.extraDomains = a === "add" ? [...rest, domain].slice(0, LIMITS.scamDomains) : rest;
            });
            break;
          }
          default:
            throw new UsageError();
        }
        await ctx.reply(`✅ Saved.\n${describeConfig(settings().automod)}`);
      },
    },
    {
      name: "badword",
      aliases: ["badwords"],
      category: "Auto-mod",
      level: Level.Admin,
      usage: "<add|remove> <words…> | list",
      description: "Manage the blocked-word list. `spam*` also blocks words starting with spam.",
      details: ["Messages that contain a blocked word are deleted. Tip: run `badword list` in a staff channel."],
      async run(ctx) {
        const action = ctx.args.word();
        if (action === "list" || !action) {
          const list = settings().automod.words.list;
          return ctx.reply(list.length ? `**Blocked words (${list.length}):** ${list.join(", ")}` : "No blocked words.");
        }
        const words = ctx.args
          .rest()
          .split(/[\s,]+/)
          .map((w) => w.toLowerCase())
          .filter(Boolean);
        if (words.length === 0) throw new UsageError();
        if (action === "add") {
          await updateAutomod((c) => (c.words.list = [...new Set([...c.words.list, ...words])]));
        } else if (action === "remove") {
          await updateAutomod((c) => (c.words.list = c.words.list.filter((w) => !words.includes(w))));
        } else throw new UsageError();
        // Delete the command so the words don't sit in chat.
        await deleteMessage(ctx.channelId, ctx.messageId).catch(() => undefined);
        sendEphemeral(ctx.channelId, `✅ ${action === "add" ? "Added" : "Removed"} ${words.length} word(s).`);
      },
    },
    {
      name: "allowlink",
      aliases: ["allowlinks"],
      category: "Auto-mod",
      level: Level.Admin,
      usage: "<add|remove> <domain> | list",
      description: "Domains the links rule lets through (subdomains included).",
      async run(ctx) {
        const action = ctx.args.word();
        if (action === "list" || !action) {
          const allow = settings().automod.links.allow;
          return ctx.reply(allow.length ? `**Allowed domains:** ${allow.join(", ")}` : "No allowed domains.");
        }
        const domain = normalizeDomain(ctx.args.word());
        if (!domain) throw new UsageError("Give a domain like youtube.com.");
        if (action === "add") await updateAutomod((c) => (c.links.allow = [...new Set([...c.links.allow, domain])]));
        else if (action === "remove") await updateAutomod((c) => (c.links.allow = c.links.allow.filter((d) => d !== domain)));
        else throw new UsageError();
        await ctx.reply(`✅ ${action === "add" ? "Allowed" : "Removed"} ${domain}.`);
      },
    },
  );
}

export function forgetAutomodCaches(userId: string): void {
  exemptCache.delete(userId);
}
