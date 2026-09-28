import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import ActionLog from "./ActionLog";

// Dyno's Action Log and ban/kick announcements.
export const module: ClientModule = {
  name: "logs",
  pages: [{ key: "actionLog", label: "Action log", icon: "fileText", minLevel: StaffLevel.ADMIN, group: "Settings", component: ActionLog }],
};
