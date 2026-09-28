import { RootServerException, RootServerExceptionType } from "@rootsdk/client-app";
import { TaprootError } from "@taproot/gen-shared";

// Turns anything an RPC can throw into one sentence for the UI.
//
// Taproot's server throws RootServerException with a positive TaprootError
// code and a message written for people (see server/src/services/auth.ts),
// so for those the server's message wins and the fallbacks below only cover
// an empty message. Negative codes are Root's own system errors; their
// messages are technical, so we always replace them.

const TAPROOT_FALLBACK: Record<number, string> = {
  [TaprootError.NOT_AUTHORIZED]: "You don't have permission to do that. If your roles just changed, refresh Taproot.",
  [TaprootError.INVALID_INPUT]: "Some of that input isn't valid. Check the fields and try again.",
  [TaprootError.NOT_FOUND]: "That no longer exists. It may have been removed by someone else.",
  [TaprootError.ACTION_FAILED]: "Root rejected that action. Check Taproot's role permissions and try again.",
};

const SYSTEM_MESSAGE: Record<number, string> = {
  [RootServerExceptionType.RequestTimeout]: "Taproot took too long to answer. Try again in a moment.",
  [RootServerExceptionType.RateLimitExceeded]: "That's a lot of requests at once. Wait a few seconds and try again.",
  [RootServerExceptionType.MessageTooLong]: "That message is too long for Root.",
};

/** The RootServerException code of an RPC failure, or undefined for other errors. */
export function errorCode(err: unknown): number | undefined {
  if (err instanceof RootServerException) return err.code;
  // Duck-type in case the exception crossed a module boundary.
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "number") {
    return (err as { code: number }).code;
  }
  return undefined;
}

/** True when the server said the caller's level is too low. */
export function isNotAuthorized(err: unknown): boolean {
  return errorCode(err) === TaprootError.NOT_AUTHORIZED;
}

/** Friendly one-line message for any RPC failure. */
export function errorMessage(err: unknown): string {
  const code = errorCode(err);
  const message = err instanceof Error ? err.message.trim() : typeof err === "string" ? err.trim() : "";
  if (code !== undefined && code > 0) {
    return message || TAPROOT_FALLBACK[code] || "Something went wrong. Try again.";
  }
  if (code !== undefined && code < 0) {
    return SYSTEM_MESSAGE[code] ?? "Something went wrong on Taproot's server. Try again.";
  }
  return message || "Something went wrong. Try again.";
}
