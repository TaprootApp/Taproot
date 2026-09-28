import {
  channelIdFromPage,
  FeedItem,
  parseKickChannel,
  parseRedditAtom,
  parseRedditJson,
  parseTwitchStream,
  parseYouTubeFeed,
  parseYouTubeInput,
} from "./logic";

// Outbound requests to the feed sources. Everything uses fetch with a
// timeout and a descriptive User-Agent; failures throw FeedError with a
// sentence an admin can act on (it's shown as the feed's last error).

const TIMEOUT_MS = 15_000;
const MAX_BODY = 4 * 1024 * 1024;
const USER_AGENT = "Taproot/1.1 (moderation app for Root communities; https://rootapp.com)";

export class FeedError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the source answered. */
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request(url: string, init: RequestInit = {}, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new FeedError(timedOut ? `${what} didn't answer in time.` : `Couldn't reach ${what}.`);
  }
  return res;
}

async function body(res: Response, what: string): Promise<string> {
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) throw new FeedError(`${what} sent a response that's too large.`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new FeedError(`${what} sent a response that's too large.`);
  return text;
}

function statusError(res: Response, what: string): FeedError {
  if (res.status === 404) return new FeedError(`${what} says it doesn't exist (404).`, 404);
  if (res.status === 429) return new FeedError(`${what} is rate limiting requests (429).`, 429);
  if (res.status === 401 || res.status === 403) return new FeedError(`${what} refused the request (${res.status}).`, res.status);
  return new FeedError(`${what} returned an error (${res.status}).`, res.status);
}

async function getText(url: string, what: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await request(url, { headers }, what);
  if (!res.ok) throw statusError(res, what);
  return body(res, what);
}

async function getJson(url: string, what: string, headers: Record<string, string> = {}): Promise<unknown> {
  const text = await getText(url, what, { Accept: "application/json", ...headers });
  try {
    return JSON.parse(text);
  } catch {
    throw new FeedError(`${what} sent something that isn't JSON.`);
  }
}

// --- YouTube -------------------------------------------------------------------

/** Resolves what the admin typed to a channel ID and title. */
export async function resolveYouTube(input: string): Promise<{ channelId: string; title: string }> {
  const parsed = parseYouTubeInput(input);
  if (!parsed) throw new FeedError("Give a YouTube channel link, @handle, or channel ID (starts with UC).");
  let channelId: string;
  if ("channelId" in parsed) channelId = parsed.channelId;
  else {
    // The consent cookie skips the EU cookie wall, which has no channel ID on it.
    const html = await getText(parsed.resolveUrl, "YouTube", { "Accept-Language": "en", Cookie: "SOCS=CAI; CONSENT=YES+1" });
    channelId = channelIdFromPage(html) ?? "";
    if (!channelId) throw new FeedError("I couldn't find the channel ID on that page. Paste the channel ID (starts with UC) instead.");
  }
  const feed = await fetchYouTube(channelId);
  return { channelId, title: feed.title || channelId };
}

export async function fetchYouTube(channelId: string): Promise<{ title: string; items: FeedItem[] }> {
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, "YouTube");
  if (!/<feed\b/.test(xml)) throw new FeedError("YouTube sent an unexpected response.");
  return parseYouTubeFeed(xml);
}

// --- Reddit --------------------------------------------------------------------

/** Newest posts. Reddit often refuses unauthenticated JSON, so the RSS feed is the fallback. */
export async function fetchReddit(subreddit: string): Promise<FeedItem[]> {
  const sub = encodeURIComponent(subreddit);
  try {
    return parseRedditJson(await getJson(`https://www.reddit.com/r/${sub}/new.json?limit=25&raw_json=1`, "Reddit"));
  } catch (err) {
    if (err instanceof FeedError && err.status === 404) throw new FeedError(`r/${subreddit} doesn't exist or is banned.`, 404);
    const xml = await getText(`https://www.reddit.com/r/${sub}/new/.rss?limit=25`, "Reddit", { Accept: "application/atom+xml" });
    if (!/<feed\b/.test(xml)) throw new FeedError("Reddit sent an unexpected response.");
    return parseRedditAtom(xml);
  }
}

/** Checks a subreddit exists and is readable; returns its display name. */
export async function resolveReddit(subreddit: string): Promise<string> {
  await fetchReddit(subreddit);
  return `r/${subreddit}`;
}

// --- Twitch --------------------------------------------------------------------

export interface TwitchCredentials {
  clientId: string;
  clientSecret: string;
}

// The app access token lives only in memory; it lasts about two months and
// is fetched again after a restart or when Twitch rejects it.
let token: { value: string; clientId: string; expiresAt: number } | undefined;

export function forgetTwitchToken(): void {
  token = undefined;
}

async function twitchToken(creds: TwitchCredentials): Promise<string> {
  if (token && token.clientId === creds.clientId && token.expiresAt > Date.now() + 60_000) return token.value;
  const res = await request(
    "https://id.twitch.tv/oauth2/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: "client_credentials" }).toString(),
    },
    "Twitch",
  );
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new FeedError("Twitch rejected the client ID or secret. Check them on the Feeds page.", res.status);
  }
  if (!res.ok) throw statusError(res, "Twitch");
  let data: { access_token?: unknown; expires_in?: unknown };
  try {
    data = JSON.parse(await body(res, "Twitch")) as typeof data;
  } catch {
    throw new FeedError("Twitch sent something that isn't JSON.");
  }
  if (typeof data.access_token !== "string") throw new FeedError("Twitch didn't return a token.");
  const ttl = typeof data.expires_in === "number" ? data.expires_in * 1000 : 3_600_000;
  token = { value: data.access_token, clientId: creds.clientId, expiresAt: Date.now() + ttl };
  return token.value;
}

async function helix(path: string, creds: TwitchCredentials): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const access = await twitchToken(creds);
    const res = await request(`https://api.twitch.tv/helix/${path}`, { headers: { "Client-Id": creds.clientId, Authorization: `Bearer ${access}` } }, "Twitch");
    // An expired or revoked token: get a new one and try once more.
    if (res.status === 401 && attempt === 0) {
      forgetTwitchToken();
      continue;
    }
    if (!res.ok) throw statusError(res, "Twitch");
    try {
      return JSON.parse(await body(res, "Twitch"));
    } catch {
      throw new FeedError("Twitch sent something that isn't JSON.");
    }
  }
}

/** Checks the login exists; returns the display name. */
export async function resolveTwitch(login: string, creds: TwitchCredentials): Promise<string> {
  const data = (await helix(`users?login=${encodeURIComponent(login)}`, creds)) as { data?: Array<{ display_name?: unknown }> };
  const user = Array.isArray(data?.data) ? data.data[0] : undefined;
  if (!user) throw new FeedError(`There's no Twitch channel called ${login}.`, 404);
  return typeof user.display_name === "string" && user.display_name ? user.display_name : login;
}

export async function fetchTwitch(login: string, creds: TwitchCredentials): Promise<FeedItem | undefined> {
  return parseTwitchStream(await helix(`streams?user_login=${encodeURIComponent(login)}`, creds), login);
}

// --- Kick ------------------------------------------------------------------------

// Kick has no keyless public API. This is the endpoint its website uses; it
// sits behind bot protection that sometimes refuses server requests, so
// failures back off like any other and show on the Feeds page.
export async function fetchKick(slug: string): Promise<{ name: string; live: FeedItem | undefined }> {
  let data: unknown;
  try {
    data = await getJson(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, "Kick");
  } catch (err) {
    if (err instanceof FeedError && err.status === 404) throw new FeedError(`There's no Kick channel called ${slug}.`, 404);
    if (err instanceof FeedError && err.status === 403) {
      throw new FeedError("Kick's bot protection blocked the check (403). Taproot will keep retrying.", 403);
    }
    throw err;
  }
  return parseKickChannel(data, slug);
}
