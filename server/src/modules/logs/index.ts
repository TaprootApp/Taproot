import type { TaprootModule } from "../types";
import { loadModuleConfig } from "../../settings";
import { NAME, startActionLog } from "./actionLog";
import { registerLogCommands } from "./commands";
import { defaultLogsConfig } from "./events";
import { logsService } from "./service";

// Dyno's Action Log and ban/kick announcements. No tables: the config lives
// in settings ("module:logs") and message content only in memory.
export const module: TaprootModule = {
  name: NAME,
  async init() {
    await loadModuleConfig(NAME, defaultLogsConfig());
    registerLogCommands();
    await startActionLog();
  },
  services: [logsService],
};
