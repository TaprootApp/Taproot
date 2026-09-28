import { rootServer, UserGuid } from "@rootsdk/server-app";
import { get } from "../../db";
import { activeMute, muteMember } from "../../features/mute";
import { describeError, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { formatDuration } from "../../lib/time";
import { channelMention, truncate } from "../../lib/text";
import { nicknameOf } from "../../members";
import { send } from "../../messaging";
import { activeWarnings, createCase } from "../../modlog";
import { MAX_BAN_REASON } from "../../features/modActions";
import { describeAction, RULE_LABELS, RuleKey, RuleSettings } from "./config";

// Per-rule auto-mod actions beyond "delete" (Dyno's automod ladder): warn,
// mute, kick or ban, taken as Taproot itself. Staff and exempt members never
// get here (automod.ts checks first), so rank checks aren't needed.
//
// A burst of offending messages is all deleted, but the member is only
// warned / kicked / banned once per window, so one spam wave doesn't become
// five warnings and a threshold ban.

const lastAction = new Map<string, number>();
/** Members an auto-mod mute is being applied to right now. */
export const muting = new Set<string>();
const ACTION_WINDOW = 30_000;

function throttled(userId: string, action: string): boolean {
  const key = `${userId}:${action}`;
  const now = Date.now();
  if (now - (lastAction.get(key) ?? 0) < ACTION_WINDOW) return true;
  lastAction.set(key, now);
  if (lastAction.size > 5000) {
    for (const [k, at] of lastAction) if (now - at > ACTION_WINDOW) lastAction.delete(k);
  }
  return false;
}

/**
 * Same as a moderator's warn, but by auto-mod: records the case and applies
 * the warnpunish threshold for the new count (mirrors applyWarnThreshold in
 * features/modActions.ts, which only runs for staff-issued warnings).
 */
async function autoWarn(userId: UserGuid, reason: string): Promise<string | undefined> {
  await createCase({ action: "warn", userId, reason });
  const count = (await activeWarnings(userId)).length;
  const rule = await get<{ action: "mute" | "kick" | "ban"; duration_ms: number | null }>(
    "SELECT action, duration_ms FROM warn_actions WHERE warn_count = ?",
    [count],
  );
  if (!rule) return undefined;
  const why = `Reached ${count} warnings`;
  const duration = rule.duration_ms ?? undefined;
  try {
    switch (rule.action) {
      case "mute":
        await muteMember({ userId, reason: why, durationMs: duration });
        return `muted${duration ? ` for ${formatDuration(duration)}` : ""} (${count} warnings)`;
      case "kick":
        await write("communityMemberBans.kick", () => rootServer.community.communityMemberBans.kick({ userId }));
        await createCase({ action: "kick", userId, reason: why });
        return `kicked (${count} warnings)`;
      case "ban":
        await write("communityMemberBans.create", () =>
          rootServer.community.communityMemberBans.create({
            userId,
            reason: why,
            expiresAt: duration ? new Date(Date.now() + duration) : undefined,
          }),
        );
        await createCase({ action: "ban", userId, reason: why, durationMs: duration });
        return `banned${duration ? ` for ${formatDuration(duration)}` : ""} (${count} warnings)`;
    }
  } catch (err) {
    log("warn", "auto-mod warn threshold failed", { error: errMessage(err) });
    return undefined;
  }
}

const PAST: Record<RuleSettings["action"], string> = {
  delete: "deleted",
  warn: "warned",
  mute: "muted",
  kick: "kicked",
  ban: "banned",
};

export interface ActionResult {
  /** Headline for the channel notice, e.g. "was muted for 10 min"; undefined = nothing new happened. */
  outcome?: string;
}

/** Takes the rule's action (anything but plain delete). Never throws. */
export async function takeRuleAction(
  userId: UserGuid,
  key: RuleKey,
  rule: RuleSettings,
  detail: string,
): Promise<ActionResult> {
  const reason = `Auto-mod (${RULE_LABELS[key]}): ${detail}`;
  try {
    switch (rule.action) {
      case "delete":
        return {};
      case "warn": {
        if (throttled(userId, "warn")) return {};
        const extra = await autoWarn(userId, reason);
        return { outcome: `was warned${extra ? ` and ${extra}` : ""}` };
      }
      case "mute": {
        // Checked and marked synchronously: a burst of messages is handled concurrently.
        if (muting.has(userId)) return {};
        muting.add(userId);
        try {
          if (await activeMute(userId)) return {};
          const durationMs = rule.muteMinutes * 60_000;
          await muteMember({ userId, durationMs, reason });
          return { outcome: `was muted for ${formatDuration(durationMs)}` };
        } finally {
          muting.delete(userId);
        }
      }
      case "kick": {
        if (throttled(userId, "kick")) return {};
        const name = await nicknameOf(userId);
        await write("communityMemberBans.kick", () => rootServer.community.communityMemberBans.kick({ userId }));
        await createCase({ action: "kick", userId, userName: name, reason });
        return { outcome: "was kicked" };
      }
      case "ban": {
        if (throttled(userId, "ban")) return {};
        const name = await nicknameOf(userId);
        await write("communityMemberBans.create", () =>
          rootServer.community.communityMemberBans.create({ userId, reason: truncate(reason, MAX_BAN_REASON) }),
        );
        await createCase({ action: "ban", userId, userName: name, reason });
        return { outcome: "was banned" };
      }
    }
  } catch (err) {
    log("warn", `auto-mod ${rule.action} failed`, { error: errMessage(err), rule: key });
    return { outcome: `couldn't be ${PAST[rule.action]}: ${describeError(err)}` };
  }
}

/**
 * A short report in the rule's own log channel. The offending text is quoted
 * (shortened) so staff can judge the call; it isn't stored anywhere.
 */
export async function postRuleLog(
  rule: RuleSettings,
  key: RuleKey,
  opts: { userId: string; channelId: string; content: string; outcome?: string },
): Promise<void> {
  if (!rule.logChannel) return;
  const name = await nicknameOf(opts.userId as UserGuid);
  const quoted = truncate(opts.content.replace(/\s+/g, " ").trim(), 300);
  const lines = [
    `🤖 **Auto-mod · ${RULE_LABELS[key]}** · ${describeAction(rule)}`,
    `**Member:** ${name} \`${opts.userId}\` in ${channelMention("channel", opts.channelId)}`,
  ];
  if (opts.outcome) lines.push(`**Result:** ${opts.outcome}`);
  if (quoted) lines.push(`> ${quoted.replace(/\[/g, "\\[")}`);
  await send(rule.logChannel, lines.join("\n")).catch((err) =>
    log("warn", "auto-mod rule log failed", { error: errMessage(err) }),
  );
}
