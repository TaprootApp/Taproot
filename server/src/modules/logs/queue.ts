// Batches action-log entries so a raid or a mass role change can't eat the
// shared write budget (~5/s for the whole bot). Entries for the same channel
// that arrive within a couple of seconds go out as one message, the log as a
// whole posts at most a few messages per minute, and each channel holds a
// bounded backlog: past that, entries are dropped and counted, and the next
// message says how many were lost. Pure: no SDK imports.

export interface LogQueueOptions {
  send(channelId: string, content: string): Promise<void>;
  onError?(channelId: string, err: unknown): void;
  /** Wait after the first entry before posting, so a burst shares a message. */
  flushDelayMs?: number;
  /** Entries waiting per channel before new ones are dropped. */
  maxPending?: number;
  /** Messages that may go out back to back. */
  burst?: number;
  /** Sustained rate, in messages per minute across all log channels. */
  perMinute?: number;
  /** Longest message to post. */
  maxMessage?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
}

interface Pending {
  entries: string[];
  dropped: number;
}

export class LogQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly o: Required<LogQueueOptions>;
  private tokens: number;
  private lastRefill: number;
  private timerSet = false;
  private flushing = false;

  constructor(options: LogQueueOptions) {
    this.o = {
      onError: () => undefined,
      flushDelayMs: 2000,
      maxPending: 80,
      burst: 5,
      perMinute: 20,
      maxMessage: 9000,
      now: Date.now,
      setTimer: (fn, ms) => void setTimeout(fn, ms),
      ...options,
    };
    this.tokens = this.o.burst;
    this.lastRefill = this.o.now();
  }

  /** Entries waiting to be posted, across all channels. */
  get backlog(): number {
    let n = 0;
    for (const p of this.pending.values()) n += p.entries.length;
    return n;
  }

  push(channelId: string, entry: string): void {
    let p = this.pending.get(channelId);
    if (!p) {
      p = { entries: [], dropped: 0 };
      this.pending.set(channelId, p);
    }
    if (p.entries.length >= this.o.maxPending) p.dropped++;
    else p.entries.push(entry.slice(0, this.o.maxMessage - 200));
    this.schedule(this.o.flushDelayMs);
  }

  /** Posts what the budget allows now; the rest waits for the next flush. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [channelId, p] of [...this.pending]) {
        this.refill();
        if (this.tokens < 1) break;
        const content = this.take(p);
        if (!p.entries.length && !p.dropped) this.pending.delete(channelId);
        if (!content) continue;
        this.tokens -= 1;
        try {
          await this.o.send(channelId, content);
        } catch (err) {
          this.o.onError(channelId, err);
        }
      }
    } finally {
      this.flushing = false;
    }
    if (this.pending.size > 0) {
      this.refill();
      const waitMs = this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) * 60_000) / this.o.perMinute);
      this.schedule(Math.max(this.o.flushDelayMs, waitMs));
    }
  }

  /** Builds one message from the front of the channel's backlog. */
  private take(p: Pending): string | undefined {
    const parts: string[] = [];
    let length = 0;
    while (p.entries.length > 0) {
      const next = p.entries[0];
      if (parts.length > 0 && length + next.length + 2 > this.o.maxMessage - 120) break;
      parts.push(next);
      length += next.length + 2;
      p.entries.shift();
    }
    if (p.dropped > 0 && p.entries.length === 0) {
      parts.push(`⚠️ ${p.dropped} more event${p.dropped === 1 ? "" : "s"} weren't logged (too many at once).`);
      p.dropped = 0;
    }
    return parts.length ? parts.join("\n\n") : undefined;
  }

  private refill(): void {
    const now = this.o.now();
    this.tokens = Math.min(this.o.burst, this.tokens + ((now - this.lastRefill) / 60_000) * this.o.perMinute);
    this.lastRefill = now;
  }

  private schedule(ms: number): void {
    if (this.timerSet) return;
    this.timerSet = true;
    this.o.setTimer(() => {
      this.timerSet = false;
      this.flush().catch(() => undefined);
    }, ms);
  }
}
