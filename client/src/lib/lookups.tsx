import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ChannelInfo, RoleInfo } from "@taproot/gen-shared";
import { sessionServiceClient } from "@taproot/gen-client";
import { errorMessage } from "./errors";

// Channel and role lists for the pickers, fetched once per app load and
// shared by every screen. Each list loads the first time something asks for
// it (members can't list channels, so we never fetch what isn't used).

export interface Lookup<T> {
  items: T[];
  byId: Map<string, T>;
  loading: boolean;
  error: string | undefined;
  /** Refetches the list, e.g. after an admin creates a role in Root. */
  reload: () => Promise<void>;
}

interface Store<T> {
  items: T[] | undefined;
  loading: boolean;
  error: string | undefined;
}

interface LookupsValue {
  channels: Store<ChannelInfo>;
  roles: Store<RoleInfo>;
  load: (kind: "channels" | "roles", force?: boolean) => Promise<void>;
}

const LookupsContext = createContext<LookupsValue | undefined>(undefined);

const EMPTY = { items: undefined, loading: false, error: undefined };

export const LookupsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [channels, setChannels] = useState<Store<ChannelInfo>>(EMPTY);
  const [roles, setRoles] = useState<Store<RoleInfo>>(EMPTY);
  const inFlight = useRef<Record<string, Promise<void> | undefined>>({});

  const load = useCallback((kind: "channels" | "roles", force = false) => {
    const pending = inFlight.current[kind];
    if (pending && !force) return pending;
    const promise =
      kind === "channels"
        ? fetchInto(setChannels, async () => (await sessionServiceClient.listChannels()).channels)
        : fetchInto(setRoles, async () => (await sessionServiceClient.listRoles()).roles);
    inFlight.current[kind] = promise.then((ok) => {
      // Let the next caller retry after a failure.
      if (!ok) inFlight.current[kind] = undefined;
    });
    return inFlight.current[kind]!;
  }, []);

  const value = useMemo(() => ({ channels, roles, load }), [channels, roles, load]);
  return <LookupsContext.Provider value={value}>{children}</LookupsContext.Provider>;
};

async function fetchInto<T>(
  set: React.Dispatch<React.SetStateAction<Store<T>>>,
  fetch: () => Promise<T[]>,
): Promise<boolean> {
  set((s) => ({ ...s, loading: true }));
  try {
    const items = await fetch();
    set({ items, loading: false, error: undefined });
    return true;
  } catch (err) {
    set((s) => ({ ...s, loading: false, error: errorMessage(err) }));
    return false;
  }
}

function useLookup<T extends { id: string }>(kind: "channels" | "roles"): Lookup<T> {
  const ctx = useContext(LookupsContext);
  if (!ctx) throw new Error("useChannels/useRoles must be used inside LookupsProvider");
  const store = ctx[kind] as unknown as Store<T>;
  const { load } = ctx;

  useEffect(() => {
    if (store.items === undefined && !store.loading && !store.error) void load(kind);
  }, [store.items, store.loading, store.error, load, kind]);

  const items = store.items;
  const byId = useMemo(() => new Map((items ?? []).map((item) => [item.id, item])), [items]);
  const reload = useCallback(() => load(kind, true), [load, kind]);
  return {
    items: items ?? [],
    byId,
    loading: store.loading || (items === undefined && !store.error),
    error: store.error,
    reload,
  };
}

/** Channels Taproot can see (moderator+ only; members get an error). */
export function useChannels(): Lookup<ChannelInfo> {
  return useLookup<ChannelInfo>("channels");
}

/** Community roles, excluding @everyone. */
export function useRoles(): Lookup<RoleInfo> {
  return useLookup<RoleInfo>("roles");
}
