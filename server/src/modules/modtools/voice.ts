import {
  rootServer,
  ChannelGuid,
  ChannelWebRtcEvent,
  ChannelWebRtcUserAttachEvent,
  UserGuid,
} from "@rootsdk/server-app";
import { get, run } from "../../db";
import { read } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { nicknameOf } from "../../members";
import { modLogNotice } from "../../modlog";
import { canActOn } from "../../permissions";
import { isVoiceChannelType } from "./logic";
import { changed } from "./store";

// Voice moderation: server mute (vmute/vunmute) and disconnect (vkick).
// Root's server mute belongs to the voice session, so a member Taproot has
// voice-muted is muted again every time they join a voice channel, until
// vunmute. Root allows about one voice call per second, so calls queue.

export class VoiceRefused extends Error {}

// --- Call queue --------------------------------------------------------------

const CALL_GAP_MS = 1100;
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function voiceCall<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = lastCall + CALL_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await op();
    } finally {
      lastCall = Date.now();
    }
  });
  // Keep the chain going after a failure.
  chain = next.catch(() => undefined);
  return next;
}

// --- Where is a member? --------------------------------------------------------

// Attach/detach events keep a map of who is in which voice channel. Members
// already in voice when Taproot started aren't in it, so a miss falls back to
// asking each voice channel.
const presence = new Map<string, string>();

// The channel list changes rarely; a member page load shouldn't re-read it.
const CHANNELS_TTL = 60_000;
let channelsCache: { at: number; channels: { id: string; name: string }[] } | undefined;

async function voiceChannels(): Promise<{ id: string; name: string }[]> {
  if (channelsCache && Date.now() - channelsCache.at < CHANNELS_TTL) return channelsCache.channels;
  const out: { id: string; name: string }[] = [];
  const groups = await read("channelGroups.list", () => rootServer.community.channelGroups.list());
  for (const group of groups) {
    const channels = await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: group.id }));
    for (const c of channels) if (isVoiceChannelType(c.channelType)) out.push({ id: c.id, name: c.name });
  }
  channelsCache = { at: Date.now(), channels: out };
  return out;
}

/** The voice channel the member is in, or undefined. */
export async function findVoiceChannel(userId: string): Promise<{ id: string; name: string } | undefined> {
  const channels = await voiceChannels();
  const known = presence.get(userId);
  const ordered = known ? [...channels.filter((c) => c.id === known), ...channels.filter((c) => c.id !== known)] : channels;
  for (const channel of ordered) {
    try {
      const session = await read("channelWebRtcs.list", () =>
        rootServer.community.channelWebRtcs.list({ channelId: channel.id as ChannelGuid }),
      );
      if (session.members.some((m) => m.userId === userId)) {
        presence.set(userId, channel.id);
        return channel;
      }
    } catch {
      // No active session or no access: not there.
    }
  }
  presence.delete(userId);
  return undefined;
}

// --- Actions -----------------------------------------------------------------

export async function isVoiceMuted(userId: string): Promise<boolean> {
  return Boolean(await get("SELECT 1 FROM modtools_voice_mutes WHERE user_id = ?", [userId]));
}

async function setMuted(channelId: string, userId: string, isMuted: boolean): Promise<void> {
  await voiceCall(() =>
    rootServer.community.channelWebRtcs.setMuteAndDeafenOther({
      channelId: channelId as ChannelGuid,
      userId: userId as UserGuid,
      isMuted,
    }),
  );
}

async function ensureCanAct(actorId: UserGuid, userId: UserGuid): Promise<void> {
  const problem = await canActOn(actorId, userId);
  if (problem) throw new VoiceRefused(problem);
}

/** Returns a sentence describing what happened. */
export async function voiceMute(actorId: UserGuid, userId: UserGuid, reason = ""): Promise<string> {
  await ensureCanAct(actorId, userId);
  await run("INSERT OR REPLACE INTO modtools_voice_mutes (user_id, moderator_id, created_at) VALUES (?, ?, ?)", [
    userId,
    actorId,
    Date.now(),
  ]);
  changed("voice");
  const name = await nicknameOf(userId);
  const channel = await findVoiceChannel(userId);
  if (channel) await setMuted(channel.id, userId, true);
  await modLogNotice(
    `🎙️ **Voice mute** · **${name}** \`${userId}\` · by ${await nicknameOf(actorId)}${reason ? ` · ${reason}` : ""}`,
  );
  return channel
    ? `Server-muted ${name} in voice. They stay muted in every voice channel until unmuted.`
    : `${name} isn't in voice right now; they'll be server-muted as soon as they join.`;
}

export async function voiceUnmute(actorId: UserGuid, userId: UserGuid): Promise<string> {
  const { changes } = await run("DELETE FROM modtools_voice_mutes WHERE user_id = ?", [userId]);
  const name = await nicknameOf(userId);
  const channel = await findVoiceChannel(userId);
  if (changes === 0 && !channel) throw new VoiceRefused(`${name} isn't voice-muted by Taproot and isn't in voice.`);
  if (channel) await setMuted(channel.id, userId, false);
  changed("voice");
  await modLogNotice(`🎙️ **Voice unmute** · **${name}** \`${userId}\` · by ${await nicknameOf(actorId)}`);
  return `Lifted ${name}'s voice mute.`;
}

export async function voiceKick(actorId: UserGuid, userId: UserGuid, reason = ""): Promise<string> {
  await ensureCanAct(actorId, userId);
  const name = await nicknameOf(userId);
  const channel = await findVoiceChannel(userId);
  if (!channel) throw new VoiceRefused(`${name} isn't in a voice channel.`);
  await voiceCall(() =>
    rootServer.community.channelWebRtcs.kick({ channelId: channel.id as ChannelGuid, userId: userId as UserGuid }),
  );
  presence.delete(userId);
  changed("voice");
  await modLogNotice(
    `🎙️ **Voice kick** · **${name}** \`${userId}\` from ${channel.name} · by ${await nicknameOf(actorId)}${reason ? ` · ${reason}` : ""}`,
  );
  return `Disconnected ${name} from ${channel.name}.`;
}

// --- Events ------------------------------------------------------------------

async function onAttach(evt: ChannelWebRtcUserAttachEvent): Promise<void> {
  presence.set(evt.userId, evt.channelId);
  if (evt.isAdminMuted || !(await isVoiceMuted(evt.userId))) return;
  await setMuted(evt.channelId, evt.userId, true);
}

export function initVoice(): void {
  const webRtc = rootServer.community.channelWebRtcs;
  webRtc.on(ChannelWebRtcEvent.ChannelWebRtcUserAttach, (evt) => {
    onAttach(evt).catch((err) => log("warn", "re-applying voice mute failed", { error: errMessage(err) }));
  });
  webRtc.on(ChannelWebRtcEvent.ChannelWebRtcUserDetach, (evt) => {
    if (presence.get(evt.userId) === evt.channelId) presence.delete(evt.userId);
  });
}
