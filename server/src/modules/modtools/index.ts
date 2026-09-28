import type { TaprootModule } from "../types";
import { registerCommands } from "./commands";
import { initNotify } from "./notify";
import { modtoolsService } from "./service";
import { createTables, loadConfig, NAME } from "./store";
import { initTempRoles } from "./tempRoles";
import { initTimedAutoroles } from "./timedAutoroles";
import { initVoice } from "./voice";

// Moderation extras (Dyno parity): staff notes, "duration" for active mutes
// and temp bans, temp roles, timed autoroles, voice mute/kick and optional
// member notifications. Timed channel locks live with the lock command in
// features/moderation.ts.

export const module: TaprootModule = {
  name: NAME,
  async init() {
    await createTables();
    await loadConfig();
    registerCommands();
    initTempRoles();
    initTimedAutoroles();
    initVoice();
    await initNotify();
  },
  services: [modtoolsService],
};
