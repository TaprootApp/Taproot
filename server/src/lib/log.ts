// Console output lands in the Root Developer Portal's Logs tab (one log per
// community instance) when the community has developer logging enabled.

type Level = "info" | "warn" | "error";

export function log(level: Level, message: string, fields?: Record<string, unknown>): void {
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  if (level === "error") console.error(`[taproot] ${line}`);
  else if (level === "warn") console.warn(`[taproot] ${line}`);
  else console.log(`[taproot] ${line}`);
}

export function errMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // RootApiException's message is just "root-error"; the code says what happened.
  // Duck-typed so this file stays free of SDK imports.
  const code = (err as { errorCode?: unknown } | null)?.errorCode;
  return code === undefined ? message : `${message} (errorCode ${String(code)})`;
}
