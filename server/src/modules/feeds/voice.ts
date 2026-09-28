import {
  rootServer,
  ChannelGuid,
  ChannelOrChannelGroupGuid,
  ChannelOverlayPermission,
  ChannelType,
  ChannelWebRtcEvent,
  ChannelWebRtcUserAttachEvent,
  ChannelWebRtcUserDetachEvent,
  ErrorCodeType,
  RoleOrMemberGuid,
} from "@rootsdk/server-app";
import { register, UsageError } from "../../commands/registry";
import { all, get, run } from "../../db";
import { activeMute } from "../../features/mute";
import { onReconcile } from "../../jobs";
import { describeError, errorCode, read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { applyPatch, existingRule } from "../../lib/overlays";
import { channelMention } from "../../lib/text";
import { Level } from "../../permissions";
import { notifyChange, onChange } from "../../services/changes";
import { grantPatch, Overlay, stripGrant } from "./voiceLogic";

// Voice-text links (Dyno's premium "voice text linking"). While a member is
// in a linked voice channel they get a member rule on the text channel that
// lets them see and post in it; leaving takes it away. The rule a member had
// before is saved and put back, and only the fields the link set are undone,
// so a mute added while they were in voice survives them leaving.
//
// If a member is muted while in voice, the mute saves the link's grant as
// the "original" and would put it back on unmute. Such grants stay recorded
// as pending and are stripped again once the mute ends.

export const AREA_VOICE = "feeds:voice";
export const MAX_LINKS = 25;

export interface VoiceLinkRow {
  voice_channel_id: string;
  text_channel_id: string;
  created_by: string;
  created_at: number;
}

interface GrantRow {
  text_channel_id: string;
  user_id: string;
  patch: string;
  original_overlay: string | null;
  pending: number;
}

export async function initVoiceTables(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS feeds_voice_links (
    voice_channel_id TEXT PRIMARY KEY,
    text_channel_id TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  // One row per member currently holding (or owed removal of) a link grant.
  await run(`CREATE TABLE IF NOT EXISTS feeds_voice_grants (
    text_channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    patch TEXT NOT NULL,
    original_overlay TEXT,
    pending INTEGER NOT NULL DEFAULT 0,
    granted_at INTEGER NOT NULL,
    PRIMARY KEY (text_channel_id, user_id)
  )`);
}

export async function listLinks(): Promise<VoiceLinkRow[]> {
  return all<VoiceLinkRow>("SELECT * FROM feeds_voice_links ORDER BY created_at");
}

export async function activeGrantCount(textChannelId: string): Promise<number> {
  return (await get<{ n: number }>("SELECT COUNT(*) AS n FROM feeds_voice_grants WHERE text_channel_id = ? AND pending = 0", [textChannelId]))?.n ?? 0;
}

async function linkFor(voiceChannelId: string): Promise<VoiceLinkRow | undefined> {
  return get<VoiceLinkRow>("SELECT * FROM feeds_voice_links WHERE voice_channel_id = ?", [voiceChannelId]);
}

// --- Serializing per member --------------------------------------------------------

// Join and leave events for one member can arrive back to back (several
// devices, a quick hop between channels), so each member/channel pair's
// changes run one at a time.
const queues = new Map<string, Promise<void>>();

function serialize(key: string, fn: () => Promise<void>): Promise<void> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => log("warn", "voicelink: update failed", { error: errMessage(err) }))
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  queues.set(key, next);
  return next;
}

// --- Grant and revoke -----------------------------------------------------------------

function parseOverlay(json: string | null): Overlay | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Overlay;
  } catch {
    return null;
  }
}

async function grant(textChannelId: string, userId: string): Promise<void> {
  const existingGrant = await get<GrantRow>("SELECT * FROM feeds_voice_grants WHERE text_channel_id = ? AND user_id = ?", [textChannelId, userId]);
  const rule = await existingRule(textChannelId, userId);
  if (existingGrant) {
    const patch = parseOverlay(existingGrant.patch) ?? {};
    // Still in place (joined from a second device, or back before a pending strip): nothing to do.
    if (rule && Object.keys(patch).every((k) => (rule.overlay as Overlay)[k] === patch[k])) {
      if (existingGrant.pending) await run("UPDATE feeds_voice_grants SET pending = 0 WHERE text_channel_id = ? AND user_id = ?", [textChannelId, userId]);
      return;
    }
    // Pending strip whose fields someone changed since: start over from the current rule.
    await run("DELETE FROM feeds_voice_grants WHERE text_channel_id = ? AND user_id = ?", [textChannelId, userId]);
  }
  const patch = grantPatch(rule?.overlay as Overlay | undefined);
  if (!patch) return;
  // A muted member's mute only covers channels they could already see, so a
  // private linked channel has no mute rule: never hand them posting there.
  if (await activeMute(userId)) delete patch.channelCreateMessage;
  const original = await applyPatch(textChannelId, userId, patch as ChannelOverlayPermission, rule);
  await run(
    `INSERT INTO feeds_voice_grants (text_channel_id, user_id, patch, original_overlay, pending, granted_at)
     VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(text_channel_id, user_id) DO UPDATE SET
     patch = excluded.patch, original_overlay = excluded.original_overlay, pending = 0, granted_at = excluded.granted_at`,
    [textChannelId, userId, JSON.stringify(patch), original ? JSON.stringify(original) : null, Date.now()],
  );
  notifyChange(AREA_VOICE);
}

async function revoke(textChannelId: string, userId: string): Promise<void> {
  const row = await get<GrantRow>("SELECT * FROM feeds_voice_grants WHERE text_channel_id = ? AND user_id = ?", [textChannelId, userId]);
  if (!row) return;
  const rule = await existingRule(textChannelId, userId);
  if (rule) {
    const next = stripGrant(rule.overlay as Overlay, parseOverlay(row.original_overlay), parseOverlay(row.patch) ?? {});
    const channelOrChannelGroupId = textChannelId as ChannelOrChannelGroupGuid;
    const roleOrMemberId = userId as RoleOrMemberGuid;
    try {
      // Not restorePatch(): that would also undo whatever changed since the grant.
      if (next) {
        await write("accessRules.edit", () =>
          rootServer.community.accessRules.edit({ channelOrChannelGroupId, roleOrMemberId, overlay: next as ChannelOverlayPermission }),
        );
      } else {
        await write("accessRules.delete", () => rootServer.community.accessRules.delete({ channelOrChannelGroupId, roleOrMemberId }));
      }
    } catch (err) {
      if (errorCode(err) !== ErrorCodeType.NotFound) throw err;
    }
  }
  // A mute saved our grant as its "original" and will put it back on unmute.
  if (rule && (await activeMute(userId))) {
    await run("UPDATE feeds_voice_grants SET pending = 1 WHERE text_channel_id = ? AND user_id = ?", [textChannelId, userId]);
  } else {
    await run("DELETE FROM feeds_voice_grants WHERE text_channel_id = ? AND user_id = ?", [textChannelId, userId]);
  }
  notifyChange(AREA_VOICE);
}

// --- Who is in voice ------------------------------------------------------------------

async function voiceMembers(voiceChannelId: string): Promise<Set<string>> {
  const res = await read("channelWebRtcs.list", () => rootServer.community.channelWebRtcs.list({ channelId: voiceChannelId as ChannelGuid }));
  return new Set(res.members.map((m) => m.userId as string));
}

/** Everyone in any voice channel linked to this text channel. */
async function membersEntitled(textChannelId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const link of await all<VoiceLinkRow>("SELECT * FROM feeds_voice_links WHERE text_channel_id = ?", [textChannelId])) {
    for (const id of await voiceMembers(link.voice_channel_id)) out.add(id);
  }
  return out;
}

function onAttach(evt: ChannelWebRtcUserAttachEvent): void {
  void (async () => {
    const link = await linkFor(evt.channelId);
    if (!link) return;
    await serialize(`${link.text_channel_id}:${evt.userId}`, () => grant(link.text_channel_id, evt.userId));
  })().catch((err) => log("warn", "voicelink: join handling failed", { error: errMessage(err) }));
}

function onDetach(evt: ChannelWebRtcUserDetachEvent): void {
  void (async () => {
    const link = await linkFor(evt.channelId);
    if (!link) return;
    await serialize(`${link.text_channel_id}:${evt.userId}`, async () => {
      // Another device, or another voice channel linked to the same text channel, keeps access.
      let stillIn = false;
      try {
        stillIn = (await membersEntitled(link.text_channel_id)).has(evt.userId);
      } catch (err) {
        log("warn", "voicelink: voice list failed", { error: errMessage(err) });
      }
      if (!stillIn) await revoke(link.text_channel_id, evt.userId);
    });
  })().catch((err) => log("warn", "voicelink: leave handling failed", { error: errMessage(err) }));
}

/** Brings one text channel's grants in line with who's in its voice channels. */
async function syncTextChannel(textChannelId: string): Promise<void> {
  const entitled = await membersEntitled(textChannelId);
  const grants = await all<GrantRow>("SELECT * FROM feeds_voice_grants WHERE text_channel_id = ?", [textChannelId]);
  for (const g of grants) {
    if (entitled.has(g.user_id)) continue;
    if (g.pending && (await activeMute(g.user_id))) continue;
    await serialize(`${textChannelId}:${g.user_id}`, () => revoke(textChannelId, g.user_id));
  }
  for (const userId of entitled) {
    await serialize(`${textChannelId}:${userId}`, () => grant(textChannelId, userId));
  }
}

/** Startup and daily: members who left voice while Taproot was offline lose access, and vice versa. */
async function reconcile(): Promise<void> {
  const linked = new Set((await listLinks()).map((l) => l.text_channel_id));
  for (const textChannelId of linked) {
    try {
      await syncTextChannel(textChannelId);
    } catch (err) {
      log("warn", "voicelink: reconcile failed", { channel: textChannelId, error: errMessage(err) });
    }
  }
  // Grants left over from removed links.
  const orphans = await all<GrantRow>("SELECT * FROM feeds_voice_grants");
  for (const g of orphans) {
    if (linked.has(g.text_channel_id)) continue;
    if (g.pending && (await activeMute(g.user_id))) continue;
    await serialize(`${g.text_channel_id}:${g.user_id}`, () => revoke(g.text_channel_id, g.user_id));
  }
}

/** After a mute ends, strip grants that the unmute put back. */
async function sweepPending(): Promise<void> {
  const pending = await all<GrantRow>("SELECT * FROM feeds_voice_grants WHERE pending = 1");
  for (const g of pending) {
    if (await activeMute(g.user_id)) continue;
    const entitled = await membersEntitled(g.text_channel_id).catch(() => new Set<string>());
    if (entitled.has(g.user_id)) {
      await run("UPDATE feeds_voice_grants SET pending = 0 WHERE text_channel_id = ? AND user_id = ?", [g.text_channel_id, g.user_id]);
      continue;
    }
    await serialize(`${g.text_channel_id}:${g.user_id}`, () => revoke(g.text_channel_id, g.user_id));
  }
}

// --- Managing links ---------------------------------------------------------------------

export async function channelProblem(channelId: string, want: "voice" | "text"): Promise<string | undefined> {
  if (!channelId) return want === "voice" ? "Pick a voice channel." : "Pick a text channel.";
  try {
    const channel = await read("channels.get", () => rootServer.community.channels.get({ id: channelId as ChannelGuid }));
    const isVoice = channel.channelType === ChannelType.Voice;
    const isText = channel.channelType === ChannelType.Text || channel.channelType === ChannelType.ThreadedText;
    if (want === "voice" && !isVoice) return `**${channel.name}** isn't a voice channel.`;
    if (want === "text" && !isText) return `**${channel.name}** isn't a text channel.`;
    return undefined;
  } catch (err) {
    const code = errorCode(err);
    if (code === ErrorCodeType.NotFound || code === ErrorCodeType.RequestValidationFailed) return "That channel doesn't exist anymore.";
    return describeError(err);
  }
}

export async function addLink(voiceChannelId: string, textChannelId: string, createdBy: string): Promise<string | undefined> {
  const count = (await get<{ n: number }>("SELECT COUNT(*) AS n FROM feeds_voice_links"))?.n ?? 0;
  const existing = await linkFor(voiceChannelId);
  if (!existing && count >= MAX_LINKS) return `There are already ${MAX_LINKS} voice links. Remove one first.`;
  const previousText = existing?.text_channel_id;
  await run(
    `INSERT INTO feeds_voice_links (voice_channel_id, text_channel_id, created_by, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(voice_channel_id) DO UPDATE SET text_channel_id = excluded.text_channel_id`,
    [voiceChannelId, textChannelId, createdBy, Date.now()],
  );
  notifyChange(AREA_VOICE);
  // Members already in voice get access now; a relinked voice channel's old text channel is cleaned up.
  await syncTextChannel(textChannelId).catch((err) => log("warn", "voicelink: initial sync failed", { error: errMessage(err) }));
  if (previousText && previousText !== textChannelId) {
    await syncTextChannel(previousText).catch((err) => log("warn", "voicelink: cleanup failed", { error: errMessage(err) }));
  }
  return undefined;
}

export async function removeLink(voiceChannelId: string): Promise<boolean> {
  const link = await linkFor(voiceChannelId);
  if (!link) return false;
  await run("DELETE FROM feeds_voice_links WHERE voice_channel_id = ?", [voiceChannelId]);
  notifyChange(AREA_VOICE);
  await syncTextChannel(link.text_channel_id).catch((err) => log("warn", "voicelink: cleanup failed", { error: errMessage(err) }));
  return true;
}

// --- Setup and commands -------------------------------------------------------------------

export function initVoiceLinks(): void {
  rootServer.community.channelWebRtcs.on(ChannelWebRtcEvent.ChannelWebRtcUserAttach, onAttach);
  rootServer.community.channelWebRtcs.on(ChannelWebRtcEvent.ChannelWebRtcUserDetach, onDetach);
  onReconcile(reconcile);
  // Unmutes create a case; that's the cue to strip grants a mute put back.
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  onChange((area) => {
    if (area !== "cases" || sweepTimer) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      sweepPending().catch((err) => log("warn", "voicelink: pending sweep failed", { error: errMessage(err) }));
    }, 5_000);
  });

  register({
    name: "voicelink",
    category: "Feeds",
    level: Level.Admin,
    usage: "add #voice #text | remove #voice | list",
    description: "Give members in a voice channel access to a text channel while they're in voice.",
    details: [
      "Make the text channel private first; members in the voice channel can then see and post in it.",
      "A member who's muted can see the channel but still can't post.",
    ],
    async run(ctx) {
      const sub = ctx.args.word();
      if (sub === "list" || sub === undefined) {
        const links = await listLinks();
        if (links.length === 0) return ctx.reply(`No voice links yet. Add one with \`${ctx.prefix}voicelink add #voice #text\`.`);
        const lines = await Promise.all(
          links.map(async (l) => `${channelMention("voice", l.voice_channel_id)} → ${channelMention("text", l.text_channel_id)} · ${await activeGrantCount(l.text_channel_id)} in voice`),
        );
        return ctx.reply(lines.join("\n"));
      }
      if (sub === "remove" || sub === "delete") {
        const voice = ctx.args.mention("channel");
        if (!voice?.id) throw new UsageError("Mention the voice channel.");
        return ctx.reply((await removeLink(voice.id)) ? `🗑️ ${voice.text} is no longer linked.` : "❌ That voice channel isn't linked.");
      }
      if (sub !== "add") throw new UsageError();
      const voice = ctx.args.mention("channel");
      const text = ctx.args.mention("channel");
      if (!voice?.id || !text?.id) throw new UsageError("Mention the voice channel, then the text channel.");
      const problem = (await channelProblem(voice.id, "voice")) ?? (await channelProblem(text.id, "text"));
      if (problem) return ctx.reply(`❌ ${problem}`);
      const refused = await addLink(voice.id, text.id, ctx.authorId);
      if (refused) return ctx.reply(`❌ ${refused}`);
      await ctx.reply(`🔗 Members in ${voice.text} can now see and post in ${text.text} while they're in voice.`);
    },
  });
}
