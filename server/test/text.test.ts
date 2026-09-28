import { test } from "node:test";
import assert from "node:assert/strict";
import { fillTemplate, truncate, userMention } from "../src/lib/text";

test("fillTemplate replaces known placeholders only", () => {
  assert.equal(fillTemplate("Hi {user.name}, welcome to {SERVER}! {unknown}", { "user.name": "Ann", server: "Garden" }), "Hi Ann, welcome to Garden! {unknown}");
});

test("mentions strip brackets that would break the link", () => {
  assert.equal(userMention("[x] Bob", "u1"), "[@x Bob](root://user/u1)");
});

test("truncate", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});
