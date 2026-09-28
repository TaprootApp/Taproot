import { StaffLevel } from "@taproot/gen-shared";
import type { ClientModule } from "../types";
import Autoresponder from "./Autoresponder";
import { AfkSection, HighlightsSection } from "./MeSections";

// Utility module: the Autoresponder page for staff, and AFK and highlight
// cards on every member's Me page. Info and fun commands are chat-only.
export const module: ClientModule = {
  name: "utility",
  pages: [
    {
      key: "autoresponder",
      label: "Autoresponder",
      icon: "message",
      minLevel: StaffLevel.MODERATOR,
      group: "Community",
      component: Autoresponder,
    },
  ],
  meSections: [AfkSection, HighlightsSection],
};
