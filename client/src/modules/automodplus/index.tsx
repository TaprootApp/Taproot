import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import ChannelRules from "./ChannelRules";
import JoinProtection from "./JoinProtection";

// Dyno's advanced auto-mod, Auto Delete, Auto Purge, Autoban, raid protection
// and slowmode. The extra auto-mod options live on the existing Auto-mod page
// (views/settings/Automod.tsx imports AutomodExtras.tsx); these are the new pages.
export const module: ClientModule = {
  name: "automodplus",
  pages: [
    { key: "channelRules", label: "Channel rules", icon: "filter", minLevel: StaffLevel.ADMIN, group: "Settings", component: ChannelRules },
    { key: "joinProtection", label: "Join protection", icon: "userX", minLevel: StaffLevel.ADMIN, group: "Settings", component: JoinProtection },
  ],
};
