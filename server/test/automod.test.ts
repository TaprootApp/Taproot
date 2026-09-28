import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMessage, findBannedWord, hostOf, isAllowedHost, MessageFacts, SpamTracker } from "../src/features/automodRules";
import { emojiKey } from "../src/features/emoji";
import type { AutomodConfig } from "../src/settings";

function config(overrides: Partial<AutomodConfig> = {}): AutomodConfig {
  return {
    enabled: true,
    words: { enabled: false, list: [] },
    links: { enabled: false, allow: [] },
    mentions: { enabled: false, max: 5, blockAll: true },
    spam: { enabled: false, messages: 5, seconds: 5, duplicates: 3 },
    caps: { enabled: false, percent: 70, minLength: 12 },
    strikes: { count: 3, windowMinutes: 10, muteMinutes: 10 },
    ignoredChannels: [],
    ...overrides,
  };
}

function facts(content: string, extra: Partial<MessageFacts> = {}): MessageFacts {
  return { userId: "u1", content, uris: [], mentionedUserIds: [], mentionedRoleIds: [], at: Date.now(), ...extra };
}

test("banned words match whole words, case-insensitively", () => {
  assert.equal(findBannedWord("you are a JERK", ["jerk"]), "jerk");
  assert.equal(findBannedWord("jerky is tasty", ["jerk"]), undefined);
  assert.equal(findBannedWord("jerk!", ["jerk"]), "jerk");
});

test("wildcards and character swaps", () => {
  assert.equal(findBannedWord("total spammer here", ["spam*"]), "spam*");
  assert.equal(findBannedWord("j3rk", ["jerk"]), "jerk");
  assert.equal(findBannedWord("antispam", ["*spam"]), "*spam");
});

test("mention link IDs don't trigger the word filter", () => {
  assert.equal(findBannedWord("hi [@Pal](root://user/jerk123)", ["jerk123"]), undefined);
});

test("link allowlist includes subdomains", () => {
  assert.equal(hostOf("https://www.YouTube.com/watch?v=1"), "www.youtube.com");
  assert.ok(isAllowedHost("www.youtube.com", ["youtube.com"]));
  assert.ok(!isAllowedHost("notyoutube.com", ["youtube.com"]));
});

test("links rule blocks external links, including bare domains", () => {
  const c = config({ links: { enabled: true, allow: ["youtube.com"] } });
  const t = new SpamTracker();
  assert.equal(checkMessage(facts("see https://evil.xyz", { uris: ["https://evil.xyz"] }), c, t)?.rule, "links");
  assert.equal(checkMessage(facts("go to scam-site.com/free now"), c, t)?.rule, "links");
  assert.equal(checkMessage(facts("watch https://youtube.com/x", { uris: ["https://youtube.com/x"] }), c, t), undefined);
  assert.equal(checkMessage(facts("open notes.txt please"), c, t), undefined);
  assert.equal(checkMessage(facts("in [#general](root://channel/abc)", { uris: ["root://channel/abc"] }), c, t), undefined);
});

test("mention rule: @All and too many mentions", () => {
  const c = config({ mentions: { enabled: true, max: 3, blockAll: true } });
  const t = new SpamTracker();
  assert.equal(checkMessage(facts("hey", { mentionedRoleIds: ["All"] }), c, t)?.rule, "mentions");
  assert.equal(checkMessage(facts("hey", { mentionedUserIds: ["a", "b", "c", "d"] }), c, t)?.rule, "mentions");
  assert.equal(checkMessage(facts("hey", { mentionedUserIds: ["a", "a", "b"] }), c, t), undefined);
});

test("caps rule needs enough letters", () => {
  const c = config({ caps: { enabled: true, percent: 70, minLength: 12 } });
  const t = new SpamTracker();
  assert.equal(checkMessage(facts("WHY IS NOBODY ANSWERING"), c, t)?.rule, "caps");
  assert.equal(checkMessage(facts("LOL OK"), c, t), undefined);
});

test("spam rule: rate and duplicates", () => {
  const c = config({ spam: { enabled: true, messages: 3, seconds: 5, duplicates: 3 } });
  const t = new SpamTracker();
  const start = 1_000_000;
  const results = [0, 1, 2, 3].map((i) => checkMessage(facts(`msg ${i}`, { at: start + i * 100 }), c, t)?.rule);
  assert.deepEqual(results, [undefined, undefined, undefined, "spam"]);

  const t2 = new SpamTracker();
  const dupes = [0, 10_000, 20_000].map((ms) => checkMessage(facts("buy now", { at: start + ms }), c, t2)?.rule);
  assert.deepEqual(dupes, [undefined, undefined, "duplicates"]);
});

test("emoji keys match reactions to typed shortcodes", () => {
  assert.equal(emojiKey(":thumbsup:"), "thumbsup");
  assert.equal(emojiKey(":Logo:abc123:"), "logo");
});
