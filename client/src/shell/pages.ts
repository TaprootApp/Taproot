import type React from "react";
import type { PageKey } from "../lib/nav";
import Me from "../views/Me";
import Overview from "../views/Overview";
import Cases from "../views/Cases";
import Members from "../views/Members";
import CustomCommands from "../views/CustomCommands";
import Announcements from "../views/Announcements";
import ReactionRoles from "../views/ReactionRoles";
import General from "../views/settings/General";
import Welcome from "../views/settings/Welcome";
import Automod from "../views/settings/Automod";
import Punishments from "../views/settings/Punishments";
import { MODULE_PAGES } from "../modules";

// Page key -> view. Each view is a default-exported component with no props;
// it reads route params with useNav().params.
export const PAGE_COMPONENTS: Record<PageKey, React.ComponentType> = {
  ...Object.fromEntries(MODULE_PAGES.map((p) => [p.key, p.component])),
  me: Me,
  overview: Overview,
  cases: Cases,
  members: Members,
  commands: CustomCommands,
  announcements: Announcements,
  reactionRoles: ReactionRoles,
  general: General,
  welcome: Welcome,
  automod: Automod,
  punishments: Punishments,
};
