import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import Feeds from "./Feeds";
import VoiceLinks from "./VoiceLinks";

// Social feeds (Community) and voice-text links (Settings), admin only.
export const module: ClientModule = {
  name: "feeds",
  pages: [
    { key: "feeds", label: "Feeds", icon: "rss", minLevel: StaffLevel.ADMIN, group: "Community", component: Feeds },
    { key: "voiceLinks", label: "Voice links", icon: "volume", minLevel: StaffLevel.ADMIN, group: "Settings", component: VoiceLinks },
  ],
};
