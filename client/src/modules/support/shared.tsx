import { useState } from "react";
import type { SupportChangeEvent } from "@taproot/gen-shared";
import { SupportSubmissionStatus, SupportTicketStatus } from "@taproot/gen-shared";
import { supportServiceClient, SupportServiceClientEvent } from "@taproot/gen-client";
import type { BadgeTone } from "../../components";
import { errorMessage, useBroadcast } from "../../lib";

// Bits shared by the support pages.

/**
 * Calls `onChange` when the server broadcasts a support change in one of
 * `areas` ("support:tickets", "support:forms", "support:submissions",
 * "support:config"). An event with no area refreshes everything.
 */
export function useSupportChanged(areas: string[], onChange: () => void): void {
  useBroadcast(supportServiceClient, SupportServiceClientEvent.SupportChanged, () => onChange(), {
    filter: (event: SupportChangeEvent) => !event?.area || areas.includes(event.area),
  });
}

export const SUBMISSION_STATUS: Record<SupportSubmissionStatus, { label: string; tone: BadgeTone }> = {
  [SupportSubmissionStatus.UNSPECIFIED]: { label: "Unknown", tone: "neutral" },
  [SupportSubmissionStatus.PENDING]: { label: "Pending", tone: "warning" },
  [SupportSubmissionStatus.ACCEPTED]: { label: "Accepted", tone: "success" },
  [SupportSubmissionStatus.DENIED]: { label: "Denied", tone: "danger" },
  [SupportSubmissionStatus.CLOSED]: { label: "Closed", tone: "neutral" },
};

export const TICKET_STATUS: Record<SupportTicketStatus, { label: string; tone: BadgeTone }> = {
  [SupportTicketStatus.UNSPECIFIED]: { label: "Unknown", tone: "neutral" },
  [SupportTicketStatus.OPEN]: { label: "Open", tone: "success" },
  [SupportTicketStatus.CLOSED]: { label: "Closed", tone: "neutral" },
};

export const PAGE = 25;

export interface Paged<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | undefined;
  /** Reloads as many rows as are showing (for live updates and filter changes). */
  reload: () => Promise<void>;
  loadMore: () => Promise<void>;
  replace: (item: T, same: (a: T, b: T) => boolean) => void;
}

/**
 * A list that pages with "Load more". `fetch` gets an offset and limit and
 * returns rows plus the total; the server caps a page at 100.
 */
export function usePaged<T>(fetch: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>): Paged<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [request] = useState({ id: 0 });

  const run = async (offset: number, limit: number, append: boolean) => {
    const id = ++request.id;
    setLoading(true);
    try {
      const page = await fetch(offset, limit);
      if (id !== request.id) return;
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setTotal(page.total);
      setError(undefined);
    } catch (err) {
      if (id !== request.id) return;
      setError(errorMessage(err));
    } finally {
      if (id === request.id) setLoading(false);
    }
  };

  return {
    items,
    total,
    loading,
    error,
    reload: () => run(0, Math.min(100, Math.max(PAGE, items.length)), false),
    loadMore: () => run(items.length, PAGE, true),
    replace: (item, same) => setItems((prev) => prev.map((p) => (same(p, item) ? item : p))),
  };
}
