// Auto-mod detection rules. Pure functions over message data (no SDK imports)
// so they can be unit tested. Enforcement lives in automod.ts.

import type { AutomodConfig } from "../settings";

export interface MessageFacts {
  userId: string;
  content: string;
  uris: string[];
  mentionedUserIds: string[];
  mentionedRoleIds: string[];
  at: number;
}

export interface Violation {
  rule:
    | "words"
    | "links"
    | "mentions"
    | "spam"
    | "duplicates"
    | "caps"
    // Extra filters from the automodplus module (modules/automodplus/filters.ts).
    | "invites"
    | "scam"
    | "zalgo"
    | "emoji"
    | "newlines"
    | "repeated"
    | "attachments"
    | "newMemberLinks";
  /** Shown to the member, so it never repeats the offending text. */
  message: string;
}

/**
 * Banned-word matching. A plain entry matches whole words case-insensitively;
 * a leading or trailing * matches word prefixes/suffixes ("spam*" catches
 * "spammer"). Common character swaps (0→o, 3→e, @→a…) are undone first.
 */
export function findBannedWord(content: string, list: string[]): string | undefined {
  const text = normalize(stripMarkdownLinks(content));
  for (const entry of list) {
    const word = normalize(entry.trim());
    if (!word) continue;
    const core = escapeRegex(word.replace(/^\*|\*$/g, ""));
    if (!core) continue;
    const pre = word.startsWith("*") ? "\\S*" : "";
    const post = word.endsWith("*") ? "\\S*" : "";
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${pre}${core}${post}(?=$|[^\\p{L}\\p{N}])`, "u").test(text)) return entry;
  }
  return undefined;
}

const SWAPS: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[013457@$]/g, (c) => SWAPS[c] ?? c);
}

function stripMarkdownLinks(content: string): string {
  // Mentions carry IDs that could accidentally match; keep only their text.
  return content.replace(/\[([^\]]*)\]\(root:\/\/[^)]*\)/g, "$1");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hostOf(uri: string): string | undefined {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(uri);
  return m?.[1].toLowerCase();
}

/** A link is allowed if its host is, or is a subdomain of, an allowlisted domain. */
export function isAllowedHost(host: string, allow: string[]): boolean {
  return allow.some((d) => {
    const domain = d.toLowerCase().replace(/^\*\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export function externalLinks(facts: MessageFacts): string[] {
  const fromUris = facts.uris.filter((u) => /^https?:\/\//i.test(u));
  // Also catch bare domains the client didn't turn into links ("example.com/x").
  // Limited to common TLDs so file names like "notes.txt" don't trip it.
  const bare = stripMarkdownLinks(facts.content).match(BARE_DOMAIN) ?? [];
  return [...fromUris, ...bare.map((b) => `https://${b}`)];
}

const BARE_DOMAIN =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|gg|co|xyz|me|ru|info|biz|tv|app|dev|link|ly|to|us|uk|de|site|online|shop|live|store|club)\b(?:\/\S*)?/gi;

const CAPS_LETTERS = /\p{Lu}/gu;
const ALL_LETTERS = /\p{L}/gu;

/** Rolling per-member history for spam checks. In memory: a restart just resets it. */
export class SpamTracker {
  private history = new Map<string, Array<{ at: number; hash: string }>>();

  record(userId: string, content: string, at: number, windowMs: number): Array<{ at: number; hash: string }> {
    const hash = content.trim().toLowerCase().replace(/\s+/g, " ");
    const list = (this.history.get(userId) ?? []).filter((e) => at - e.at <= windowMs);
    list.push({ at, hash });
    this.history.set(userId, list);
    return list;
  }

  /** Drops members with no recent messages so memory stays bounded. */
  prune(now: number, windowMs: number): void {
    for (const [userId, list] of this.history) {
      if (!list.some((e) => now - e.at <= windowMs)) this.history.delete(userId);
    }
  }
}

const DUPLICATE_WINDOW_MS = 60_000;

export function checkMessage(facts: MessageFacts, config: AutomodConfig, tracker: SpamTracker): Violation | undefined {
  if (config.words.enabled && config.words.list.length) {
    if (findBannedWord(facts.content, config.words.list)) {
      return { rule: "words", message: "that message contained a blocked word" };
    }
  }

  if (config.links.enabled) {
    const blocked = externalLinks(facts).some((u) => {
      const host = hostOf(u);
      return host !== undefined && !isAllowedHost(host, config.links.allow);
    });
    if (blocked) return { rule: "links", message: "links aren't allowed here" };
  }

  if (config.mentions.enabled) {
    if (config.mentions.blockAll && facts.mentionedRoleIds.some((r) => r === "All" || r === "Here")) {
      return { rule: "mentions", message: "only staff can mention @All or @Here" };
    }
    const unique = new Set(facts.mentionedUserIds).size + new Set(facts.mentionedRoleIds).size;
    if (unique > config.mentions.max) return { rule: "mentions", message: "too many mentions in one message" };
  }

  if (config.caps.enabled) {
    const letters = facts.content.match(ALL_LETTERS)?.length ?? 0;
    const caps = facts.content.match(CAPS_LETTERS)?.length ?? 0;
    if (letters >= config.caps.minLength && (caps / letters) * 100 >= config.caps.percent) {
      return { rule: "caps", message: "please don't shout" };
    }
  }

  if (config.spam.enabled) {
    const windowMs = Math.max(config.spam.seconds * 1000, DUPLICATE_WINDOW_MS);
    const history = tracker.record(facts.userId, facts.content, facts.at, windowMs);
    const recent = history.filter((e) => facts.at - e.at <= config.spam.seconds * 1000);
    if (recent.length > config.spam.messages) return { rule: "spam", message: "you're sending messages too fast" };
    const hash = history[history.length - 1].hash;
    if (hash && history.filter((e) => e.hash === hash).length >= config.spam.duplicates) {
      return { rule: "duplicates", message: "please don't repeat the same message" };
    }
  }

  return undefined;
}
