import { Client, RootServerException } from "@rootsdk/server-app";
import { TaprootError } from "@taproot/gen-shared";
import { describeError } from "../lib/api";
import { Level, levelOf } from "../permissions";

// Shared guards for every RPC. The GUI hides what a member can't use, but the
// server is the real gate: every handler calls requireLevel first.

export async function requireLevel(client: Client, level: Level): Promise<Level> {
  const actual = await levelOf(client.userId);
  if (actual < level) throw new RootServerException(TaprootError.NOT_AUTHORIZED, "You don't have permission to do that.");
  return actual;
}

export function invalid(message: string): never {
  throw new RootServerException(TaprootError.INVALID_INPUT, message);
}

export function notFound(message: string): never {
  throw new RootServerException(TaprootError.NOT_FOUND, message);
}

/** Runs a Root API action; failures become ACTION_FAILED with a readable message. */
export async function act<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof RootServerException) throw err;
    throw new RootServerException(TaprootError.ACTION_FAILED, describeError(err));
  }
}
