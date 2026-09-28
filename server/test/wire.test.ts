import { test } from "node:test";
import assert from "node:assert/strict";
import { CaseAction as ProtoCaseAction, PunishmentType, Repeat as ProtoRepeat } from "@taproot/gen-shared";
import type { ModCase } from "../src/modlog";
import type { Settings } from "../src/settings";
import {
  CASE_ACTION_TO_WIRE,
  caseActionFromWire,
  punishmentFromWire,
  REPEAT_TO_WIRE,
  repeatFromWire,
  toWireCase,
  toWireConfig,
  toWireWarnAction,
} from "../src/services/wire";

test("case actions map to distinct proto values and back", () => {
  const values = Object.values(CASE_ACTION_TO_WIRE);
  assert.equal(new Set(values).size, values.length);
  assert.ok(!values.includes(ProtoCaseAction.UNSPECIFIED));
  for (const [action, wire] of Object.entries(CASE_ACTION_TO_WIRE)) {
    assert.equal(caseActionFromWire(wire), action);
  }
  assert.equal(caseActionFromWire(ProtoCaseAction.UNSPECIFIED), undefined);
  assert.equal(caseActionFromWire(99 as ProtoCaseAction), undefined);
});

test("toWireCase converts nulls and flags", () => {
  const row: ModCase = {
    id: 7,
    action: "mute",
    user_id: "u",
    user_name: "Bob",
    moderator_id: "",
    moderator_name: "",
    reason: "spam",
    duration_ms: null,
    voided: 1,
    created_at: 1_700_000_000_000,
  };
  assert.deepEqual(toWireCase(row), {
    id: 7,
    action: ProtoCaseAction.MUTE,
    userId: "u",
    userName: "Bob",
    moderatorId: "",
    moderatorName: "",
    reason: "spam",
    durationMs: 0,
    voided: true,
    createdAtMs: 1_700_000_000_000,
  });
  assert.equal(toWireCase({ ...row, voided: 0, duration_ms: 3_600_000 }).durationMs, 3_600_000);
  assert.equal(toWireCase({ ...row, voided: 0 }).voided, false);
});

test("warn punishments round-trip", () => {
  assert.equal(punishmentFromWire(PunishmentType.MUTE), "mute");
  assert.equal(punishmentFromWire(PunishmentType.KICK), "kick");
  assert.equal(punishmentFromWire(PunishmentType.BAN), "ban");
  assert.equal(punishmentFromWire(PunishmentType.UNSPECIFIED), undefined);
  assert.deepEqual(toWireWarnAction({ warn_count: 3, action: "kick", duration_ms: null }), {
    warnCount: 3,
    action: PunishmentType.KICK,
    durationMs: 0,
  });
  assert.equal(toWireWarnAction({ warn_count: 5, action: "ban", duration_ms: 86_400_000 }).durationMs, 86_400_000);
});

test("announcement repeats round-trip", () => {
  for (const [repeat, wire] of Object.entries(REPEAT_TO_WIRE)) assert.equal(repeatFromWire(wire), repeat);
  assert.equal(repeatFromWire(ProtoRepeat.ONCE), "once");
  assert.equal(repeatFromWire(42 as ProtoRepeat), undefined);
});

test("toWireConfig copies every setting", () => {
  const s: Settings = {
    prefix: "?",
    modLogChannel: null,
    selfRoles: ["r1"],
    welcomeChannel: "c1",
    welcomeMessage: "Hi {user}",
    goodbyeChannel: null,
    goodbyeMessage: "Bye",
    autoroles: ["r2"],
    automod: {
      enabled: true,
      words: { enabled: true, list: ["bad"] },
      links: { enabled: false, allow: ["example.com"] },
      mentions: { enabled: true, max: 5, blockAll: false },
      spam: { enabled: true, messages: 6, seconds: 4, duplicates: 3 },
      caps: { enabled: false, percent: 70, minLength: 12 },
      strikes: { count: 3, windowMinutes: 10, muteMinutes: 15 },
      ignoredChannels: ["c9"],
    },
  };
  const config = toWireConfig(s);
  assert.deepEqual(config.general, { prefix: "?", modLogChannelId: undefined, selfRoleIds: ["r1"] });
  assert.deepEqual(config.welcome, {
    welcomeChannelId: "c1",
    welcomeMessage: "Hi {user}",
    goodbyeChannelId: undefined,
    goodbyeMessage: "Bye",
    autoroleIds: ["r2"],
  });
  assert.equal(config.automod?.maxMentions, 5);
  assert.equal(config.automod?.blockAllMentions, false);
  assert.equal(config.automod?.spamMessages, 6);
  assert.equal(config.automod?.strikeMuteMinutes, 15);
  assert.deepEqual(config.automod?.words, ["bad"]);
  assert.deepEqual(config.automod?.ignoredChannelIds, ["c9"]);
  // Copies, not the cached settings' own arrays.
  config.automod!.words.push("x");
  assert.deepEqual(s.automod.words.list, ["bad"]);
});
