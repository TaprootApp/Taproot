import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, tokenize } from "../src/commands/parse";

test("mentions become single typed tokens", () => {
  const tokens = tokenize("warn [@Big Bob](root://user/abc123) spamming links");
  assert.deepEqual(
    tokens.map((t) => [t.kind, t.text, t.id]),
    [
      ["word", "warn", undefined],
      ["user", "@Big Bob", "abc123"],
      ["word", "spamming", undefined],
      ["word", "links", undefined],
    ],
  );
});

test("channel, role and emoji links are recognised", () => {
  const kinds = tokenize("[#general](root://channel/c1) [@Mods](root://role/r1) [:logo:](root://emoji/:logo:)").map((t) => [t.kind, t.id]);
  assert.deepEqual(kinds, [
    ["channel", "c1"],
    ["role", "r1"],
    ["emoji", ":logo:"],
  ]);
});

test("a mention glued to a word is split off", () => {
  const tokens = tokenize("hi[@Bob](root://user/u1)");
  assert.deepEqual(tokens.map((t) => t.kind), ["word", "user"]);
});

test("parseCommand requires the prefix and lowercases the name", () => {
  assert.equal(parseCommand("hello !ban", "!"), undefined);
  assert.equal(parseCommand("! ban", "!"), undefined);
  const parsed = parseCommand("  !BAN [@Bob](root://user/u1) 7d being rude", "!")!;
  assert.equal(parsed.name, "ban");
  assert.equal(parsed.args.mention("user")?.id, "u1");
  assert.equal(parsed.args.word(), "7d");
  assert.equal(parsed.args.rest(), "being rude");
});

test("rest() keeps original text including mentions", () => {
  const parsed = parseCommand("?cc add hi Hello [@Ann](root://user/u2)!", "?")!;
  assert.equal(parsed.args.word(), "add");
  assert.equal(parsed.args.word(), "hi");
  assert.equal(parsed.args.rest(), "Hello [@Ann](root://user/u2)!");
});

test("mention() does not consume the wrong kind", () => {
  const parsed = parseCommand("!mute [@Bob](root://user/u1)", "!")!;
  assert.equal(parsed.args.mention("channel"), undefined);
  assert.equal(parsed.args.mention("user")?.id, "u1");
  assert.equal(parsed.args.remaining, 0);
});
