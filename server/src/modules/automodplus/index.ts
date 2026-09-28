import type { TaprootModule } from "../types";
import { initChannelRules } from "./channelRules";
import { initJoinProtection } from "./joinProtection";
import { automodplusService } from "./service";
import { loadPlusConfig } from "./state";

// Dyno's advanced auto-mod, Auto Delete, Auto Purge, Autoban, raid protection
// and slowmode. The extra auto-mod filters and per-rule actions run inside
// core auto-mod (features/automod.ts), which reads this module's config;
// everything else lives here.

export const module: TaprootModule = {
  name: "automodplus",
  async init() {
    await loadPlusConfig();
    await initChannelRules();
    await initJoinProtection();
  },
  services: [automodplusService],
};
