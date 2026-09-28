import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import Settings from "./Settings";
import TempRoles from "./TempRoles";

// Mod tools pages. The member cards (notes, temp roles, voice) and the
// duration dialog are used directly by views/Members.tsx.
export const module: ClientModule = {
  name: "modtools",
  pages: [
    { key: "tempRoles", label: "Temp roles", icon: "timer", minLevel: StaffLevel.MODERATOR, group: "Moderation", component: TempRoles },
    { key: "modTools", label: "Mod tools", icon: "clipboard", minLevel: StaffLevel.ADMIN, group: "Settings", component: Settings },
  ],
};
