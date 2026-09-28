import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/lib/time";
import {
  autoroleSchedule,
  DAY,
  isVoiceChannelType,
  joinedSince,
  MAX_TIMED_AUTOROLES,
  MINUTE,
  normalizeTimedAutoroles,
  notificationFor,
  parseNewDuration,
  totalAfterChange,
} from "../src/modules/modtools/logic";

test("normalizeTimedAutoroles rounds to minutes and sorts by delay", () => {
  const out = normalizeTimedAutoroles([
    { roleId: " b ", delayMs: DAY },
    { roleId: "a", delayMs: 10 * MINUTE + 20_000 },
  ]);
  assert.deepEqual(out, [
    { roleId: "a", delayMs: 10 * MINUTE },
    { roleId: "b", delayMs: DAY },
  ]);
});

test("normalizeTimedAutoroles rejects bad lists", () => {
  assert.equal(typeof normalizeTimedAutoroles([{ roleId: "", delayMs: MINUTE }]), "string");
  assert.equal(typeof normalizeTimedAutoroles([{ roleId: "a", delayMs: 10_000 }]), "string");
  assert.equal(typeof normalizeTimedAutoroles([{ roleId: "a", delayMs: 91 * DAY }]), "string");
  assert.equal(typeof normalizeTimedAutoroles([{ roleId: "a", delayMs: NaN }]), "string");
  assert.equal(
    typeof normalizeTimedAutoroles([
      { roleId: "a", delayMs: MINUTE },
      { roleId: "a", delayMs: DAY },
    ]),
    "string",
  );
  const many = Array.from({ length: MAX_TIMED_AUTOROLES + 1 }, (_, i) => ({ roleId: `r${i}`, delayMs: MINUTE }));
  assert.equal(typeof normalizeTimedAutoroles(many), "string");
});

test("notificationFor never includes a reason and fits Root's limits", () => {
  const n = notificationFor("warn", "Plant Club");
  assert.equal(n.description, "You received a warning in Plant Club.");
  const long = notificationFor("ban", "x".repeat(300));
  assert.ok(long.title.length <= 50);
  assert.ok(long.description.length <= 150);
  assert.match(notificationFor("mute", "  ").description, /the community/);
});

test("parseNewDuration accepts durations and 'no end' words", () => {
  assert.equal(parseNewDuration("2h", parseDuration), 7_200_000);
  assert.equal(parseNewDuration("perm", parseDuration), 0);
  assert.equal(parseNewDuration("Forever", parseDuration), 0);
  assert.equal(parseNewDuration("soon", parseDuration), undefined);
});

test("totalAfterChange adds time served to the new remainder", () => {
  assert.equal(totalAfterChange(1000, 61_000, 120_000), 180_000);
  assert.equal(totalAfterChange(1000, 61_000, 0), 0);
  assert.equal(totalAfterChange(5000, 1000, 10), 10);
});

test("isVoiceChannelType reads the voice flag", () => {
  assert.equal(isVoiceChannelType(4), true);
  assert.equal(isVoiceChannelType(1 | 4), true);
  assert.equal(isVoiceChannelType(1), false);
  assert.equal(isVoiceChannelType(8), false);
});

test("joinedSince and autoroleSchedule", () => {
  const members = [
    { id: "a", joinedAtMs: 100 },
    { id: "b", joinedAtMs: 300 },
  ];
  assert.deepEqual(
    joinedSince(members, 200).map((m) => m.id),
    ["b"],
  );
  assert.deepEqual(autoroleSchedule([{ roleId: "r", delayMs: 50 }], 1000), [{ roleId: "r", dueAt: 1050 }]);
});
