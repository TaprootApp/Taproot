import React, { createContext, useContext, useMemo } from "react";
import type { Session } from "@taproot/gen-shared";
import { StaffLevel } from "@taproot/gen-shared";
import { configServiceClient, ConfigServiceClientEvent } from "@taproot/gen-client";
import { useBroadcast } from "./useBroadcast";

// The caller's session (level, nickname, community, prefix). App.tsx loads
// it once and provides it; everything below can assume it exists. The prefix
// lives in General settings, so a "general" ConfigChanged refetches it. There
// is no broadcast for a level change (roles are Root's, not Taproot's); the
// sidebar's refresh button covers that.

export interface SessionValue {
  session: Session;
  level: StaffLevel;
  /** level >= MODERATOR */
  isModerator: boolean;
  /** level >= ADMIN */
  isAdmin: boolean;
  /** True when the caller's level is at least `level`. */
  atLeast: (level: StaffLevel) => boolean;
  /** Refetches the session (e.g. after the caller's roles change). */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export const SessionProvider: React.FC<{
  session: Session;
  refresh: () => Promise<void>;
  children: React.ReactNode;
}> = ({ session, refresh, children }) => {
  useBroadcast(configServiceClient, ConfigServiceClientEvent.ConfigChanged, () => void refresh(), {
    filter: (event) => !event.area || event.area === "general",
  });
  const value = useMemo<SessionValue>(
    () => ({
      session,
      level: session.level,
      isModerator: session.level >= StaffLevel.MODERATOR,
      isAdmin: session.level >= StaffLevel.ADMIN,
      atLeast: (level) => session.level >= level,
      refresh,
    }),
    [session, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
