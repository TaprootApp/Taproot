import { DependencyList, useCallback, useEffect, useRef, useState } from "react";
import { RootServerExceptionType } from "@rootsdk/client-app";
import { errorCode, errorMessage } from "./errors";
import { useToast } from "../components/Toast";

// Hooks for calling RPCs from views.
//
// Always wrap generated client methods in an arrow function
// (`() => configServiceClient.getConfig()`): they read `this`, so passing
// `configServiceClient.getConfig` unbound throws.

export interface RpcState<T> {
  /** Last successful result; kept while a reload is in flight. */
  data: T | undefined;
  /** True while a request is in flight (first load or reload). */
  loading: boolean;
  /** Friendly message from the last failed request, cleared on success. */
  error: string | undefined;
  /** Re-runs the request. Resolves when it settles; never throws. */
  reload: () => Promise<void>;
  /** Replaces data locally, e.g. with the result of a mutation RPC. */
  setData: (data: T) => void;
}

// Root allows each client about 10 requests a second. A page with many cards
// (the Me page) loads them all at once, so reads that hit the limit wait and
// try again instead of showing "Couldn't load this".
const RATE_LIMIT_RETRIES = 3;

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RATE_LIMIT_RETRIES || errorCode(err) !== RootServerExceptionType.RateLimitExceeded) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1) + Math.random() * 500));
    }
  }
}

/**
 * Runs `fn` on mount and whenever `deps` change. Responses from superseded
 * requests are dropped, so fast-changing deps (a search box) are safe.
 * Pass `{ skip: true }` to hold off (e.g. until a member is selected).
 */
export function useRpc<T>(
  fn: () => Promise<T>,
  deps: DependencyList = [],
  options: { skip?: boolean } = {},
): RpcState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(!options.skip);
  const [error, setError] = useState<string | undefined>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const requestId = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const result = await withRateLimitRetry(() => fnRef.current());
      if (!mounted.current || id !== requestId.current) return;
      setData(result);
      setError(undefined);
    } catch (err) {
      if (!mounted.current || id !== requestId.current) return;
      setError(errorMessage(err));
    } finally {
      if (mounted.current && id === requestId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (options.skip) {
      requestId.current++;
      setLoading(false);
      return;
    }
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, options.skip]);

  return { data, loading, error, reload, setData };
}

export interface ActionOptions<R> {
  /** Toast shown on success; a function can build it from the result (return undefined for none). */
  success?: string | ((result: R) => string | undefined);
  /** Show failures as an error toast (default true). The error is also returned in `error`. */
  toastError?: boolean;
}

export interface ActionState<A extends unknown[], R> {
  /** Runs the action. Resolves to the result, or undefined if it failed. Never throws. */
  run: (...args: A) => Promise<R | undefined>;
  /** True while the action is running. */
  busy: boolean;
  /** Friendly message from the last failure, cleared when run again. */
  error: string | undefined;
  /** Clears `error`. */
  reset: () => void;
}

/** Wraps a mutation RPC (save, delete, warn...) with busy/error state and toasts. */
export function useAction<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  options: ActionOptions<R> = {},
): ActionState<A, R> {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useRef({ fn, options });
  latest.current = { fn, options };

  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await latest.current.fn(...args);
        const { success } = latest.current.options;
        const text = typeof success === "function" ? success(result) : success;
        if (text) toast.success(text);
        return result;
      } catch (err) {
        const message = errorMessage(err);
        setError(message);
        if (latest.current.options.toastError !== false) toast.error(message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const reset = useCallback(() => setError(undefined), []);
  return { run, busy, error, reset };
}
