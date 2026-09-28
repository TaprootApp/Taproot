// Tiny change feed so feature code (text commands, auto-mod, jobs) can tell
// the GUI something changed without importing the services. Each service
// subscribes and turns notifications into its Broadcast* RPC.

export type ChangeArea =
  | "general"
  | "welcome"
  | "automod"
  | "cases"
  | "punishments"
  | "commands"
  | "panels"
  | "announcements"
  | "selfroles"
  | "reminders"
  // Feature modules (server/src/modules) use their own area names.
  | (string & {});

type Listener = (area: ChangeArea) => void;
const listeners: Listener[] = [];

export function onChange(listener: Listener): void {
  listeners.push(listener);
}

export function notifyChange(area: ChangeArea): void {
  for (const listener of listeners) {
    try {
      listener(area);
    } catch {
      // A failed broadcast must never break the action that caused it.
    }
  }
}
