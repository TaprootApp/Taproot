import type { TaprootModule } from "../types";
import { log, errMessage } from "../../lib/log";
import { loadModuleConfig } from "../../settings";
import { registerTicketCommands } from "./commands";
import { DEFAULTS, NAME } from "./config";
import { createTables as createFormTables } from "./forms";
import { supportService } from "./service";
import { createTables as createTicketTables, registerTicketEvents } from "./tickets";

// Support: tickets (private staff channels with transcripts) and forms
// (applications and appeals filled in on the GUI, reviewed by staff).

export const module: TaprootModule = {
  name: NAME,
  async init() {
    await createTicketTables();
    await createFormTables();
    await loadModuleConfig(NAME, DEFAULTS);
    registerTicketEvents();
    try {
      registerTicketCommands();
    } catch (err) {
      // A name clash with another module shouldn't take the GUI down with it.
      log("error", "support: registering the ticket command failed", { error: errMessage(err) });
    }
  },
  services: [supportService],
};
