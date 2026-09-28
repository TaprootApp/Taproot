import { useEffect, useRef } from "react";
import type { EventMap, TypedEventEmitter } from "@rootsdk/client-app";

/**
 * Subscribes to a service's broadcast event for the component's lifetime.
 *
 *   useBroadcast(moderationServiceClient, ModerationServiceClientEvent.CasesChanged, () => cases.reload());
 *
 * Bursts (a purge, a raid tripping auto-mod) are coalesced: the callback runs
 * once, `debounceMs` after the last event, with that last event. `filter`
 * runs on every event before coalescing, so an event the view cares about is
 * never swallowed by a later one it doesn't. The callback and filter may
 * change every render; the subscription doesn't.
 */
export function useBroadcast<Events extends EventMap, E extends keyof Events & string>(
  client: TypedEventEmitter<Events>,
  event: E,
  callback: (...args: Parameters<Events[E]>) => void,
  options: { debounceMs?: number; filter?: (...args: Parameters<Events[E]>) => boolean } = {},
): void {
  const { debounceMs = 250 } = options;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const filterRef = useRef(options.filter);
  filterRef.current = options.filter;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = ((...args: Parameters<Events[E]>) => {
      if (filterRef.current && !filterRef.current(...args)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => callbackRef.current(...args), debounceMs);
    }) as Events[E];
    client.on(event, listener);
    return () => {
      if (timer) clearTimeout(timer);
      client.off(event, listener);
    };
  }, [client, event, debounceMs]);
}
