import "./env";
import { createHash } from "crypto";
import {
  rootServer,
  ChannelGroupGuid,
  ChannelOverlayPermission,
  ChannelType,
  CommunityPermission,
  CommunityRole,
  RoleOrMemberGuid,
  RootAppStartState,
  RootGuidType,
  RootGuidUtils,
  UserGuid,
  WellKnownRootGuids,
} from "@rootsdk/server-app";
import { all, get, openDatabase, run } from "../src/db";
import { addPanelRole, createPanel, listPanels, panelEntries } from "../src/features/roles";
import { findCustomCommand, saveCustomCommand } from "../src/features/customCommands";
import { listWarnActions, setWarnAction } from "../src/features/modActions";
import { createAnnouncement, listAnnouncements } from "../src/features/reminders";
import { cancelJobs } from "../src/jobs";
import { read, write } from "../src/lib/api";
import { errMessage } from "../src/lib/log";
import { channelMention } from "../src/lib/text";
import { rememberNickname } from "../src/members";
import { send } from "../src/messaging";
import { CaseAction, formatCase, ModCase } from "../src/modlog";
import { MODULES } from "../src/modules";
import { updatePlus } from "../src/modules/automodplus/state";
import { totalXpForLevel, validateEconomy, validateLevels } from "../src/modules/engagement/logic";
import { config as engagementConfig, saveConfig as saveEngagement } from "../src/modules/engagement/runtime";
import { insertShopItem, listShop } from "../src/modules/engagement/store";
import { listGiveaways, startGiveaway } from "../src/modules/events/giveaways";
import { closePoll, createPoll, listPolls, pollById, refreshPoll } from "../src/modules/events/polls";
import { saveStarboard } from "../src/modules/events/starboard";
import { addFeed, listFeeds, resolveSource } from "../src/modules/feeds/feeds";
import { config as logsConfig, NAME as LOGS } from "../src/modules/logs/actionLog";
import { addNote, notesFor } from "../src/modules/modtools/notes";
import { config as modtoolsConfig, saveConfig as saveModtools } from "../src/modules/modtools/store";
import { config as supportConfig, updateConfig as updateSupport } from "../src/modules/support/config";
import { createSubmission, formById, listForms, reviewSubmission, saveForm } from "../src/modules/support/forms";
import { AnsweredQuestion, formatTranscript, Question, TranscriptMessage } from "../src/modules/support/logic";
import { openTicket, selfId } from "../src/modules/support/tickets";
import { listAutoresponders, saveAutoresponder } from "../src/modules/utility/autoresponder";
import { initPermissions, listRoles } from "../src/permissions";
import { configService } from "../src/services/configService";
import { contentService } from "../src/services/contentService";
import { moderationService } from "../src/services/moderationService";
import { sessionService } from "../src/services/sessionService";
import { loadSettings, saveModuleConfig, setSettings, settings } from "../src/settings";

// DEV ONLY. Makes the Taproot-Test community look like a lived-in community
// for the App Store reviewer screenshots and walkthrough.
//
// Everything Taproot can do for real (roles, channels, settings, custom
// commands, autoresponders, announcements, the reaction-role panel, a
// giveaway, polls, forms, open tickets, a feed) goes through Taproot's own
// functions. The test community has only one human, so member activity
// (cases, notes, XP, wallets, closed tickets, form submissions) belongs to
// clearly-sample members with made-up IDs, written straight to Taproot's
// tables. Nothing here asks Root to act on a sample member.
//
// Idempotent: everything is looked up first and skipped when it exists.
//
//   cd server && npm run seed      (stop `npm run server` first, restart it after)
//
// `npm run seed` launches this file through a manifest (devtools/seed-manifest.js)
// rather than the dev host's --file flag, because --file skips the manifest and
// so its permission upload, and creating channel groups needs one more.
//
// Lives outside server/src so it's never compiled into server/dist or packaged.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

function say(message: string): void {
  console.log(`[seed] ${message}`);
}

// --- Sample members ------------------------------------------------------------

interface Person {
  id: string;
  name: string;
}

/**
 * A well-formed Person GUID that belongs to nobody: the owner's timestamp
 * bytes, the Person type byte, and 8 bytes hashed from the name.
 */
function sampleId(ownerId: string, name: string): string {
  const bytes = Buffer.from(ownerId, "base64url");
  bytes[7] = RootGuidType.Person;
  createHash("sha256").update(`taproot-sample:${name}`).digest().copy(bytes, 8, 0, 8);
  const id = bytes.toString("base64url");
  if (RootGuidUtils.toRootGuidType(id) !== RootGuidType.Person) throw new Error(`sample ID for ${name} isn't a Person GUID`);
  return id;
}

const SAMPLE_NAMES = ["Maple", "Juniper", "Rowan", "Sage", "Aspen", "Willow", "Hazel", "Birch", "Cedar", "Fern"] as const;
type SampleName = (typeof SAMPLE_NAMES)[number];

// --- Roles ---------------------------------------------------------------------

const NO_COMMUNITY: CommunityPermission = {
  communityManageCommunity: false,
  communityManageRoles: false,
  communityManageEmojis: false,
  communityManageAuditLog: false,
  communityCreateInvite: true,
  communityManageInvites: false,
  communityCreateBan: false,
  communityManageBans: false,
  communityFullControl: false,
  communityKick: false,
  communityChangeMyNickname: true,
  communityChangeOtherNickname: false,
  communityCreateChannelGroup: false,
  communityManageApps: false,
};

const ROLE_SPECS: Array<{ name: string; color: string; staff?: boolean; selfAssignable?: boolean }> = [
  { name: "Moderator", color: "#3FA66B", staff: true },
  { name: "Member", color: "#8A9A5B" },
  { name: "Gamer", color: "#5B8DEF", selfAssignable: true },
  { name: "Artist", color: "#E07A5F", selfAssignable: true },
  { name: "Music-Fan", color: "#B57EDC", selfAssignable: true },
  { name: "Regular", color: "#D4A373" },
  { name: "VIP", color: "#F2C14E" },
  { name: "Golden-Leaf", color: "#E9B949" },
  { name: "Night-Bloom", color: "#6D5ACF" },
];

async function ensureRoles(): Promise<Map<string, CommunityRole>> {
  let roles = await listRoles();
  for (const spec of ROLE_SPECS) {
    if (roles.some((r) => r.name.toLowerCase() === spec.name.toLowerCase())) continue;
    await write("communityRoles.create", () =>
      rootServer.community.communityRoles.create({
        name: spec.name,
        colorHex: spec.color,
        communityPermission: spec.staff
          ? { ...NO_COMMUNITY, communityKick: true, communityCreateBan: true, communityManageBans: true, communityChangeOtherNickname: true }
          : NO_COMMUNITY,
        isMentionable: true,
        isSelfAssignable: false,
      }),
    );
    say(`created role ${spec.name}`);
  }
  // listRoles caches for 5 minutes; read fresh.
  roles = await read("communityRoles.list", () => rootServer.community.communityRoles.list());
  return new Map(roles.map((r) => [r.name.toLowerCase(), r]));
}

// --- Channels ------------------------------------------------------------------

const MEMBER_ACCESS: ChannelOverlayPermission = {
  channelView: true,
  channelViewMessageHistory: true,
  channelCreateMessage: true,
  channelCreateMessageReaction: true,
  channelCreateMessageAttachment: true,
  channelCreateMessageMention: true,
};

const STAFF_ACCESS: ChannelOverlayPermission = {
  ...MEMBER_ACCESS,
  channelDeleteMessageOther: true,
  channelManagePinnedMessages: true,
};

const SELF_ACCESS: ChannelOverlayPermission = { channelFullControl: true, channelView: true };

interface GroupSpec {
  name: string;
  channels: string[];
  /** Private groups have no @everyone rule, so only the listed subjects see them. */
  private?: boolean;
}

const GROUPS: GroupSpec[] = [
  { name: "Community", channels: ["general", "announcements", "roles", "events", "media", "starboard"] },
  { name: "Staff", channels: ["mod-log", "action-log", "ticket-transcripts", "applications"], private: true },
  { name: "Tickets", channels: [], private: true },
];

async function ensureChannels(moderatorRoleId: string): Promise<{ groups: Map<string, string>; channels: Map<string, string> }> {
  const groups = new Map<string, string>();
  const channels = new Map<string, string>();
  const existingGroups = await read("channelGroups.list", () => rootServer.community.channelGroups.list());
  say(`existing channel groups: ${existingGroups.map((g) => g.name).join(", ")}`);
  const allChannels = new Map<string, string>();
  for (const g of existingGroups) {
    for (const c of await read("channels.list", () => rootServer.community.channels.list({ channelGroupId: g.id }))) {
      allChannels.set(c.name.toLowerCase(), c.id);
    }
  }

  for (const spec of GROUPS) {
    let groupId = existingGroups.find((g) => g.name.toLowerCase() === spec.name.toLowerCase())?.id as string | undefined;
    if (!groupId) {
      const rules = spec.private
        ? [
            { roleOrMemberId: selfId() as RoleOrMemberGuid, overlay: SELF_ACCESS },
            { roleOrMemberId: moderatorRoleId as RoleOrMemberGuid, overlay: STAFF_ACCESS },
          ]
        : [{ roleOrMemberId: WellKnownRootGuids.CommunityRoles.EveryoneRole as unknown as RoleOrMemberGuid, overlay: MEMBER_ACCESS }];
      const group = await write("channelGroups.create", () =>
        rootServer.community.channelGroups.create({ name: spec.name, accessRuleCreates: rules }),
      );
      groupId = group.id;
      say(`created channel group ${spec.name}${spec.private ? " (private)" : ""}`);
    }
    groups.set(spec.name, groupId);

    for (const name of spec.channels) {
      let id = allChannels.get(name);
      if (!id) {
        const channel = await write("channels.create", () =>
          rootServer.community.channels.create({
            channelGroupId: groupId as ChannelGroupGuid,
            name,
            channelType: ChannelType.Text,
            useChannelGroupPermission: true,
          }),
        );
        id = channel.id;
        allChannels.set(name, id);
        say(`created #${name} in ${spec.name}`);
      }
      channels.set(name, id);
    }
  }
  return { groups, channels };
}

// --- Sample cases ----------------------------------------------------------------

interface SampleCase {
  action: CaseAction;
  who: SampleName | { channel: string; name: string };
  by?: SampleName | "owner";
  reason: string;
  durationMs?: number;
  agoMs: number;
  voided?: boolean;
}

const CASES: SampleCase[] = [
  { action: "warn", who: "Rowan", by: "owner", reason: "Advertising another community in #general", agoMs: 13 * DAY + 3 * HOUR },
  { action: "automod", who: "Birch", reason: "Blocked word", agoMs: 12 * DAY + 7 * HOUR },
  { action: "warn", who: "Birch", by: "Willow", reason: "Arguing with staff after being asked to stop", agoMs: 11 * DAY + 2 * HOUR },
  { action: "mute", who: "Birch", by: "Willow", reason: "Kept at it after a warning; cooling off", durationMs: HOUR, agoMs: 11 * DAY + HOUR },
  { action: "unmute", who: "Birch", reason: "Mute expired", agoMs: 11 * DAY },
  { action: "automod", who: "Hazel", reason: "Too many mentions (7)", agoMs: 9 * DAY + 5 * HOUR },
  { action: "warn", who: "Hazel", by: "Sage", reason: "Off-topic memes in #media", agoMs: 8 * DAY + 4 * HOUR, voided: true },
  { action: "kick", who: "Rowan", by: "owner", reason: "Self-promotion again after a warning", agoMs: 7 * DAY + 6 * HOUR },
  { action: "automod", who: "Aspen", reason: "Link not on the allow list", agoMs: 6 * DAY + 9 * HOUR },
  { action: "warn", who: "Aspen", by: "Sage", reason: "Spamming reactions on the announcement", agoMs: 5 * DAY + 3 * HOUR },
  { action: "ban", who: "Birch", by: "owner", reason: "Slurs in voice chat", durationMs: 7 * DAY, agoMs: 4 * DAY + 2 * HOUR },
  { action: "automod", who: "Juniper", reason: "Message spam (5 messages in 5 seconds)", agoMs: 3 * DAY + 8 * HOUR },
  { action: "warn", who: "Juniper", by: "Willow", reason: "Unmarked spoilers for the new season", agoMs: 2 * DAY + 5 * HOUR },
  { action: "purge", who: { channel: "general", name: "general" }, by: "Sage", reason: "Cleaning up after a spam wave", agoMs: DAY + 10 * HOUR },
  { action: "automod", who: "Cedar", reason: "Mostly capitals", agoMs: DAY + 2 * HOUR },
  { action: "mute", who: "Hazel", by: "Sage", reason: "Posting the same meme after two reminders", durationMs: 2 * DAY, agoMs: 5 * HOUR },
  { action: "automod", who: "Rowan", reason: "Invite link to another community", agoMs: 3 * HOUR },
  { action: "warn", who: "Maple", by: "Willow", reason: "Excessive caps in #general", agoMs: 50 * 60_000 },
];

// --- Main --------------------------------------------------------------------------

async function seed(): Promise<void> {
  await openDatabase();
  await loadSettings();
  await initPermissions();
  // Module init creates their tables and loads their config (it also registers
  // commands and listeners, which this short-lived process never uses).
  for (const m of MODULES) {
    try {
      await m.init();
    } catch (err) {
      say(`module ${m.name} failed to start: ${errMessage(err)}`);
    }
  }

  const community = await read("communities.get", () => rootServer.community.communities.get());
  const ownerId = community.ownerUserId as string;
  const ownerName = (await read("communityMembers.get", () => rootServer.community.communityMembers.get({ userId: community.ownerUserId }))).nickname;
  await rememberNickname(ownerId, ownerName);
  say(`community "${community.name}", owner ${ownerName}`);

  // Sample members: names first, so every later lookup finds them.
  const people = new Map<SampleName, Person>();
  for (const name of SAMPLE_NAMES) {
    const id = sampleId(ownerId, name);
    people.set(name, { id, name });
    await run(
      "INSERT INTO member_names (user_id, nickname, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET nickname = excluded.nickname",
      [id, name, now - 20 * DAY],
    );
  }
  const person = (n: SampleName) => people.get(n)!;
  say(`sample members: ${SAMPLE_NAMES.map((n) => `${n}=${person(n).id}`).join(" ")}`);

  const roles = await ensureRoles();
  const role = (name: string) => {
    const r = roles.get(name.toLowerCase());
    if (!r) throw new Error(`role ${name} missing`);
    return r;
  };
  const { groups, channels } = await ensureChannels(role("Moderator").id);
  const ch = (name: string) => channels.get(name)!;

  // --- Core settings -------------------------------------------------------------
  const current = settings();
  await setSettings({
    prefix: "!",
    modLogChannel: ch("mod-log"),
    welcomeChannel: ch("general"),
    welcomeMessage:
      "Welcome to **{server}**, {user}! 🌱 Say hi, read the pins in #announcements and grab some roles in #roles.",
    goodbyeChannel: ch("general"),
    goodbyeMessage: "**{user.name}** has left the grove. Safe travels!",
    autoroles: [role("Member").id],
    selfRoles: [role("Gamer").id, role("Artist").id, role("Music-Fan").id],
    automod: {
      ...current.automod,
      enabled: true,
      words: { enabled: true, list: ["freenitro", "stfu", "spam*", "idiot"] },
      links: { enabled: true, allow: ["youtube.com", "youtu.be", "rootapp.com"] },
      mentions: { enabled: true, max: 5, blockAll: true },
      spam: { enabled: true, messages: 5, seconds: 5, duplicates: 3 },
      caps: { enabled: true, percent: 75, minLength: 12 },
      strikes: { count: 3, windowMinutes: 10, muteMinutes: 10 },
      ignoredChannels: [ch("mod-log")],
    },
  });
  say("saved prefix, mod log, welcome/goodbye, autoroles, self roles and auto-mod");

  await updatePlus("automodplus:automod", (c) => {
    c.filters.invites.enabled = true;
    c.filters.scam.enabled = true;
    c.filters.zalgo.enabled = true;
    c.filters.emoji = { enabled: true, max: 15 };
    c.filters.newMemberLinks = { enabled: true, minutes: 30 };
  });
  say("turned on the invite, scam, zalgo, emoji and new-member-link filters");

  if ((await listWarnActions()).length === 0) {
    await setWarnAction(3, "mute", 2 * HOUR);
    await setWarnAction(5, "kick");
    say("warn punishments: 3 warnings = 2h mute, 5 = kick");
  }

  const logs = structuredClone(logsConfig());
  logs.channel = ch("action-log");
  logs.announce.channel = ch("general");
  await saveModuleConfig(LOGS, logs);
  say("action log -> #action-log, ban/kick announcements -> #general");

  const mt = structuredClone(modtoolsConfig());
  mt.notify = { warn: true, mute: true, kick: false, ban: false };
  if (mt.timedAutoroles.length === 0) mt.timedAutoroles = [{ roleId: role("Regular").id, delayMs: 30 * DAY }];
  await saveModtools(mt);

  // --- Levels and economy ------------------------------------------------------------
  const eng = structuredClone(engagementConfig());
  const levels = validateLevels({
    ...eng.levels,
    enabled: true,
    announce: "current",
    announceMessage: "🎉 {user} just reached **level {level}**! Keep growing 🌱",
    rewardMode: "stack",
    rewards: [
      { level: 5, roleId: role("Regular").id },
      { level: 15, roleId: role("VIP").id },
    ],
    multipliers: [{ roleId: role("VIP").id, multiplier: 1.5 }],
    noXpChannels: [ch("mod-log"), ch("action-log")],
  });
  const economy = validateEconomy({ ...eng.economy, enabled: true, currencyName: "seeds", currencySymbol: "🌱", dailyAmount: 150 });
  if (typeof levels === "string" || typeof economy === "string") throw new Error(`engagement config rejected: ${levels} ${economy}`);
  await saveEngagement({ levels, economy });
  say("levels on (Regular at 5, VIP at 15), economy on (seeds 🌱)");

  const shop = await listShop();
  const shopItems = [
    { name: "VIP", description: "Gold name, 1.5x XP and the VIP lounge perks", role: "VIP", price: 5000, stock: null },
    { name: "Golden Leaf", description: "A cosmetic gold name colour", role: "Golden-Leaf", price: 1200, stock: null },
    { name: "Night Bloom", description: "A cosmetic violet name colour, limited run", role: "Night-Bloom", price: 2500, stock: 10 },
  ];
  for (const item of shopItems) {
    if (shop.some((s) => s.name === item.name)) continue;
    await insertShopItem({ name: item.name, description: item.description, role_id: role(item.role).id, price: item.price, stock: item.stock });
    say(`shop item ${item.name}`);
  }

  // --- Starboard, tickets --------------------------------------------------------------
  await saveStarboard({ enabled: true, channelId: ch("starboard"), emoji: ":star:", threshold: 3, selfStar: false, ignoredChannels: [ch("mod-log")] });
  say("starboard -> #starboard at 3 stars");

  await updateSupport((c) => {
    c.tickets.enabled = true;
    c.tickets.channelGroupId = groups.get("Tickets")!;
    c.tickets.staffRoleIds = [role("Moderator").id];
    c.tickets.logChannelId = ch("ticket-transcripts");
    c.tickets.maxOpen = 2;
    c.tickets.retentionDays = 90;
    c.tickets.transcriptMode = "full";
  });
  say("tickets on: Tickets group, Moderator staff role, transcripts -> #ticket-transcripts");

  // --- Custom commands, autoresponders, announcements ------------------------------------
  const commands: Array<[string, string, number]> = [
    [
      "rules",
      "📜 **Community rules**\n1. Be kind. No harassment, slurs or personal attacks.\n2. Keep it on topic and use the right channel.\n3. No spam, self-promotion or invite links.\n4. Mark spoilers.\n5. Staff decisions are final; appeal on the **Forms** page in the Taproot channel.",
      41,
    ],
    [
      "faq",
      "❓ **FAQ**\n• **Roles?** React in #roles, or type `!iam Gamer`.\n• **Levels?** Chat to earn XP; check yours with `!rank`.\n• **Seeds 🌱?** `!daily` and `!work`, then spend them with `!shop`.\n• **Need staff?** `!ticket open <topic>`.",
      27,
    ],
    ["socials", "🌐 Find us elsewhere: YouTube **youtube.com/@taproot** · Site **taprootapp.github.io/Taproot**", 12],
    ["events", "📅 Game night is every Friday. Grab the **Gamer** role in #roles to get pinged, {user}!", 9],
  ];
  for (const [name, response, uses] of commands) {
    if (await findCustomCommand(name)) continue;
    await saveCustomCommand(name, response, ownerId);
    await run("UPDATE custom_commands SET uses = ?, created_at = ? WHERE name = ?", [uses, now - 12 * DAY, name]);
    say(`custom command !${name}`);
  }

  const ars = await listAutoresponders();
  const arSpecs = [
    { trigger: "good morning", match: "contains" as const, response: "", reaction: ":sunflower:", cooldownSeconds: 0 },
    {
      trigger: "how do i get roles",
      match: "contains" as const,
      response: "Hey {user}! Grab roles by reacting in #roles, or type `!iam Gamer`.",
      reaction: "",
      cooldownSeconds: 60,
    },
    { trigger: "thanks taproot", match: "exact" as const, response: "Any time, {user.name}! 🌱", reaction: ":seedling:", cooldownSeconds: 30 },
  ];
  for (const spec of arSpecs) {
    if (ars.some((a) => a.trigger.toLowerCase() === spec.trigger)) continue;
    const saved = await saveAutoresponder({ ...spec, channelIds: [] }, ownerId);
    say("problem" in saved ? `autoresponder "${spec.trigger}" refused: ${saved.problem}` : `autoresponder "${spec.trigger}"`);
  }

  const announcements = await listAnnouncements();
  const nextFriday = new Date(now);
  nextFriday.setUTCHours(1, 0, 0, 0);
  while (nextFriday.getUTCDay() !== 6 || nextFriday.getTime() < now + HOUR) nextFriday.setUTCDate(nextFriday.getUTCDate() + 1);
  const annSpecs = [
    {
      message: "🎮 **Game night starts in one hour!** Join the voice lounge. Grab the Gamer role in #roles to get pinged next week.",
      when: nextFriday,
      repeat: "weekly" as const,
      channel: "events",
    },
    {
      message: "🎨 **Last call for the autumn art contest!** Post your entry in #media before Sunday. The winner gets the Golden-Leaf role.",
      when: new Date(now + 2 * DAY + 3 * HOUR),
      repeat: "once" as const,
      channel: "announcements",
    },
  ];
  for (const spec of annSpecs) {
    if (announcements.some((a) => a.message === spec.message)) continue;
    const result = await createAnnouncement(ch(spec.channel), spec.message, spec.when, spec.repeat, ownerId);
    say("problem" in result ? `announcement refused: ${result.problem}` : `scheduled announcement #${result.id} (${spec.repeat})`);
  }

  // --- Reaction-role panel -----------------------------------------------------------------
  const panelTitle = "Pick your roles";
  let panel = (await listPanels()).find((p) => p.title === panelTitle);
  if (!panel) {
    panel = await createPanel(ch("roles"), panelTitle);
    say(`reaction-role panel #${panel.id} in #roles`);
  }
  const entries = await panelEntries(panel.id);
  const panelRoles: Array<[string, string, string]> = [
    [":video_game:", "Gamer", "Game nights and LFG pings"],
    [":art:", "Artist", "Art contests and feedback"],
    [":headphones:", "Music-Fan", "Listening parties"],
  ];
  for (const [shortcode, roleName, label] of panelRoles) {
    if (entries.some((e) => e.role_id === role(roleName).id)) continue;
    await addPanelRole(panel, shortcode, role(roleName), label);
    say(`panel role ${shortcode} -> ${roleName}`);
  }

  // --- Sample moderation history --------------------------------------------------------------
  const sampleIds = [...people.values()].map((p) => p.id);
  const haveCases = await get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mod_cases WHERE user_id IN (${sampleIds.map(() => "?").join(",")})`,
    sampleIds,
  );
  if ((haveCases?.n ?? 0) === 0) {
    for (const c of CASES) {
      // Channel cases are named the way the purge command names them.
      const target = typeof c.who === "string" ? person(c.who) : { id: ch(c.who.channel), name: channelMention(c.who.name, ch(c.who.channel)) };
      const mod = c.by === "owner" ? { id: ownerId, name: ownerName } : c.by ? person(c.by) : undefined;
      const { lastID } = await run(
        `INSERT INTO mod_cases (action, user_id, user_name, moderator_id, moderator_name, reason, duration_ms, voided, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.action,
          target.id,
          target.name,
          mod?.id ?? "",
          mod?.name ?? "Taproot auto-mod",
          c.reason,
          c.durationMs ?? null,
          c.voided ? 1 : 0,
          now - c.agoMs,
        ],
      );
      if (c.action === "mute" && c.durationMs && now - c.agoMs + c.durationMs > now) {
        await run("INSERT INTO mutes (user_id, case_id, expires_at, active, created_at) VALUES (?, ?, ?, 1, ?)", [
          target.id,
          lastID,
          now - c.agoMs + c.durationMs,
          now - c.agoMs,
        ]);
      }
      // Post it the way Taproot posts every case, so #mod-log reads like a real history.
      const modCase = (await get<ModCase>("SELECT * FROM mod_cases WHERE id = ?", [lastID]))!;
      await send(ch("mod-log"), formatCase(modCase)).catch((err) => say(`mod log post failed: ${errMessage(err)}`));
    }
    say(`${CASES.length} sample cases (posted to #mod-log), 1 active mute`);
    // Automod strikes behind the automod cases, for the repeat-offender counter.
    for (const c of CASES.filter((x) => x.action === "automod" && typeof x.who === "string")) {
      await run("INSERT INTO automod_strikes (user_id, rule, created_at) VALUES (?, ?, ?)", [person(c.who as SampleName).id, "words", now - c.agoMs]);
    }
  } else say("sample cases already there; skipped");

  const notes: Array<[SampleName, string]> = [
    ["Birch", "Has an alt (Birch_two). Watch for ban evasion when the temp ban ends."],
    ["Hazel", "Talked in voice: understands the #media rules now. Mute is the last step before a kick."],
    ["Rowan", "Rejoined after the kick. One more self-promo = ban."],
    ["Juniper", "Accepted as trial moderator; shadowing Willow this week."],
  ];
  for (const [who, text] of notes) {
    if ((await notesFor(person(who).id)).some((n) => n.text === text)) continue;
    await addNote(person(who).id, ownerId as UserGuid, text);
    say(`note on ${who}`);
  }

  // --- XP and wallets ---------------------------------------------------------------------------
  const xp: Array<[string, number, number, number]> = [
    // [user, level, extra xp into the level, seeds]
    [person("Willow").id, 24, 410, 18450],
    [person("Sage").id, 19, 150, 12120],
    [person("Maple").id, 16, 820, 9340],
    [person("Juniper").id, 14, 330, 7015],
    [person("Cedar").id, 11, 95, 3200],
    [person(`Aspen`).id, 9, 460, 4480],
    [person("Fern").id, 7, 120, 1875],
    [ownerId, 8, 240, 2650],
    [person("Hazel").id, 6, 300, 990],
    [person("Rowan").id, 4, 60, 410],
    [person("Birch").id, 3, 180, 120],
  ];
  for (const [userId, level, extra, seeds] of xp) {
    await run(
      "INSERT INTO engagement_xp (user_id, xp, last_xp_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET xp = MAX(xp, excluded.xp)",
      [userId, totalXpForLevel(level) + extra, now - 2 * HOUR],
    );
    await run(
      `INSERT INTO engagement_wallets (user_id, balance, daily_streak, last_daily_at, last_work_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = MAX(balance, excluded.balance)`,
      [userId, seeds, userId === ownerId ? 0 : 1 + (seeds % 9), userId === ownerId ? 0 : now - 22 * HOUR, 0],
    );
  }
  say(`XP and wallets for ${xp.length} members`);

  // --- Tickets -------------------------------------------------------------------------------------
  const closedTickets: Array<{
    opener: SampleName;
    topic: string;
    agoMs: number;
    closer: SampleName;
    reason: string;
    lines: Array<[SampleName | "Taproot", string, number]>;
  }> = [
    {
      opener: "Maple",
      topic: "Can't see #events on my phone",
      agoMs: 9 * DAY,
      closer: "Willow",
      reason: "Resolved: missing Member role",
      lines: [
        ["Maple", "Hey! Since yesterday I can't see #events on my phone.", 1],
        ["Willow", "Hi Maple, looking now. Did you get the Member role when you joined?", 4],
        ["Maple", "I think so? My profile only shows @everyone.", 6],
        ["Willow", "Found it: the autorole didn't apply when you joined during the outage. I've added Member for you.", 11],
        ["Maple", "It's there now, thank you!!", 13],
        ["Willow", "Glad it's sorted. Closing this one.", 15],
      ],
    },
    {
      opener: "Aspen",
      topic: "Report: scam link in #media",
      agoMs: 6 * DAY,
      closer: "Sage",
      reason: "Handled: account banned, domain added to the scam filter",
      lines: [
        ["Aspen", "Someone posted a 'free nitro' link in #media a few minutes ago. Looks like a phishing site.", 1],
        ["Sage", "Thanks for the report! Auto-mod caught a second copy; I removed the first one and banned the account.", 3],
        ["Aspen", "Nice, that was fast.", 4],
        ["Sage", "I also added the domain to the scam filter so it can't come back. Thanks again!", 6],
      ],
    },
    {
      opener: "Cedar",
      topic: "Question about the VIP shop role",
      agoMs: 2 * DAY,
      closer: "Cedar",
      reason: "Question answered",
      lines: [
        ["Cedar", "How long does the VIP role from the shop last?", 1],
        ["Willow", "It's permanent once you buy it. It costs 5,000 seeds; check your balance with !balance.", 5],
        ["Cedar", "I'm at 3,200. Guess I'm doing !daily for a while.", 7],
        ["Willow", "Streaks add a bonus each day, so it goes faster than you'd think.", 8],
        ["Cedar", "Good to know, thanks! You can close this.", 10],
      ],
    },
  ];
  const tickets = await all<{ topic: string; status: string }>("SELECT topic, status FROM support_tickets");
  for (const t of closedTickets) {
    if (tickets.some((x) => x.topic === t.topic)) continue;
    const openedAt = now - t.agoMs;
    const welcome = `Hi ${t.opener}, thanks for opening a ticket! Tell us what's going on and a staff member will be with you soon.\n\nTopic: ${t.topic}`;
    const messages: TranscriptMessage[] = [
      { atMs: openedAt, author: "Taproot", content: welcome, attachments: [], edited: false },
      ...t.lines.map(([author, content, minutes]) => ({ atMs: openedAt + minutes * 60_000, author, content, attachments: [], edited: false })),
    ];
    const closedAt = openedAt + (t.lines[t.lines.length - 1][2] + 2) * 60_000;
    const transcript = formatTranscript(
      { id: 0, topic: t.topic, opener: t.opener, openedAtMs: openedAt, closedBy: t.closer, closedAtMs: closedAt, reason: t.reason },
      messages,
    );
    const { lastID } = await run(
      `INSERT INTO support_tickets (channel_id, channel_name, opener_id, opener_name, topic, status, claimed_by_id, claimed_by_name,
         opened_at, closed_at, closed_by_name, close_reason, transcript, message_count)
       VALUES ('', ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "",
        person(t.opener).id,
        t.opener,
        t.topic,
        t.closer === t.opener ? person("Willow").id : person(t.closer).id,
        t.closer === t.opener ? "Willow" : t.closer,
        openedAt,
        closedAt,
        t.closer,
        t.reason,
        transcript,
        messages.length,
      ],
    );
    // The header carries the ticket number, known only now.
    await run("UPDATE support_tickets SET channel_name = ?, transcript = ? WHERE id = ?", [
      `ticket-${lastID}-${t.opener.toLowerCase()}`,
      transcript.replace(/^Ticket #0/, `Ticket #${lastID}`),
      lastID,
    ]);
    say(`closed sample ticket #${lastID} (${t.opener})`);
  }

  // Open tickets are real: Taproot creates the private channel for the owner.
  const openTopics = ["Question about the game night schedule", "Suggestion: a #pets channel"];
  for (const topic of openTopics) {
    if (tickets.some((x) => x.topic === topic && x.status === "open")) continue;
    const result = await openTicket(ownerId as UserGuid, topic);
    say("problem" in result ? `open ticket refused: ${result.problem}` : `opened ticket #${result.ticket.id} (${result.ticket.channel_name})`);
  }

  // --- Forms and submissions ----------------------------------------------------------------------
  const q = (id: string, label: string, type: Question["type"], required: boolean, choices: string[] = []): Question => ({
    id,
    label,
    type,
    required,
    choices,
  });
  const formSpecs = [
    {
      title: "Staff application",
      description: "Want to help keep the community healthy? Tell us a bit about yourself. We read every application.",
      questions: [
        q("q1", "What time zone are you in?", "short", true),
        q("q2", "How active are you here?", "choice", true, ["A few times a week", "Daily", "Several hours a day"]),
        q("q3", "Why do you want to be a moderator?", "long", true),
        q("q4", "A member posts a scam link and pings everyone. What do you do?", "long", true),
        q("q5", "Any moderation experience elsewhere?", "short", false),
      ],
      one_per_member: true,
    },
    {
      title: "Mute appeal",
      description: "Muted and think it was a mistake, or ready to rejoin the conversation? Tell us. (Banned members can't open this page, so this is for mutes and warnings.)",
      questions: [
        q("q1", "Which case number is this about?", "short", false),
        q("q2", "What happened, from your side?", "long", true),
        q("q3", "Have you read the rules (!rules)?", "choice", true, ["Yes", "Not yet"]),
      ],
      one_per_member: false,
    },
  ];
  const forms = await listForms();
  const formIds = new Map<string, number>();
  for (const spec of formSpecs) {
    let id = forms.find((f) => f.title === spec.title)?.id;
    if (!id) {
      id = await saveForm(0, { ...spec, channel_id: ch("applications"), role_id: null, enabled: true });
      say(`form "${spec.title}"`);
    }
    formIds.set(spec.title, id);
  }

  const submissions: Array<{ form: string; who: SampleName; answers: AnsweredQuestion[]; review?: ["accepted" | "denied", string] }> = [
    {
      form: "Staff application",
      who: "Juniper",
      answers: [
        { label: "What time zone are you in?", value: "UTC+1 (Berlin)" },
        { label: "How active are you here?", value: "Daily" },
        { label: "Why do you want to be a moderator?", value: "I'm on most evenings when the US staff are asleep, and I'd like to help keep #general friendly for new people." },
        { label: "A member posts a scam link and pings everyone. What do you do?", value: "Delete it, mute them so it can't happen again, check if auto-mod missed a domain, and note it in #mod-log." },
        { label: "Any moderation experience elsewhere?", value: "Two years on a small art server" },
      ],
      review: ["accepted", "Welcome to the team! Trial starts Monday; Willow will show you around."],
    },
    {
      form: "Staff application",
      who: "Rowan",
      answers: [
        { label: "What time zone are you in?", value: "EST" },
        { label: "How active are you here?", value: "Several hours a day" },
        { label: "Why do you want to be a moderator?", value: "I want to help grow the community and bring people over from my other server." },
        { label: "A member posts a scam link and pings everyone. What do you do?", value: "Ban them." },
      ],
      review: ["denied", "Thanks for applying. Please reapply in three months with no new cases."],
    },
    {
      form: "Mute appeal",
      who: "Hazel",
      answers: [
        { label: "Which case number is this about?", value: "The mute from earlier today" },
        { label: "What happened, from your side?", value: "I didn't see the reminder in #media until after I'd posted again. I get it now and I'll keep memes out of there." },
        { label: "Have you read the rules (!rules)?", value: "Yes" },
      ],
    },
  ];
  for (const s of submissions) {
    const formId = formIds.get(s.form)!;
    const exists = await get<{ n: number }>("SELECT COUNT(*) AS n FROM support_submissions WHERE form_id = ? AND user_id = ?", [formId, person(s.who).id]);
    if ((exists?.n ?? 0) > 0) continue;
    const form = (await formById(formId))!;
    let sub = await createSubmission(form, person(s.who).id as UserGuid, s.answers);
    if (s.review) sub = await reviewSubmission(sub, s.review[0], s.review[1], ownerId as UserGuid);
    say(`submission #${sub.id}: ${s.form} from ${s.who} (${sub.status})`);
  }

  // --- Giveaways and polls ---------------------------------------------------------------------------
  const giveaways = await listGiveaways();
  const prize = "Nitro-style perk: 1 month VIP";
  if (!giveaways.some((g) => g.prize === prize && g.state === "running")) {
    const { giveaway } = await startGiveaway({ channelId: ch("events"), prize, winnerCount: 1, durationMs: 3 * DAY, hostId: ownerId });
    for (const [i, name] of (["Maple", "Juniper", "Cedar", "Fern", "Aspen", "Hazel", "Willow"] as SampleName[]).entries()) {
      await run("INSERT OR IGNORE INTO events_giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)", [
        giveaway.id,
        person(name).id,
        now - (7 - i) * 11 * 60_000,
      ]);
    }
    say(`giveaway #${giveaway.id} in #events with 7 sample entries`);
  }
  const pastPrize = "Custom role colour of your choice";
  if (!giveaways.some((g) => g.prize === pastPrize)) {
    const created = now - 10 * DAY;
    const { lastID } = await run(
      `INSERT INTO events_giveaways (channel_id, message_id, prize, winner_count, host_id, ends_at, state, winners, created_at, ended_at)
       VALUES (?, '', ?, 1, ?, ?, 'ended', ?, ?, ?)`,
      [ch("events"), pastPrize, ownerId, created + 3 * DAY, JSON.stringify([{ id: person("Maple").id, reroll: false }]), created, created + 3 * DAY],
    );
    for (const name of ["Maple", "Sage", "Cedar", "Aspen", "Fern"] as SampleName[]) {
      await run("INSERT OR IGNORE INTO events_giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?, ?, ?)", [lastID, person(name).id, created + HOUR]);
    }
    say(`ended sample giveaway #${lastID} (won by Maple)`);
  }

  const polls = await listPolls();
  const vote = async (pollId: number, votes: Array<[SampleName, number]>) => {
    for (const [i, [name, option]] of votes.entries()) {
      await run("INSERT OR IGNORE INTO events_poll_reactions (poll_id, user_id, option, reacted_at) VALUES (?, ?, ?, ?)", [
        pollId,
        person(name).id,
        option,
        now - (votes.length - i) * 7 * 60_000,
      ]);
    }
  };
  const pastQuestion = "Should we add a #pets channel?";
  if (!polls.some((p) => p.question === pastQuestion)) {
    const { poll } = await createPoll({ channelId: ch("general"), question: pastQuestion, options: ["Yes, please!", "No, keep it in #media"], createdBy: ownerId });
    await vote(poll.id, [["Maple", 0], ["Juniper", 0], ["Cedar", 0], ["Fern", 1], ["Aspen", 0], ["Sage", 1], ["Willow", 0]]);
    const closed = await closePoll(poll.id);
    say(typeof closed === "string" ? `closing poll failed: ${closed}` : `closed sample poll #${poll.id} with results`);
  }
  const question = "What should our next community event be?";
  if (!polls.some((p) => p.question === question)) {
    const { poll } = await createPoll({
      channelId: ch("general"),
      question,
      options: ["Game night", "Art contest", "Music listening party", "Movie night"],
      durationMs: 2 * DAY,
      createdBy: ownerId,
    });
    await vote(poll.id, [
      ["Maple", 0], ["Juniper", 1], ["Rowan", 0], ["Sage", 3], ["Aspen", 1], ["Willow", 0], ["Hazel", 2], ["Cedar", 0], ["Fern", 1],
    ]);
    // The votes were written directly, so show them in the live results.
    await refreshPoll((await pollById(poll.id))!);
    say(`poll #${poll.id} in #general with 9 sample votes`);
  }

  // --- One public feed ------------------------------------------------------------------------------
  // Makes real outbound requests to Reddit (and later posts new r/programming links to #media).
  if (!(await listFeeds()).some((f) => f.kind === "reddit")) {
    try {
      const { source, label } = await resolveSource("reddit", "r/programming");
      const result = await addFeed({ kind: "reddit", source, label, channelId: ch("media"), createdBy: ownerId });
      say("problem" in result ? `feed refused: ${result.problem}` : `feed #${result.feed.id}: r/${source} -> #media`);
    } catch (err) {
      say(`reddit feed not added: ${errMessage(err)}`);
    }
  }

  // A feed's first check is a job a minute out, which would fire while this
  // process is still running (and be lost). Drop unchecked feeds' jobs; the
  // server's startup reconcile schedules a fresh one for any feed without a job.
  for (const feed of await listFeeds()) {
    if (feed.last_check_at === null) await cancelJobs("feedpoll", feed.id).catch(() => undefined);
  }

  say("done");
}

async function onStarting(_state: RootAppStartState): Promise<void> {
  // Taproot's GUI services, registered as main.ts does, so the change
  // broadcasts the shared code sends have somewhere to go.
  for (const service of [sessionService, configService, moderationService, contentService]) rootServer.lifecycle.addService(service);
  for (const m of MODULES) for (const service of m.services ?? []) rootServer.lifecycle.addService(service);
  // Run after start() returns, so the host sees a clean start before the long work.
  setTimeout(() => {
    seed()
      .then(() => finish(0))
      .catch((err) => {
        console.error("[seed] failed:", err);
        finish(1);
      });
  }, 500);
}

function finish(code: number): void {
  // Leave the rate-limited write queue a moment to drain, then stop. The dev
  // host keeps running after its App process exits, so stop it too (the SDK's
  // lifecycle.stop() ends this process before a later kill would run).
  setTimeout(() => {
    try {
      process.kill(process.ppid, "SIGINT");
    } catch {
      // Already gone.
    }
    process.exit(code);
  }, 3000);
}

process.on("unhandledRejection", (err) => console.error("[seed] unhandled rejection:", errMessage(err)));

(async () => {
  await rootServer.lifecycle.start(onStarting);
})();
