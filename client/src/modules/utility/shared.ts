import type { UtilityChangeEvent } from "@taproot/gen-shared";
import { utilityServiceClient, UtilityServiceClientEvent } from "@taproot/gen-client";
import { useBroadcast } from "../../lib";

// Change feed for the utility module's views. The server sends
// "utility:autoresponders" to staff, and "utility:afk" / "utility:highlights"
// only to the member they belong to.

export function useUtilityChanged(areas: string[], onChange: () => void): void {
  useBroadcast(utilityServiceClient, UtilityServiceClientEvent.UtilityChanged, () => onChange(), {
    filter: (event: UtilityChangeEvent) => !event?.area || areas.includes(event.area),
  });
}

/** Mirrors server/src/modules/utility/logic.ts. */
export const MAX_TRIGGER = 200;
export const MAX_RESPONSE = 2000;
export const MAX_AFK_MESSAGE = 200;
export const MAX_KEYWORD = 50;
