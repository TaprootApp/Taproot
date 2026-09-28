import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, formatUtc, parseDuration, parseWhen } from "../src/lib/time";

test("parseDuration handles single and compound units", () => {
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("2h30m"), 9_000_000);
  assert.equal(parseDuration("1w"), 604_800_000);
  assert.equal(parseDuration("1D"), 86_400_000);
});

test("parseDuration rejects non-durations", () => {
  for (const bad of ["", "10", "m", "ten minutes", "10x", "0m", "-5m", "spam"]) {
    assert.equal(parseDuration(bad), undefined, bad);
  }
});

test("parseWhen reads durations and UTC date-times", () => {
  const now = Date.UTC(2026, 8, 28, 12, 0);
  assert.equal(parseWhen("2h", now)!.getTime(), now + 7_200_000);
  assert.equal(parseWhen("2026-10-01T18:00", now)!.toISOString(), "2026-10-01T18:00:00.000Z");
  assert.equal(parseWhen("2026-10-01 9:05", now)!.toISOString(), "2026-10-01T09:05:00.000Z");
  assert.equal(parseWhen("tomorrow", now), undefined);
});

test("formatDuration shows the two largest units", () => {
  assert.equal(formatDuration(600_000), "10m");
  assert.equal(formatDuration(90_061_000), "1d 1h");
  assert.equal(formatDuration(0), "0s");
});

test("formatUtc", () => {
  assert.equal(formatUtc(Date.UTC(2026, 9, 1, 18, 0)), "2026-10-01 18:00 UTC");
});
