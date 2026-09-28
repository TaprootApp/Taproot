// Formatting and parsing helpers. No date library; durations match the
// server's text-command syntax (server/src/lib/time.ts) so "10m", "2h",
// "1d12h" mean the same thing in the GUI as in chat.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

const UNIT_MS: Record<string, number> = { s: 1000, m: MINUTE, h: HOUR, d: DAY, w: WEEK };

/** "just now", "5m ago", "in 2h", "3d ago"; falls back to a date after 30 days. */
export function formatRelative(ms: number, now = Date.now()): string {
  if (!ms) return "never";
  const delta = ms - now;
  const abs = Math.abs(delta);
  if (abs < 45_000) return "just now";
  if (abs > 30 * DAY) return formatDate(ms);
  const text = formatDuration(abs, 1);
  return delta < 0 ? `${text} ago` : `in ${text}`;
}

/** "2026-10-01 18:00 UTC", the format the text commands use. */
export function formatUtc(ms: number): string {
  if (!ms) return "";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Local date and time, e.g. "Oct 1, 2026, 6:00 PM". */
export function formatDateTime(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Local date only, e.g. "Oct 1, 2026". */
export function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "1h 30m", "2d", "45s". Shows at most `parts` units; 0 gives "0s". */
export function formatDuration(ms: number, parts = 2): string {
  const out: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [label, size] of [
    ["w", 604_800],
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    if (rest >= size) {
      out.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
  }
  return out.length ? out.slice(0, parts).join(" ") : "0s";
}

/** Compact form for inputs: "1h30m". Inverse of parseDuration. */
export function durationToInput(ms: number): string {
  return ms > 0 ? formatDuration(ms, 5).replace(/ /g, "") : "";
}

/**
 * Parses "10m", "2h", "1d12h", "1w" (spaces allowed) into milliseconds.
 * Returns undefined for anything else, including zero.
 */
export function parseDuration(input: string): number | undefined {
  const text = input.replace(/\s+/g, "").toLowerCase();
  if (!/^(\d+[smhdw])+$/.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(amount) * UNIT_MS[unit];
  }
  return total > 0 ? total : undefined;
}

/** Value for <input type="datetime-local"> in the viewer's local time. */
export function toLocalInput(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses a datetime-local value (local time) to epoch ms; undefined if empty/invalid. */
export function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? undefined : ms;
}

/** "1 case", "3 cases". Pass `plural` for irregular words. */
export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? word : pluralWord}`;
}

/** Shortens text with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
