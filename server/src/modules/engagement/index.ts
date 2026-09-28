import { addMessageListener } from "../../pipeline";
import { loadModuleConfig } from "../../settings";
import type { TaprootModule } from "../types";
import { registerEconomyCommands } from "./economy";
import { onMessageForXp, registerLevelCommands } from "./levels";
import { DEFAULT_CONFIG } from "./logic";
import { NAME } from "./runtime";
import { engagementService } from "./service";
import { createTables } from "./store";

// Levels/XP (with role rewards and multipliers) and a community currency
// (daily, work, pay, a role shop). Both are off until an admin turns them on.

export const module: TaprootModule = {
  name: NAME,
  async init() {
    await createTables();
    await loadModuleConfig(NAME, DEFAULT_CONFIG);
    registerLevelCommands();
    registerEconomyCommands();
    // The pipeline isolates listener failures, so XP can never break a command.
    addMessageListener("engagement:xp", onMessageForXp);
  },
  services: [engagementService],
};
