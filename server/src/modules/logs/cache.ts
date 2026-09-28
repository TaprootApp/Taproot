// Recently seen messages, kept in memory only so a deleted or edited message
// can be shown in the action log. Root's delete event carries no content, and
// nothing here is ever written to disk: a restart forgets it all. Bounded by
// count and age. Pure: no SDK imports.

export interface CachedMessage {
  channelId: string;
  userId: string;
  content: string;
  at: number;
}

export class MessageCache {
  // Map keeps insertion order, so the first entry is always the oldest.
  private readonly entries = new Map<string, CachedMessage>();

  constructor(
    private readonly maxEntries = 5000,
    private readonly maxAgeMs = 24 * 60 * 60_000,
    /** Longer messages are cut; the log truncates far shorter anyway. */
    private readonly maxContent = 2000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  set(messageId: string, message: Omit<CachedMessage, "at">): void {
    this.entries.delete(messageId);
    this.entries.set(messageId, { ...message, content: message.content.slice(0, this.maxContent), at: this.now() });
    this.prune();
  }

  get(messageId: string): CachedMessage | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.maxAgeMs) {
      this.entries.delete(messageId);
      return undefined;
    }
    return entry;
  }

  /** Returns and forgets the message (it was deleted). */
  take(messageId: string): CachedMessage | undefined {
    const entry = this.get(messageId);
    this.entries.delete(messageId);
    return entry;
  }

  /** Forgets everything from a channel (it was deleted or is now ignored). */
  dropChannel(channelId: string): void {
    for (const [id, entry] of this.entries) if (entry.channelId === channelId) this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(): void {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && entry.at >= cutoff) break;
      this.entries.delete(id);
    }
  }
}
