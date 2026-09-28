import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkInt,
  cleanPatterns,
  checkRule,
  defaultConfig,
  defaultRule,
  ruleExempt,
  ruleKeyOf,
  RULE_CLI,
  RULE_KEYS,
} from "../src/modules/automodplus/config";
import {
  blockedInvites,
  checkExtraFilters,
  checkPriorityFilters,
  countAttachments,
  countEmoji,
  ExtraFacts,
  findInviteCodes,
  isZalgo,
  longestRun,
  scamReason,
  wallOfText,
} from "../src/modules/automodplus/filters";
import {
  accountCreatedAt,
  autobanReason,
  JoinTracker,
  matchesAllowType,
  nameMatches,
  nextPurgeAt,
  parseDailyTime,
  ROOT_EPOCH_MS,
  SlowmodeTracker,
} from "../src/modules/automodplus/logic";

function facts(content: string, extra: Partial<ExtraFacts> = {}): ExtraFacts {
  return {
    userId: "u1",
    content,
    uris: [],
    mentionedUserIds: [],
    mentionedRoleIds: [],
    at: Date.now(),
    attachmentCount: 0,
    ...extra,
  };
}

/** A 22-character Root-style GUID whose timestamp is `ms` (and type byte 1 = person). */
function guidAt(ms: number): string {
  const bytes = Buffer.alloc(16);
  let n = ms - ROOT_EPOCH_MS;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = n % 256;
    n = Math.floor(n / 256);
  }
  bytes[7] = 1;
  return bytes.toString("base64url").slice(0, 22);
}

// --- Config -------------------------------------------------------------------

test("defaults keep every rule on plain delete", () => {
  const c = defaultConfig();
  for (const key of RULE_KEYS) assert.equal(c.rules[key].action, "delete");
  assert.equal(c.filters.scam.enabled, false);
  assert.equal(c.raid.enabled, false);
});

test("duplicates share the spam rule's settings", () => {
  assert.equal(ruleKeyOf("duplicates"), "spam");
  assert.equal(ruleKeyOf("scam"), "scam");
  assert.equal(RULE_CLI.wall, "newlines");
  assert.equal(RULE_CLI.newlinks, "newMemberLinks");
});

test("rule exemptions by channel and role", () => {
  const rule = { ...defaultRule(), exemptChannels: ["c1"], exemptRoles: ["r1"] };
  assert.equal(ruleExempt(rule, "c1", []), true);
  assert.equal(ruleExempt(rule, "c2", ["r1"]), true);
  assert.equal(ruleExempt(rule, "c2", ["r2"]), false);
});

test("rule and number validation", () => {
  assert.equal(checkInt(5, [1, 10], "n"), undefined);
  assert.match(checkInt(0, [1, 10], "n")!, /1 to 10/);
  assert.match(checkInt(1.5, [1, 10], "n")!, /whole number/);
  assert.match(checkRule({ ...defaultRule(), action: "mute", muteMinutes: 0 }, "Caps")!, /mute minutes/);
  assert.equal(checkRule({ ...defaultRule(), action: "ban" }, "Caps"), undefined);
  assert.deepEqual(cleanPatterns([" Free*Nitro ", "free*nitro", ""]), ["free*nitro"]);
  assert.equal(typeof cleanPatterns(["**"]), "string");
});

// --- Invites ------------------------------------------------------------------

test("invite links on Root's domains are found", () => {
  assert.deepEqual(findInviteCodes("join us https://rootapp.gg/invite/AbC123", []), ["AbC123"]);
  assert.deepEqual(findInviteCodes("", ["https://www.rootapp.com/join/xyz99"]), ["xyz99"]);
  assert.deepEqual(findInviteCodes("rootapp.gg/coolcrew", []), ["coolcrew"]);
  assert.deepEqual(findInviteCodes("get it at https://www.rootapp.com/download", []), []);
  assert.deepEqual(findInviteCodes("docs at https://docs.rootapp.com/invite/abc", []), []);
  assert.deepEqual(findInviteCodes("https://rootapp.gg/developer", []), []);
  assert.deepEqual(findInviteCodes("https://example.com/invite/abc", []), []);
});

test("allowed invite codes pass, case-insensitively", () => {
  assert.deepEqual(blockedInvites("https://rootapp.gg/invite/Home", [], ["home"]), []);
  assert.deepEqual(blockedInvites("https://rootapp.gg/invite/Other", [], ["home"]), ["Other"]);
});

// --- Scam ---------------------------------------------------------------------

test("lookalike domains are scams, the real ones aren't", () => {
  assert.ok(scamReason("free stuff https://dlscord.com/gift", [], []));
  assert.ok(scamReason("https://steamcommunlty.com/tradeoffer", [], []));
  assert.ok(scamReason("https://stearncommunity.ru/id/me", [], []));
  assert.ok(scamReason("look https://steamcommunity.ru/profiles/1", [], []));
  assert.ok(scamReason("https://discord-nitro-gift.xyz", [], []));
  assert.ok(scamReason("https://r00tapp.gg/login", [], []));
  assert.equal(scamReason("https://discord.com/invite/abc", [], []), undefined);
  assert.equal(scamReason("https://discord.gift/abc", [], []), undefined);
  assert.equal(scamReason("https://steamcommunity.com/id/me", [], []), undefined);
  assert.equal(scamReason("https://discordjs.guide and https://www.rootapp.com", [], []), undefined);
  assert.equal(scamReason("I love playing roblox on twitch", [], []), undefined);
});

test("scam phrases: strong ones alone, bait only with a link", () => {
  assert.ok(scamReason("Hey I accidentally reported you, message the admin", [], []));
  assert.equal(scamReason("we're doing a free giveaway in voice tonight", [], []), undefined);
  assert.ok(scamReason("free giveaway! claim at https://example.xyz/claim", [], []));
  assert.ok(scamReason("", ["https://bad.example.net/x"], ["example.net"]));
});

// --- Zalgo, emoji, walls, repeats ----------------------------------------------

test("zalgo text vs real accents", () => {
  assert.equal(isZalgo("Z͑͒͗͛͆algo"), true);
  assert.equal(isZalgo("Tiếng Việt có dấu"), false);
  assert.equal(isZalgo("café naïve"), false);
});

test("emoji counting", () => {
  assert.equal(countEmoji("hi 😀😀😀"), 3);
  assert.equal(countEmoji("family 👨‍👩‍👧 counts once"), 1);
  assert.equal(countEmoji("flag 🇺🇸"), 1);
  assert.equal(countEmoji(":tada: :party_parrot: [:x:](root://emoji/abc)"), 3);
  assert.equal(countEmoji("meet at 12:30:45"), 0);
  assert.equal(countEmoji("© 2026"), 0);
});

test("walls of text and repeated characters", () => {
  assert.equal(wallOfText("a\nb\nc", 2, 1000), "lines");
  assert.equal(wallOfText("x".repeat(50), 10, 20), "chars");
  assert.equal(wallOfText("short", 10, 100), undefined);
  assert.equal(longestRun("heyyyyyy"), 6);
  assert.equal(longestRun("AaAaA"), 5);
  assert.equal(longestRun("a     a"), 1);
});

test("attachments are counted from message URIs", () => {
  assert.equal(countAttachments([{ uri: "a", attachment: {} }, { uri: "https://x.com" }]), 1);
});

test("priority and extra filters respect their switches", () => {
  const f = defaultConfig().filters;
  assert.equal(checkPriorityFilters(facts("https://dlscord.com"), f), undefined);
  f.scam.enabled = true;
  assert.equal(checkPriorityFilters(facts("https://dlscord.com"), f)?.rule, "scam");
  f.attachments.enabled = true;
  f.attachments.max = 2;
  assert.equal(checkExtraFilters(facts("pics", { attachmentCount: 3 }), f)?.rule, "attachments");
  f.newMemberLinks.enabled = true;
  f.newMemberLinks.minutes = 10;
  const link = { uris: ["https://example.com"] };
  assert.equal(checkExtraFilters(facts("x", { ...link, memberForMs: 60_000 }), f)?.rule, "newMemberLinks");
  assert.equal(checkExtraFilters(facts("x", { ...link, memberForMs: 3_600_000 }), f), undefined);
  assert.equal(checkExtraFilters(facts("x", link), f), undefined);
});

// --- Autoban ------------------------------------------------------------------

test("nickname patterns", () => {
  assert.equal(nameMatches("FREE Nitro Bot", "free*nitro"), true);
  assert.equal(nameMatches("Nitro free", "free*nitro"), false);
  assert.equal(nameMatches("spammer", "spam"), true);
  assert.equal(nameMatches("Zoë", "zoe"), true);
  assert.equal(nameMatches("x", "*"), false);
  assert.equal(nameMatches("a".repeat(5000), "a*a*a*a*a*a*a*b"), false);
  assert.equal(nameMatches("anything", "*"), false);
  assert.equal(nameMatches("a.b", "a.b"), true);
  assert.equal(nameMatches("axb", "a.b"), false);
});

test("account age comes from the user ID's timestamp", () => {
  const now = Date.UTC(2026, 8, 28);
  const created = Date.UTC(2026, 8, 27);
  assert.equal(accountCreatedAt(guidAt(created), now), created);
  // Matches the real IDs seen in development (decoded with RootGuidUtils.toMilliseconds).
  assert.equal(new Date(accountCreatedAt("ADGIEKVQggGFOV1MjZIQtg", now)!).toISOString(), "2026-09-28T05:23:09.776Z");
  assert.equal(accountCreatedAt("not-an-id", now), undefined);
  assert.equal(accountCreatedAt(guidAt(now + 7 * 86_400_000), now), undefined);

  const rules = { namePatterns: [], minAccountDays: 3 };
  assert.equal(autobanReason({ nickname: "x", userId: guidAt(created), now }, rules)?.kind, "age");
  assert.equal(autobanReason({ nickname: "x", userId: guidAt(now - 10 * 86_400_000), now }, rules), undefined);
  assert.deepEqual(autobanReason({ nickname: "Free Nitro", userId: "bad", now }, { namePatterns: ["*nitro*"], minAccountDays: 0 }), {
    kind: "name",
    pattern: "*nitro*",
  });
});

// --- Schedules and trackers -----------------------------------------------------

test("auto purge schedule", () => {
  const base = Date.UTC(2026, 0, 1, 10, 0);
  assert.equal(nextPurgeAt({ mode: "interval", everyHours: 6, dailyMinute: 0 }, base, null), base + 6 * 3_600_000);
  assert.equal(nextPurgeAt({ mode: "interval", everyHours: 6, dailyMinute: 0 }, base, base - 3_600_000), base + 5 * 3_600_000);
  // Missed runs are skipped, not replayed.
  const late = nextPurgeAt({ mode: "interval", everyHours: 1, dailyMinute: 0 }, base, base - 10.5 * 3_600_000);
  assert.ok(late > base && late <= base + 3_600_000);
  assert.equal(nextPurgeAt({ mode: "daily", everyHours: 24, dailyMinute: 11 * 60 }, base, null), Date.UTC(2026, 0, 1, 11, 0));
  assert.equal(nextPurgeAt({ mode: "daily", everyHours: 24, dailyMinute: 9 * 60 }, base, null), Date.UTC(2026, 0, 2, 9, 0));
  assert.equal(parseDailyTime("04:30"), 270);
  assert.equal(parseDailyTime("4:30 UTC"), 270);
  assert.equal(parseDailyTime("24:00"), undefined);
});

test("raid join counting", () => {
  const t = new JoinTracker();
  assert.equal(t.record(0, 10_000), 1);
  assert.equal(t.record(5_000, 10_000), 2);
  assert.equal(t.record(16_000, 10_000), 1);
});

test("slowmode", () => {
  const s = new SlowmodeTracker();
  assert.equal(s.check("c", "u", 0, 10), 0);
  assert.equal(s.check("c", "u", 4_000, 10), 6);
  assert.equal(s.check("c", "other", 4_000, 10), 0);
  assert.equal(s.check("c", "u", 10_000, 10), 0);
});

test("auto delete message types", () => {
  const text = { content: "hello", uris: [] };
  const image = { content: "", uris: [{ uri: "root://upload/1", attachment: { mimeType: "image/png" } }] };
  const file = { content: "", uris: [{ uri: "root://upload/2", attachment: { mimeType: "application/pdf" } }] };
  const link = { content: "see https://example.com", uris: [{ uri: "https://example.com" }] };
  assert.equal(matchesAllowType(image, "images", "!"), true);
  assert.equal(matchesAllowType(file, "images", "!"), false);
  assert.equal(matchesAllowType(file, "attachments", "!"), true);
  assert.equal(matchesAllowType(text, "attachments", "!"), false);
  assert.equal(matchesAllowType(link, "links", "!"), true);
  assert.equal(matchesAllowType(link, "text", "!"), false);
  assert.equal(matchesAllowType(text, "text", "!"), true);
  assert.equal(matchesAllowType({ content: "!rank", uris: [] }, "commands", "!"), true);
  assert.equal(matchesAllowType(text, "commands", "!"), false);
});
