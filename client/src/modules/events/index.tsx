import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import Giveaways from "./Giveaways";
import Polls from "./Polls";
import Starboard from "./Starboard";

// Events module: giveaways and polls (moderators), starboard settings (admins).
export const module: ClientModule = {
  name: "events",
  pages: [
    { key: "giveaways", label: "Giveaways", icon: "gift", minLevel: StaffLevel.MODERATOR, group: "Community", component: Giveaways },
    { key: "polls", label: "Polls", icon: "barChart", minLevel: StaffLevel.MODERATOR, group: "Community", component: Polls },
    { key: "starboard", label: "Starboard", icon: "star", minLevel: StaffLevel.ADMIN, group: "Settings", component: Starboard },
  ],
};
