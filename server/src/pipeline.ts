import { ChannelMessageCreatedEvent } from "@rootsdk/server-app";
import { log, errMessage } from "./lib/log";

// Message pipeline for feature modules. main.ts runs, in order:
//   1. core auto-mod (may remove the message);
//   2. filters, highest priority first: a filter returns true when it removed
//      or fully handled the message, which stops everything after it
//      (e.g. auto-delete, slowmode, extra auto-mod rules);
//   3. the text-command router;
//   4. listeners, always, with wasCommand telling them whether step 3 ran a
//      command (e.g. XP, AFK, autoresponders, highlights, starboard counts).
// Every handler is isolated: one failing never stops the others.

type Filter = (evt: ChannelMessageCreatedEvent) => Promise<boolean>;
type Listener = (evt: ChannelMessageCreatedEvent, wasCommand: boolean) => Promise<void>;

const filters: Array<{ name: string; priority: number; fn: Filter }> = [];
const listeners: Array<{ name: string; fn: Listener }> = [];

export function addMessageFilter(name: string, fn: Filter, priority = 0): void {
  filters.push({ name, priority, fn });
  filters.sort((a, b) => b.priority - a.priority);
}

export function addMessageListener(name: string, fn: Listener): void {
  listeners.push({ name, fn });
}

export async function runMessageFilters(evt: ChannelMessageCreatedEvent): Promise<boolean> {
  for (const f of filters) {
    try {
      if (await f.fn(evt)) return true;
    } catch (err) {
      log("error", `message filter ${f.name} failed`, { error: errMessage(err) });
    }
  }
  return false;
}

export async function runMessageListeners(evt: ChannelMessageCreatedEvent, wasCommand: boolean): Promise<void> {
  await Promise.all(
    listeners.map((l) =>
      l.fn(evt, wasCommand).catch((err) => log("error", `message listener ${l.name} failed`, { error: errMessage(err) })),
    ),
  );
}
