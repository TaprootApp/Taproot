import { RootApiException, ErrorCodeType } from "@rootsdk/server-app";
import { log } from "./log";

// Root limits state-changing calls (create/edit/delete, kicks, bans, role
// changes) to about 5 per second and returns TooManyRequests with no
// retry-after hint. Every write goes through one shared token bucket so a spam
// wave or a purge can't starve the rest of the bot, and transient failures are
// retried with exponential backoff and full jitter.

const CAPACITY = 5;
const REFILL_PER_SEC = 5;
const MAX_PENDING = 500;

let tokens = CAPACITY;
let lastRefill = Date.now();
const pending: Array<() => void> = [];
let drainTimer: ReturnType<typeof setTimeout> | undefined;

function refill(): void {
  const now = Date.now();
  tokens = Math.min(CAPACITY, tokens + ((now - lastRefill) / 1000) * REFILL_PER_SEC);
  lastRefill = now;
}

function drain(): void {
  drainTimer = undefined;
  refill();
  while (tokens >= 1 && pending.length > 0) {
    tokens -= 1;
    pending.shift()!();
  }
  if (pending.length > 0) {
    const waitMs = Math.max(1, Math.ceil(((1 - tokens) / REFILL_PER_SEC) * 1000));
    drainTimer = setTimeout(drain, waitMs);
  }
}

function acquireToken(): Promise<void> {
  refill();
  if (tokens >= 1 && pending.length === 0) {
    tokens -= 1;
    return Promise.resolve();
  }
  if (pending.length >= MAX_PENDING) {
    return Promise.reject(new Error("Write queue is full"));
  }
  return new Promise((resolve) => {
    pending.push(resolve);
    if (!drainTimer) drain();
  });
}

const RETRYABLE = new Set([
  ErrorCodeType.TooManyRequests,
  ErrorCodeType.ServerError,
  ErrorCodeType.Timeout,
  ErrorCodeType.StillProcessing,
  ErrorCodeType.ServiceUnavailable,
]);

function isRetryable(err: unknown): boolean {
  return err instanceof RootApiException && RETRYABLE.has(err.errorCode);
}

async function withRetry<T>(label: string, op: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      const delay = Math.random() * Math.min(1000 * 2 ** attempt, 15000);
      log("warn", `${label}: retry ${attempt + 1}/${maxRetries}`, {
        errorCode: err instanceof RootApiException ? ErrorCodeType[err.errorCode] : undefined,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** A state-changing SDK call: rate limited and retried. */
export async function write<T>(label: string, op: () => Promise<T>): Promise<T> {
  return withRetry(label, async () => {
    await acquireToken();
    return op();
  });
}

/** A read-only SDK call: retried, not rate limited (reads allow ~20/s). */
export function read<T>(label: string, op: () => Promise<T>): Promise<T> {
  return withRetry(label, op);
}

export function errorCode(err: unknown): ErrorCodeType | undefined {
  return err instanceof RootApiException ? err.errorCode : undefined;
}

/** Turns an SDK failure into a sentence a moderator can act on. */
export function describeError(err: unknown): string {
  if (!(err instanceof RootApiException)) {
    return err instanceof Error ? err.message : "Something went wrong.";
  }
  switch (err.errorCode) {
    case ErrorCodeType.NoPermissionToBan:
      return "I can't ban that member (the owner and other bots can't be banned).";
    case ErrorCodeType.NoPermissionToKick:
      return "I can't kick that member (the owner and other bots can't be kicked).";
    case ErrorCodeType.NoPermissionToAdd:
    case ErrorCodeType.NoPermissionToCreate:
    case ErrorCodeType.NoPermissionToEdit:
    case ErrorCodeType.NoPermissionToDelete:
    case ErrorCodeType.NoPermissionToRead:
      return "I don't have permission to do that here. Check Taproot's role and channel permissions.";
    case ErrorCodeType.NotFound:
      return "I couldn't find that (it may have been deleted).";
    case ErrorCodeType.TooManyRequests:
      return "Root is rate limiting me. Try again in a few seconds.";
    case ErrorCodeType.RequestValidationFailed:
      return "Root rejected that request as invalid.";
    default:
      return `Root returned an error (${ErrorCodeType[err.errorCode] ?? err.errorCode}).`;
  }
}
