// Pure feed logic: reading what admins type, parsing the sources' responses,
// picking what's new, and rendering posts. No SDK or network imports, so the
// tests cover all of it offline.

export type FeedKind = "youtube" | "reddit" | "twitch" | "kick";
export const FEED_KINDS: FeedKind[] = ["youtube", "reddit", "twitch", "kick"];

/** One upload, post, or stream, normalized across sources. */
export interface FeedItem {
  id: string;
  title: string;
  url: string;
  author: string;
  /** Epoch ms, when the source says. */
  publishedAt?: number;
  /** Twitch/Kick category. */
  game?: string;
  nsfw?: boolean;
}

/** What a feed remembers between checks (stored as JSON). */
export interface FeedState {
  /** False until the first successful check has recorded what already exists. */
  baseline?: boolean;
  /** Recently seen item IDs, newest first (uploads and posts). */
  seen?: string[];
  /** The last stream announced or seen at baseline (Twitch/Kick). */
  liveId?: string | null;
}

export const SEEN_LIMIT = 200;
/** Most items one check posts; anything beyond is marked seen and skipped. */
export const MAX_POSTS_PER_CHECK = 3;
/** A stream that restarts within this long isn't announced again. */
export const LIVE_COOLDOWN_MS = 30 * 60_000;

export const DEFAULT_TEMPLATES: Record<FeedKind, string> = {
  youtube: "📺 **{author}** uploaded a new video: **{title}**\n{url}",
  reddit: "📰 New post in **r/{source}** by u/{author}: **{title}**\n{url}",
  twitch: "🔴 **{author}** is live on Twitch!\n**{title}**\n{url}",
  kick: "🟢 **{author}** is live on Kick!\n**{title}**\n{url}",
};

export const TEMPLATE_PLACEHOLDERS = ["{title}", "{url}", "{author}", "{source}", "{game}", "{role}"];

// --- Reading what admins type ------------------------------------------------

/** A pasted link may arrive as "<url>" or a Markdown link "[text](url)". */
export function unwrapLink(input: string): string {
  let text = input.trim();
  const md = /^\[[^\]]*\]\(([^)\s]+)\)$/.exec(text);
  if (md) text = md[1];
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1);
  return text.trim();
}

const YT_ID = /^UC[\w-]{22}$/;

export type YouTubeInput = { channelId: string } | { resolveUrl: string };

/**
 * A channel ID or /channel/ URL is used as is; @handles and /c/ or /user/
 * links need the channel page fetched to find the ID.
 */
export function parseYouTubeInput(input: string): YouTubeInput | undefined {
  const text = unwrapLink(input);
  if (YT_ID.test(text)) return { channelId: text };
  if (/^@[\w.-]{3,30}$/.test(text)) return { resolveUrl: `https://www.youtube.com/${text}` };
  const url = parseUrl(text);
  if (!url || !/(^|\.)youtube\.com$/i.test(url.hostname)) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "channel" && parts[1] && YT_ID.test(parts[1])) return { channelId: parts[1] };
  if (parts[0]?.startsWith("@") && /^@[\w.%-]{3,60}$/.test(parts[0])) return { resolveUrl: `https://www.youtube.com/${parts[0]}` };
  if ((parts[0] === "c" || parts[0] === "user") && parts[1] && /^[\w.-]{1,100}$/.test(parts[1])) {
    return { resolveUrl: `https://www.youtube.com/${parts[0]}/${parts[1]}` };
  }
  return undefined;
}

/** The channel ID from a YouTube channel page, or undefined. */
export function channelIdFromPage(html: string): string | undefined {
  const patterns = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
    /<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/,
    /"browseId":"(UC[\w-]{22})"/,
  ];
  for (const p of patterns) {
    const m = p.exec(html);
    if (m) return m[1];
  }
  return undefined;
}

/** "r/Games", "/r/games/", a subreddit URL, or just the name. Lowercased. */
export function parseSubreddit(input: string): string | undefined {
  let text = unwrapLink(input);
  const url = parseUrl(text);
  if (url) {
    if (!/(^|\.)reddit\.com$/i.test(url.hostname)) return undefined;
    text = url.pathname;
  }
  const m = /^\/?(?:r\/)?([A-Za-z0-9][A-Za-z0-9_]{1,20})\/?$/.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

/** A Twitch login from "name" or a twitch.tv link. Lowercased. */
export function parseTwitchLogin(input: string): string | undefined {
  return parseStreamer(input, /(^|\.)twitch\.tv$/i, /^[A-Za-z0-9_]{3,25}$/);
}

/** A Kick channel slug from "name" or a kick.com link. Lowercased. */
export function parseKickSlug(input: string): string | undefined {
  return parseStreamer(input, /(^|\.)kick\.com$/i, /^[A-Za-z0-9_-]{3,25}$/);
}

function parseStreamer(input: string, host: RegExp, name: RegExp): string | undefined {
  let text = unwrapLink(input);
  const url = parseUrl(text);
  if (url) {
    if (!host.test(url.hostname)) return undefined;
    text = url.pathname.split("/").filter(Boolean)[0] ?? "";
  }
  text = text.replace(/^@/, "");
  return name.test(text) ? text.toLowerCase() : undefined;
}

function parseUrl(text: string): URL | undefined {
  const candidate = /^[a-z]+:\/\//i.test(text) ? text : /^(www\.)?[\w-]+\.(com|tv)\//i.test(text) ? `https://${text}` : undefined;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function sourceUrl(kind: FeedKind, source: string): string {
  switch (kind) {
    case "youtube":
      return `https://www.youtube.com/channel/${source}`;
    case "reddit":
      return `https://www.reddit.com/r/${source}`;
    case "twitch":
      return `https://www.twitch.tv/${source}`;
    case "kick":
      return `https://kick.com/${source}`;
  }
}

// --- Parsing responses ---------------------------------------------------------

export function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]).trim() : undefined;
}

function attr(xml: string, element: string, name: string, where?: RegExp): string | undefined {
  const re = new RegExp(`<${element}\\b[^>]*>`, "g");
  for (const m of xml.matchAll(re)) {
    if (where && !where.test(m[0])) continue;
    const a = new RegExp(`\\b${name}="([^"]*)"`).exec(m[0]);
    if (a) return decodeEntities(a[1]);
  }
  return undefined;
}

function entries(xml: string): string[] {
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
}

function timeOf(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : undefined;
}

/** A YouTube channel's Atom feed: its title and latest uploads (newest first). */
export function parseYouTubeFeed(xml: string): { title: string; items: FeedItem[] } {
  const head = xml.split(/<entry\b/)[0];
  const title = tag(head, "title") ?? "";
  const items: FeedItem[] = [];
  for (const e of entries(xml)) {
    const id = tag(e, "yt:videoId");
    if (!id) continue;
    items.push({
      id,
      title: tag(e, "title") ?? "",
      url: attr(e, "link", "href", /rel="alternate"/) ?? `https://www.youtube.com/watch?v=${id}`,
      author: tag(tag(e, "author") ?? "", "name") ?? title,
      publishedAt: timeOf(tag(e, "published")),
    });
  }
  return { title, items };
}

/** reddit.com/r/<sub>/new.json */
export function parseRedditJson(body: unknown): FeedItem[] {
  const children = (body as { data?: { children?: unknown[] } } | null)?.data?.children;
  if (!Array.isArray(children)) throw new Error("Reddit returned an unexpected response.");
  const items: FeedItem[] = [];
  for (const child of children) {
    const d = (child as { data?: Record<string, unknown> } | null)?.data;
    if (!d || typeof d.id !== "string") continue;
    const permalink = typeof d.permalink === "string" ? d.permalink : "";
    items.push({
      id: d.id,
      title: typeof d.title === "string" ? d.title : "",
      url: permalink.startsWith("/") ? `https://www.reddit.com${permalink}` : `https://redd.it/${d.id}`,
      author: typeof d.author === "string" ? d.author : "",
      publishedAt: typeof d.created_utc === "number" ? d.created_utc * 1000 : undefined,
      nsfw: d.over_18 === true,
    });
  }
  return items;
}

/** reddit.com/r/<sub>/new/.rss (Atom), the fallback when JSON is refused. */
export function parseRedditAtom(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const e of entries(xml)) {
    const rawId = tag(e, "id");
    if (!rawId) continue;
    const id = rawId.replace(/^t3_/, "");
    const author = (tag(tag(e, "author") ?? "", "name") ?? "").replace(/^\/?u\//, "");
    items.push({
      id,
      title: tag(e, "title") ?? "",
      url: attr(e, "link", "href") ?? `https://redd.it/${id}`,
      author,
      publishedAt: timeOf(tag(e, "published") ?? tag(e, "updated")),
    });
  }
  return items;
}

/** helix/streams: the live stream, or undefined when offline. */
export function parseTwitchStream(body: unknown, login: string): FeedItem | undefined {
  const data = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Twitch returned an unexpected response.");
  const s = data[0] as Record<string, unknown> | undefined;
  if (!s || typeof s.id !== "string" || (s.type !== undefined && s.type !== "live")) return undefined;
  return {
    id: s.id,
    title: typeof s.title === "string" ? s.title : "",
    url: `https://www.twitch.tv/${login}`,
    author: typeof s.user_name === "string" && s.user_name ? s.user_name : login,
    publishedAt: timeOf(typeof s.started_at === "string" ? s.started_at : undefined),
    game: typeof s.game_name === "string" ? s.game_name : undefined,
  };
}

/** kick.com/api/v2/channels/<slug>: display name and the live stream, if any. */
export function parseKickChannel(body: unknown, slug: string): { name: string; live: FeedItem | undefined } {
  const c = body as Record<string, unknown> | null;
  if (!c || typeof c !== "object" || (!("livestream" in c) && !("user" in c))) {
    throw new Error("Kick returned an unexpected response.");
  }
  const user = c.user as Record<string, unknown> | undefined;
  const name = typeof user?.username === "string" && user.username ? user.username : slug;
  const ls = c.livestream as Record<string, unknown> | null | undefined;
  if (!ls || ls.is_live === false || (typeof ls.id !== "number" && typeof ls.id !== "string")) return { name, live: undefined };
  const categories = Array.isArray(ls.categories) ? (ls.categories as Array<{ name?: unknown }>) : [];
  return {
    name,
    live: {
      id: String(ls.id),
      title: typeof ls.session_title === "string" ? ls.session_title : "",
      url: `https://kick.com/${slug}`,
      author: name,
      publishedAt: typeof ls.created_at === "string" ? kickTime(ls.created_at) : undefined,
      game: typeof categories[0]?.name === "string" ? categories[0].name : undefined,
    },
  };
}

/** Kick writes "2025-01-31 18:04:05" in UTC, without a zone. */
function kickTime(text: string): number | undefined {
  const iso = text.includes("T") ? text : text.replace(" ", "T");
  return timeOf(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
}

// --- Deciding what to post -------------------------------------------------------

export interface Selection {
  /** Items to post, oldest first. */
  post: FeedItem[];
  state: FeedState;
}

/**
 * Upload/post feeds. The first successful check only records what exists
 * (no backlog). After that, an item is new if it wasn't seen before and
 * wasn't published before the feed was added; at most `cap` of the newest
 * are posted and the rest are just marked seen.
 */
export function selectNewItems(items: FeedItem[], state: FeedState, addedAt: number, cap = MAX_POSTS_PER_CHECK): Selection {
  const seen = state.seen ?? [];
  const seenSet = new Set(seen);
  const nextSeen = [...new Set([...items.map((i) => i.id), ...seen])].slice(0, SEEN_LIMIT);
  if (!state.baseline) return { post: [], state: { ...state, baseline: true, seen: nextSeen } };
  const fresh = items
    .filter((i) => !seenSet.has(i.id) && !i.nsfw)
    .filter((i) => i.publishedAt === undefined || i.publishedAt >= addedAt)
    .sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0));
  return { post: fresh.slice(-cap), state: { ...state, seen: nextSeen } };
}

/**
 * Live feeds. A stream is announced once, when its ID first shows up. A
 * stream already live when the feed was added isn't announced, and neither
 * is a restart shortly after the last announcement.
 */
export function selectLive(live: FeedItem | undefined, state: FeedState, lastPostAt: number | null, now = Date.now()): Selection {
  if (!state.baseline) return { post: [], state: { ...state, baseline: true, liveId: live?.id ?? null } };
  if (!live || live.id === state.liveId) return { post: [], state };
  const next = { ...state, liveId: live.id };
  if (lastPostAt && now - lastPostAt < LIVE_COOLDOWN_MS) return { post: [], state: next };
  return { post: [live], state: next };
}

// --- Rendering -------------------------------------------------------------------

/** Escapes text from outside sources so it can't form links, mentions, or formatting. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_~[\]<>|#]/g, (c) => `\\${c}`).replace(/\s+/g, " ").trim();
}

/** Only plain web links go in a post, with nothing that could break out of it. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.toString().replace(/[\s<>()[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  } catch {
    return "";
  }
}

export interface RenderInput {
  kind: FeedKind;
  source: string;
  template: string;
  /** Rendered role mention, or "" for none. */
  roleMention: string;
  item: FeedItem;
}

/** Fills the template. A role mention with no {role} in the template goes first. */
export function renderPost({ kind, source, template, roleMention, item }: RenderInput, maxLength = 9500): string {
  const tpl = template.trim() || DEFAULT_TEMPLATES[kind];
  const vars: Record<string, string> = {
    title: escapeMarkdown(truncateText(item.title || "(untitled)", 300)),
    url: safeUrl(item.url),
    author: escapeMarkdown(truncateText(item.author, 100)),
    source: escapeMarkdown(source),
    game: escapeMarkdown(truncateText(item.game ?? "", 100)),
    role: roleMention,
  };
  let out = tpl.replace(/\{([a-z]+)\}/gi, (whole, key: string) => vars[key.toLowerCase()] ?? whole);
  if (roleMention && !/\{role\}/i.test(tpl)) out = `${roleMention} ${out}`;
  return truncateText(out, maxLength);
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// --- Timing ------------------------------------------------------------------------

export const MIN_POLL_MINUTES = 5;
export const MAX_POLL_MINUTES = 24 * 60;
const MAX_BACKOFF_MS = 6 * 3_600_000;

/** Time until the next check: the interval, doubled per consecutive failure (capped). */
export function nextDelayMs(pollMinutes: number, failures: number): number {
  const base = Math.min(Math.max(pollMinutes, MIN_POLL_MINUTES), MAX_POLL_MINUTES) * 60_000;
  if (failures <= 0) return base;
  return Math.max(base, Math.min(base * 2 ** Math.min(failures, 8), MAX_BACKOFF_MS));
}

/** Spreads feeds over the interval so they don't all poll in the same minute. */
export function staggerMs(id: number, pollMinutes: number): number {
  const interval = Math.max(pollMinutes, MIN_POLL_MINUTES) * 60_000;
  return ((id * 97_003) % interval + interval) % interval;
}
