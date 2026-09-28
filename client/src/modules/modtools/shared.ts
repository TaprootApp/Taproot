import { modtoolsServiceClient, ModtoolsServiceClientEvent } from "@taproot/gen-client";
import { useBroadcast } from "../../lib";

// Shared bits for the mod tools views.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** Mirrors server/src/modules/modtools/logic.ts. */
export const MAX_NOTE = 1000;
export const MAX_TEMP_ROLE = 365 * DAY;
export const MAX_AUTOROLE_DELAY = 90 * DAY;
export const MAX_TIMED_AUTOROLES = 10;
export const MAX_CHANGED_DURATION = 5 * 365 * DAY;

export type ModtoolsArea = "notes" | "temproles" | "voice" | "config";

/** Runs `callback` when the server says one of `areas` changed. */
export function useModtoolsChanged(areas: ModtoolsArea[], callback: () => void): void {
  useBroadcast(modtoolsServiceClient, ModtoolsServiceClientEvent.ModtoolsChanged, callback, {
    filter: (event) => areas.includes(event.area as ModtoolsArea),
  });
}
