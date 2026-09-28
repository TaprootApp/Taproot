import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import EconomySettings from "./EconomySettings";
import Leaderboard from "./Leaderboard";
import LevelsSettings from "./LevelsSettings";
import MeSection from "./MeSection";

// Levels/XP and the community currency (Dyno's Levels premium and economy).
export const module: ClientModule = {
  name: "engagement",
  pages: [
    { key: "leaderboard", label: "Leaderboard", icon: "trophy", minLevel: StaffLevel.MEMBER, group: "Engagement", component: Leaderboard },
    { key: "levels", label: "Levels", icon: "trendingUp", minLevel: StaffLevel.ADMIN, group: "Settings", component: LevelsSettings },
    { key: "economy", label: "Economy", icon: "coins", minLevel: StaffLevel.ADMIN, group: "Settings", component: EconomySettings },
  ],
  meSections: [MeSection],
};
