import type { TaprootModule } from "../types";
import { initFeedTables, registerFeedCommands } from "./feeds";
import { feedsService } from "./service";
import { initVoiceTables, initVoiceLinks } from "./voice";

// Social feeds (YouTube, Reddit, Twitch, Kick) and voice-text channel links.

export const module: TaprootModule = {
  name: "feeds",
  async init() {
    await initFeedTables();
    await initVoiceTables();
    registerFeedCommands();
    initVoiceLinks();
  },
  services: [feedsService],
};
