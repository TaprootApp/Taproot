import React, { createContext, useContext } from "react";
import { StaffLevel } from "@taproot/gen-shared";
import type { IconName } from "../components/Icon";
import { MODULE_PAGES } from "../modules";
import type { NavGroupName } from "../modules/types";

// Pages and state-based routing. No router: App keeps { page, params } in
// state and views move around with useNav().navigate("members", { userId }).

// Core page keys, plus any key a feature module registers (client/src/modules).
export type PageKey =
  | "me"
  | "overview"
  | "cases"
  | "members"
  | "commands"
  | "announcements"
  | "reactionRoles"
  | "general"
  | "welcome"
  | "automod"
  | "punishments"
  | (string & {});

export interface PageDef {
  key: PageKey;
  label: string;
  icon: IconName;
  minLevel: StaffLevel;
}

export interface NavGroup {
  label: string;
  pages: PageDef[];
}

const CORE_GROUPS: NavGroup[] = [
  {
    label: "You",
    pages: [{ key: "me", label: "Me", icon: "user", minLevel: StaffLevel.MEMBER }],
  },
  {
    label: "Moderation",
    pages: [
      { key: "overview", label: "Overview", icon: "home", minLevel: StaffLevel.MODERATOR },
      { key: "cases", label: "Cases", icon: "list", minLevel: StaffLevel.MODERATOR },
      { key: "members", label: "Members", icon: "users", minLevel: StaffLevel.MODERATOR },
    ],
  },
  {
    label: "Community",
    pages: [
      { key: "commands", label: "Custom commands", icon: "terminal", minLevel: StaffLevel.MODERATOR },
      { key: "announcements", label: "Announcements", icon: "megaphone", minLevel: StaffLevel.MODERATOR },
      { key: "reactionRoles", label: "Reaction roles", icon: "smile", minLevel: StaffLevel.ADMIN },
    ],
  },
  {
    label: "Settings",
    pages: [
      { key: "general", label: "General", icon: "settings", minLevel: StaffLevel.ADMIN },
      { key: "welcome", label: "Welcome", icon: "wave", minLevel: StaffLevel.ADMIN },
      { key: "automod", label: "Auto-mod", icon: "shield", minLevel: StaffLevel.ADMIN },
      { key: "punishments", label: "Punishments", icon: "gavel", minLevel: StaffLevel.ADMIN },
    ],
  },
];

const GROUP_ORDER: NavGroupName[] = ["You", "Moderation", "Community", "Engagement", "Settings"];

/** Core groups with module pages appended to the group each module asked for. */
export const NAV_GROUPS: NavGroup[] = GROUP_ORDER.map((label) => {
  const core = CORE_GROUPS.find((g) => g.label === label)?.pages ?? [];
  const extra = MODULE_PAGES.filter((p) => p.group === label).map(({ key, label: l, icon, minLevel }) => ({
    key,
    label: l,
    icon,
    minLevel,
  }));
  return { label, pages: [...core, ...extra] };
}).filter((g) => g.pages.length > 0);

export const ALL_PAGES: PageDef[] = NAV_GROUPS.flatMap((g) => g.pages);

/** Nav groups filtered to what `level` may open; empty groups dropped. */
export function visibleGroups(level: StaffLevel): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => level >= p.minLevel) })).filter(
    (g) => g.pages.length > 0,
  );
}

export function canOpen(page: PageKey, level: StaffLevel): boolean {
  const def = ALL_PAGES.find((p) => p.key === page);
  return !!def && level >= def.minLevel;
}

/** Overview for staff, Me for members. */
export function defaultPage(level: StaffLevel): PageKey {
  return level >= StaffLevel.MODERATOR ? "overview" : "me";
}

export type NavParams = Record<string, string>;

export interface NavValue {
  page: PageKey;
  /** Parameters passed with the last navigate(), e.g. { userId }. */
  params: NavParams;
  /** Opens a page (ignored if the caller's level can't open it). */
  navigate: (page: PageKey, params?: NavParams) => void;
}

const NavContext = createContext<NavValue | undefined>(undefined);

export const NavProvider = NavContext.Provider;

export function useNav(): NavValue {
  const value = useContext(NavContext);
  if (!value) throw new Error("useNav must be used inside NavProvider");
  return value;
}

/** Convenience for views: a link-styled button that navigates. */
export const NavLink: React.FC<{ to: PageKey; params?: NavParams; children: React.ReactNode }> = ({
  to,
  params,
  children,
}) => {
  const { navigate } = useNav();
  return (
    <button type="button" className="tp-link" onClick={() => navigate(to, params)}>
      {children}
    </button>
  );
};
