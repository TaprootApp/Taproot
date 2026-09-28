import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageCache } from "../src/modules/logs/cache";
import { defaultLogsConfig, resolveEventNames, targetChannel } from "../src/modules/logs/events";
import { codeBlock, quote, renderAnnouncement, roleChanges, RoleSnapshot } from "../src/modules/logs/format";
import { LogQueue } from "../src/modules/logs/queue";
import { fromWireLogsConfig, toWireLogsConfig } from "../src/modules/logs/wire";

test("event names resolve by key, alias, group and all", () => {
  assert.deepEqual(resolveEventNames("delete"), ["messageDelete"]);
  assert.deepEqual(resolveEventNames("messageEdit"), ["messageEdit"]);
  assert.deepEqual(resolveEventNames("voice"), ["voiceJoin", "voiceLeave"]);
  assert.deepEqual(resolveEventNames("role"), ["roleCreate", "roleEdit", "roleDelete"]);
  assert.equal(resolveEventNames("all").length, 17);
  assert.deepEqual(resolveEventNames("nope"), []);
});

test("target channel: off without a channel, override wins, disabled is null", () => {
  const c = defaultLogsConfig();
  assert.equal(targetChannel(c, "messageDelete"), null);
  c.channel = "log";
  assert.equal(targetChannel(c, "messageDelete"), "log");
  assert.equal(targetChannel(c, "voiceJoin"), null, "voice starts off");
  c.events.messageDelete.channel = "deletes";
  assert.equal(targetChannel(c, "messageDelete"), "deletes");
  c.events.messageDelete.enabled = false;
  assert.equal(targetChannel(c, "messageDelete"), null);
});

test("message cache is bounded by count and age", () => {
  let now = 0;
  const cache = new MessageCache(3, 1000, 5, () => now);
  for (const id of ["a", "b", "c", "d"]) cache.set(id, { channelId: "ch", userId: "u", content: `hello ${id}` });
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b")?.content, "hello", "content is cut to the max length");
  now = 2000;
  assert.equal(cache.get("b"), undefined, "expired");
  cache.set("e", { channelId: "other", userId: "u", content: "x" });
  assert.equal(cache.size, 1, "old entries pruned on insert");
  assert.equal(cache.take("e")?.content, "x");
  assert.equal(cache.get("e"), undefined);
});

test("code blocks survive backticks and quote notes missing content", () => {
  assert.equal(codeBlock("hi"), "```\nhi\n```");
  assert.equal(codeBlock("a ``` b"), "````\na ``` b\n````");
  assert.match(quote(undefined), /not available/);
  assert.match(quote("  "), /attachments only/);
});

test("role changes list only what differs", () => {
  const base: RoleSnapshot = { name: "Mods", colorHex: "#fff", isMentionable: false, isSelfAssignable: false, permissions: "[]" };
  assert.deepEqual(roleChanges(base, { ...base }), []);
  const changes = roleChanges(base, { ...base, name: "Staff", permissions: "[1]" });
  assert.equal(changes.length, 2);
  assert.match(changes[0], /Mods → Staff/);
});

test("announcements fill placeholders and default the reason", () => {
  const text = renderAnnouncement("{user.name} ({user.id}) banned: {reason}", { name: "Ann", userId: "u1", reason: " ", server: "S" });
  assert.equal(text, "Ann (u1) banned: No reason given");
});

function fakeQueue(options: { perMinute?: number; burst?: number; maxPending?: number } = {}) {
  let now = 0;
  const sent: Array<{ channelId: string; content: string }> = [];
  const timers: Array<() => void> = [];
  const queue = new LogQueue({
    send: async (channelId, content) => void sent.push({ channelId, content }),
    now: () => now,
    setTimer: (fn) => void timers.push(fn),
    ...options,
  });
  return { queue, sent, timers, advance: (ms: number) => (now += ms) };
}

test("queue batches a burst into one message per channel", async () => {
  const { queue, sent, timers } = fakeQueue();
  queue.push("a", "one");
  queue.push("a", "two");
  queue.push("b", "three");
  assert.equal(timers.length, 1, "one timer for the burst");
  await queue.flush();
  assert.deepEqual(sent, [
    { channelId: "a", content: "one\n\ntwo" },
    { channelId: "b", content: "three" },
  ]);
  assert.equal(queue.backlog, 0);
});

test("queue drops past the backlog cap and says how many", async () => {
  const { queue, sent } = fakeQueue({ maxPending: 2 });
  for (let i = 0; i < 5; i++) queue.push("a", `e${i}`);
  await queue.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^e0\n\ne1\n\n⚠️ 3 more events weren't logged/);
});

test("queue respects the message budget", async () => {
  const { queue, sent, advance } = fakeQueue({ burst: 1, perMinute: 1 });
  queue.push("a", "x");
  queue.push("b", "y");
  await queue.flush();
  assert.equal(sent.length, 1);
  assert.equal(queue.backlog, 1);
  advance(60_000);
  await queue.flush();
  assert.equal(sent.length, 2);
});

test("wire config round-trips and validates templates", () => {
  const c = defaultLogsConfig();
  c.channel = "log";
  c.events.voiceJoin = { enabled: true, channel: "voice-log" };
  const wire = toWireLogsConfig(c);
  const back = fromWireLogsConfig(wire, defaultLogsConfig());
  assert.ok(!("error" in back));
  if ("error" in back) return;
  assert.deepEqual(back.next, c);
  assert.deepEqual(back.channelIds.sort(), ["log", "voice-log"]);

  const bad = fromWireLogsConfig({ ...wire, announcements: { ...wire.announcements!, banTemplate: " " } }, c);
  assert.ok("error" in bad);
});
