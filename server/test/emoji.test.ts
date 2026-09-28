import { test } from "node:test";
import assert from "node:assert/strict";
import { emojiDisplay, shortcodeToUnicode } from "../src/features/emoji";

test("shortcodeToUnicode maps standard shortcodes, including aliases", () => {
  assert.equal(shortcodeToUnicode(":tada:"), "🎉");
  assert.equal(shortcodeToUnicode(":video_game:"), "🎮");
  assert.equal(shortcodeToUnicode(":+1:"), "👍");
  assert.equal(shortcodeToUnicode(":thumbsup:"), "👍");
  assert.equal(shortcodeToUnicode(":one:"), "1️⃣");
  assert.equal(shortcodeToUnicode(":keycap_ten:"), "🔟");
});

test("shortcodeToUnicode falls back to the original text", () => {
  assert.equal(shortcodeToUnicode(":not_an_emoji_xyz:"), ":not_an_emoji_xyz:");
  assert.equal(shortcodeToUnicode(":constructor:"), ":constructor:");
  assert.equal(shortcodeToUnicode("tada"), "tada");
  assert.equal(shortcodeToUnicode(":party:abc123:"), ":party:abc123:");
});

test("emojiDisplay: Unicode for standard emoji, a link for community emoji", () => {
  assert.equal(emojiDisplay(":art:"), "🎨");
  assert.equal(emojiDisplay(":party:abc123:"), "[:party:](root://emoji/:party:)");
});
