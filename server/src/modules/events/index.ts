import {
  rootServer,
  ChannelMessageEvent,
  ChannelMessageReactionCreatedEvent,
  ChannelMessageReactionDeletedEvent,
} from "@rootsdk/server-app";
import { log, errMessage } from "../../lib/log";
import { loadModuleConfig } from "../../settings";
import type { TaprootModule } from "../types";
import { initGiveawayTables, onGiveawayMessageDeleted, onGiveawayReaction, registerGiveaways } from "./giveaways";
import { initPollTables, onPollMessageDeleted, onPollReaction, registerPolls } from "./polls";
import { eventsService } from "./service";
import { MODULE } from "./shared";
import {
  EVENTS_DEFAULTS,
  initStarboardTables,
  onStarReaction,
  onStarredDeleted,
  onStarredEdited,
  registerStarboard,
} from "./starboard";

// Events module: giveaways, reaction polls and the starboard. All three are
// driven by reactions, so one pair of reaction listeners fans out to each.

type ReactionEvent = ChannelMessageReactionCreatedEvent | ChannelMessageReactionDeletedEvent;

async function onReaction(evt: ReactionEvent, added: boolean): Promise<void> {
  // Each feature is isolated: one failing never stops the others.
  const steps: Array<[string, () => Promise<void>]> = [
    ["giveaway", () => onGiveawayReaction(evt.messageId, evt.userId, evt.shortcode, added)],
    ["poll", () => onPollReaction(evt.messageId, evt.userId, evt.shortcode, added)],
    ["starboard", () => onStarReaction(evt.channelId, evt.messageId, evt.shortcode)],
  ];
  for (const [name, step] of steps) {
    await step().catch((err) => log("error", `events ${name} reaction failed`, { error: errMessage(err) }));
  }
}

export const module: TaprootModule = {
  name: MODULE,
  services: [eventsService],
  async init() {
    await initGiveawayTables();
    await initPollTables();
    await initStarboardTables();
    await loadModuleConfig(MODULE, EVENTS_DEFAULTS);

    registerGiveaways();
    registerPolls();
    registerStarboard();

    // Handlers never throw: an unhandled rejection restarts the server.
    const messages = rootServer.community.channelMessages;
    messages.on(ChannelMessageEvent.ChannelMessageReactionCreated, (evt) => void onReaction(evt, true));
    messages.on(ChannelMessageEvent.ChannelMessageReactionDeleted, (evt) => void onReaction(evt, false));
    messages.on(ChannelMessageEvent.ChannelMessageEdited, (evt) => {
      onStarredEdited(evt.id).catch((err) => log("error", "events edit handler failed", { error: errMessage(err) }));
    });
    messages.on(ChannelMessageEvent.ChannelMessageDeleted, (evt) => {
      void (async () => {
        for (const step of [onGiveawayMessageDeleted, onPollMessageDeleted, onStarredDeleted]) {
          await step(evt.id).catch((err) => log("error", "events delete handler failed", { error: errMessage(err) }));
        }
      })();
    });
  },
};
