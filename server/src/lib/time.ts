// Duration parsing and formatting. Pure functions (no SDK imports) so they
// can be unit tested without a Root connection.

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses "10m", "2h30m", "1d", "1w2d". Returns milliseconds, or undefined. */
export function parseDuration(input: string): number | undefined {
  const text = input.trim().toLowerCase();
  if (!/^(\d+[smhdw])+$/.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(amount) * UNIT_MS[unit];
  }
  return total > 0 ? total : undefined;
}

/**
 * Parses a point in time: a duration from now ("2h"), or a UTC date-time
 * ("2026-10-01T18:00" or "2026-10-01 18:00"; the space form arrives as two
 * tokens, so callers pass them joined).
 */
export function parseWhen(input: string, now = Date.now()): Date | undefined {
  const ms = parseDuration(input);
  if (ms !== undefined) return new Date(now + ms);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return isNaN(date.getTime()) ? undefined : date;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [label, size] of [
    ["w", 604_800],
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
  }
  return parts.length ? parts.slice(0, 2).join(" ") : "0s";
}

/** "2026-10-01 18:00 UTC" */
export function formatUtc(date: Date | number): string {
  const d = new Date(date);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
