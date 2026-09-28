import type { EventsChangeEvent } from "@taproot/gen-shared";
import { EventsGiveawayState } from "@taproot/gen-shared";
import { eventsServiceClient, EventsServiceClientEvent } from "@taproot/gen-client";
import type { BadgeTone } from "../../components";
import { useBroadcast } from "../../lib";

// Bits shared by the events pages (giveaways, polls, starboard).

export type EventsArea = "events:giveaways" | "events:polls" | "events:starboard";

/** Calls `onChange` when the server broadcasts a change in `area` (or an event with no area). */
export function useEventsChanged(area: EventsArea, onChange: () => void): void {
  useBroadcast(eventsServiceClient, EventsServiceClientEvent.EventsChanged, () => onChange(), {
    filter: (event: EventsChangeEvent) => !event?.area || event.area === area,
  });
}

export const GIVEAWAY_STATE_LABEL: Record<EventsGiveawayState, string> = {
  [EventsGiveawayState.UNSPECIFIED]: "Unknown",
  [EventsGiveawayState.RUNNING]: "Running",
  [EventsGiveawayState.ENDED]: "Ended",
  [EventsGiveawayState.CANCELLED]: "Cancelled",
};

export const GIVEAWAY_STATE_TONE: Record<EventsGiveawayState, BadgeTone> = {
  [EventsGiveawayState.UNSPECIFIED]: "neutral",
  [EventsGiveawayState.RUNNING]: "success",
  [EventsGiveawayState.ENDED]: "brand",
  [EventsGiveawayState.CANCELLED]: "neutral",
};

/** Same limits as server/src/modules/events/logic.ts. */
export const LIMITS = {
  maxWinners: 50,
  maxPrize: 200,
  giveawayMaxMs: 90 * 86_400_000,
  pollMaxMs: 30 * 86_400_000,
  minOptions: 2,
  maxOptions: 10,
  maxQuestion: 300,
  maxOption: 100,
  maxThreshold: 100,
};

/** Number labels matching the reactions on the poll message. */
export const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** "#general", or a fallback when the channel is gone. */
export function channelLabel(name: string | undefined): string {
  return name && name !== "unknown channel" ? `#${name}` : "unknown channel";
}
