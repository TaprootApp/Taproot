import type React from "react";
import type { StaffLevel } from "@taproot/gen-shared";
import type { IconName } from "../components/Icon";

// Feature modules plug pages into the shell without editing it. Each module
// in client/src/modules/<name>/index.tsx exports `module: ClientModule`, and
// client/src/modules/index.ts lists them.

export type NavGroupName = "You" | "Moderation" | "Community" | "Engagement" | "Settings";

export interface ModulePage {
  /** Unique page key, e.g. "levels". Used with useNav().navigate(key). */
  key: string;
  label: string;
  icon: IconName;
  minLevel: StaffLevel;
  group: NavGroupName;
  /** Default-exported view with no props; reads params with useNav().params. */
  component: React.ComponentType;
}

export interface ClientModule {
  name: string;
  pages?: ModulePage[];
  /** Extra cards shown at the bottom of every member's "Me" page. */
  meSections?: React.ComponentType[];
}
