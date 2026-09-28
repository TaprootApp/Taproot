import { test } from "node:test";
import assert from "node:assert/strict";
import { emojiAsTyped } from "../src/features/emoji";
import { normalizeDomain, validPrefix } from "../src/lib/validate";

test("validPrefix allows 1-3 characters without spaces or brackets", () => {
  for (const ok of ["!", "?", "t!", "$$$"]) assert.equal(validPrefix(ok), true, ok);
  for (const bad of [undefined, "", "abcd", "a b", "(", "[", "]", ")"]) assert.equal(validPrefix(bad), false, String(bad));
});

test("normalizeDomain strips scheme and path", () => {
  assert.equal(normalizeDomain("https://youtube.com/watch?v=1"), "youtube.com");
  assert.equal(normalizeDomain("http://example.org"), "example.org");
  assert.equal(normalizeDomain("docs.rootapp.com/path"), "docs.rootapp.com");
  assert.equal(normalizeDomain("localhost"), undefined);
  assert.equal(normalizeDomain(""), undefined);
  assert.equal(normalizeDomain(undefined), undefined);
});

test("emojiAsTyped gives the :name: form", () => {
  assert.equal(emojiAsTyped(":tada:"), ":tada:");
  assert.equal(emojiAsTyped(":thumbsup::skin-tone-2:"), ":thumbsup:");
  assert.equal(emojiAsTyped("tada"), ":tada:");
  assert.equal(emojiAsTyped(""), "");
});
