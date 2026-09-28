import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSeeChannel,
  cleanAfkMessage,
  Cooldowns,
  findKeywords,
  HighlightThrottle,
  matchesTrigger,
  normalizeKeyword,
  parseDice,
  parseRps,
  plainMentions,
  rollDice,
  rpsOutcome,
  splitChoices,
  triggerProblem,
  wildcardMatch,
} from "../src/modules/utility/logic";

test("autoresponder exact match ignores case and spacing", () => {
  assert.ok(matchesTrigger("Hello   There", "hello there", "exact"));
  assert.ok(!matchesTrigger("hello there!", "hello there", "exact"));
});

test("autoresponder contains matches whole words only", () => {
  assert.ok(matchesTrigger("I love PIZZA so much", "pizza", "contains"));
  assert.ok(matchesTrigger("pizza!", "pizza", "contains"));
  assert.ok(!matchesTrigger("pizzas are great", "pizza", "contains"));
  assert.ok(!matchesTrigger("this is it", "hi", "contains"));
  assert.ok(matchesTrigger("what?! no", "?!", "contains"));
});

test("autoresponder starts-with respects word edges", () => {
  assert.ok(matchesTrigger("good morning all", "good morning", "starts"));
  assert.ok(matchesTrigger("good morning", "good morning", "starts"));
  assert.ok(!matchesTrigger("hello", "hell", "starts"));
  assert.ok(!matchesTrigger("say good morning", "good morning", "starts"));
});

test("autoresponder wildcard matches the whole message", () => {
  assert.ok(matchesTrigger("where is the server ip?", "*server ip*", "wildcard"));
  assert.ok(matchesTrigger("how do I join", "how do i *", "wildcard"));
  assert.ok(!matchesTrigger("tell me how do I join", "how do i *", "wildcard"));
  assert.ok(matchesTrigger("a.b", "a.b", "wildcard"));
  assert.ok(!matchesTrigger("axb", "a.b", "wildcard"));
});

test("mention links are flattened before matching", () => {
  assert.equal(plainMentions("hi [@Alice](root://user/abc) and [@All](root://role/all)"), "hi @Alice and @All");
  assert.ok(!matchesTrigger("[@Bob](root://user/user123)", "user123", "contains"));
});

test("trigger validation", () => {
  assert.ok(triggerProblem("", "exact"));
  assert.ok(triggerProblem("***", "wildcard"));
  assert.equal(triggerProblem("hi *", "wildcard"), undefined);
});

test("cooldowns block until they expire", () => {
  const c = new Cooldowns();
  assert.ok(c.take("a", 10, 0));
  assert.ok(!c.take("a", 10, 5000));
  assert.ok(c.take("a", 10, 10_000));
  assert.ok(c.take("b", 10, 5000));
});

test("keywords normalize to lowercase words", () => {
  assert.deepEqual(normalizeKeyword("  Taproot  "), { keyword: "taproot" });
  assert.deepEqual(normalizeKeyword("Game   Night!"), { keyword: "game night" });
  assert.ok("problem" in normalizeKeyword("a"));
  assert.ok("problem" in normalizeKeyword("x".repeat(51)));
});

test("keywords match whole words and phrases", () => {
  const keys = ["taproot", "game night", "cat"];
  assert.deepEqual(findKeywords("Is TAPROOT down?", keys), ["taproot"]);
  assert.deepEqual(findKeywords("category theory", keys), []);
  assert.deepEqual(findKeywords("Game night is at 8", keys), ["game night"]);
  assert.deepEqual(findKeywords("the game is at night", keys), []);
  assert.deepEqual(findKeywords("[@Cat](root://user/taproot)", keys), ["cat"]);
});

test("highlight throttle: active members and repeat pings are skipped", () => {
  const t = new HighlightThrottle(300_000);
  t.notePost("c1", "u1", 0);
  assert.ok(!t.take("c1", "u1", 60_000), "posted a minute ago");
  assert.ok(t.take("c1", "u1", 301_000));
  assert.ok(!t.take("c1", "u1", 400_000), "pinged recently");
  assert.ok(t.take("c2", "u1", 400_000), "other channel is separate");
  assert.ok(t.take("c1", "u1", 602_000));
});

test("channel visibility follows access rules", () => {
  const everyone = "everyone";
  const subjects = new Set(["u1", everyone, "r1"]);
  assert.ok(canSeeChannel([{ subjectId: everyone, view: undefined }], "u1", subjects, false));
  assert.ok(canSeeChannel([{ subjectId: "r1", view: true }], "u1", subjects, false));
  assert.ok(!canSeeChannel([{ subjectId: "r2", view: true }], "u1", subjects, false), "private channel for another role");
  assert.ok(!canSeeChannel([], "u1", subjects, false));
  assert.ok(canSeeChannel([], "u1", subjects, true), "full control sees all");
  assert.ok(!canSeeChannel([{ subjectId: everyone, view: false }], "u1", subjects, false));
  assert.ok(canSeeChannel([{ subjectId: everyone, view: false }, { subjectId: "r1", view: true }], "u1", subjects, false));
  assert.ok(!canSeeChannel([{ subjectId: "r1", view: true }, { subjectId: "u1", view: false }], "u1", subjects, false));
});

test("AFK messages are cleaned", () => {
  assert.equal(cleanAfkMessage(""), "AFK");
  assert.equal(cleanAfkMessage("  lunch \n brb "), "lunch brb");
  assert.equal(cleanAfkMessage("ping [@All](root://role/all)"), "ping @All");
  assert.equal(cleanAfkMessage("x".repeat(500)).length, 200);
});

test("dice parsing and rolling", () => {
  assert.deepEqual(parseDice(undefined), { count: 1, sides: 6, modifier: 0 });
  assert.deepEqual(parseDice("d20"), { count: 1, sides: 20, modifier: 0 });
  assert.deepEqual(parseDice("3d8+2"), { count: 3, sides: 8, modifier: 2 });
  assert.deepEqual(parseDice("100"), { count: 1, sides: 100, modifier: 0 });
  assert.ok("problem" in parseDice("1000d6"));
  assert.ok("problem" in parseDice("2d1"));
  assert.ok("problem" in parseDice("banana"));
  const low = rollDice({ count: 3, sides: 6, modifier: 1 }, () => 0);
  assert.deepEqual(low, { rolls: [1, 1, 1], total: 4 });
  const high = rollDice({ count: 2, sides: 6, modifier: 0 }, () => 0.9999999);
  assert.deepEqual(high.rolls, [6, 6]);
});

test("choose and rps", () => {
  assert.deepEqual(splitChoices("pizza | tacos |  | sushi"), ["pizza", "tacos", "sushi"]);
  assert.deepEqual(splitChoices("a, b"), ["a", "b"]);
  assert.equal(parseRps("R"), "rock");
  assert.equal(parseRps("lizard"), undefined);
  assert.equal(rpsOutcome("rock", "scissors"), "win");
  assert.equal(rpsOutcome("rock", "paper"), "lose");
  assert.equal(rpsOutcome("paper", "paper"), "draw");
});

test("wildcard triggers match in linear time and keep their meaning", () => {
  assert.ok(wildcardMatch("abcxyz", "abc*xyz"));
  assert.ok(wildcardMatch("abcxyz", "*"));
  assert.ok(!wildcardMatch("a", "a*a"));
  assert.ok(wildcardMatch("aa", "a*a"));
  assert.ok(wildcardMatch("one two three", "one*two*three"));
  assert.ok(!wildcardMatch("one three two", "one*two*three"));
  assert.ok(!wildcardMatch("abc", "abd"));
  // Would take minutes as a ".*" regex (polynomial backtracking).
  const started = Date.now();
  assert.ok(!matchesTrigger("a".repeat(9000), "a*a*a*a*a*a*a*b", "wildcard"));
  assert.ok(Date.now() - started < 1000);
});
