import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelIdFromPage,
  escapeMarkdown,
  FeedItem,
  nextDelayMs,
  parseKickChannel,
  parseKickSlug,
  parseRedditAtom,
  parseRedditJson,
  parseSubreddit,
  parseTwitchLogin,
  parseTwitchStream,
  parseYouTubeFeed,
  parseYouTubeInput,
  renderPost,
  safeUrl,
  selectLive,
  selectNewItems,
  staggerMs,
} from "../src/modules/feeds/logic";
import { grantPatch, stripGrant } from "../src/modules/feeds/voiceLogic";

const UC = "UCabcdefghijklmnopqrstuv";

test("YouTube input: IDs, channel links, handles", () => {
  assert.deepEqual(parseYouTubeInput(UC), { channelId: UC });
  assert.deepEqual(parseYouTubeInput(`https://www.youtube.com/channel/${UC}/videos`), { channelId: UC });
  assert.deepEqual(parseYouTubeInput(`<https://youtube.com/channel/${UC}>`), { channelId: UC });
  assert.deepEqual(parseYouTubeInput("@SomeCreator"), { resolveUrl: "https://www.youtube.com/@SomeCreator" });
  assert.deepEqual(parseYouTubeInput("https://m.youtube.com/@SomeCreator/featured"), { resolveUrl: "https://www.youtube.com/@SomeCreator" });
  assert.deepEqual(parseYouTubeInput("youtube.com/c/Legacy"), { resolveUrl: "https://www.youtube.com/c/Legacy" });
  assert.equal(parseYouTubeInput("https://evil.com/channel/" + UC), undefined);
  assert.equal(parseYouTubeInput("hello"), undefined);
});

test("channel ID from a channel page prefers the canonical link", () => {
  const html = `<x "browseId":"UCzzzzzzzzzzzzzzzzzzzzzz"><link rel="canonical" href="https://www.youtube.com/channel/${UC}">`;
  assert.equal(channelIdFromPage(html), UC);
  assert.equal(channelIdFromPage("<html>nothing</html>"), undefined);
});

test("subreddit, Twitch and Kick names", () => {
  assert.equal(parseSubreddit("r/Gaming"), "gaming");
  assert.equal(parseSubreddit("/r/rust/"), "rust");
  assert.equal(parseSubreddit("https://www.reddit.com/r/AskReddit/new"), undefined);
  assert.equal(parseSubreddit("https://old.reddit.com/r/AskReddit/"), "askreddit");
  assert.equal(parseSubreddit("r/a"), undefined);
  assert.equal(parseTwitchLogin("https://www.twitch.tv/Shroud"), "shroud");
  assert.equal(parseTwitchLogin("bad name"), undefined);
  assert.equal(parseTwitchLogin("https://kick.com/shroud"), undefined);
  assert.equal(parseKickSlug("kick.com/some-streamer"), "some-streamer");
});

test("YouTube Atom feed", () => {
  const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Cool &amp; Co</title>
    <entry><id>yt:video:abc</id><yt:videoId>abc</yt:videoId><title>First &quot;one&quot;</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc"/><author><name>Cool &amp; Co</name></author>
    <published>2026-09-01T10:00:00+00:00</published></entry></feed>`;
  const feed = parseYouTubeFeed(xml);
  assert.equal(feed.title, "Cool & Co");
  assert.equal(feed.items.length, 1);
  assert.deepEqual(feed.items[0], {
    id: "abc",
    title: 'First "one"',
    url: "https://www.youtube.com/watch?v=abc",
    author: "Cool & Co",
    publishedAt: Date.parse("2026-09-01T10:00:00Z"),
  });
});

test("Reddit JSON and Atom", () => {
  const json = { data: { children: [{ kind: "t3", data: { id: "x1", title: "Hi", permalink: "/r/a/comments/x1/hi/", author: "bob", created_utc: 100, over_18: true } }] } };
  assert.deepEqual(parseRedditJson(json), [
    { id: "x1", title: "Hi", url: "https://www.reddit.com/r/a/comments/x1/hi/", author: "bob", publishedAt: 100_000, nsfw: true },
  ]);
  assert.throws(() => parseRedditJson({ error: 403 }));
  const atom = `<feed><entry><author><name>/u/amy</name></author><id>t3_y2</id><link href="https://www.reddit.com/r/a/comments/y2/x/"/><published>2026-01-01T00:00:00+00:00</published><title>Yo</title></entry></feed>`;
  assert.deepEqual(parseRedditAtom(atom), [
    { id: "y2", title: "Yo", url: "https://www.reddit.com/r/a/comments/y2/x/", author: "amy", publishedAt: Date.parse("2026-01-01T00:00:00Z") },
  ]);
});

test("Twitch and Kick live responses", () => {
  assert.equal(parseTwitchStream({ data: [] }, "x"), undefined);
  const live = parseTwitchStream({ data: [{ id: "s1", type: "live", user_name: "Xy", title: "GG", game_name: "Chess" }] }, "xy");
  assert.equal(live?.id, "s1");
  assert.equal(live?.game, "Chess");
  assert.equal(live?.url, "https://www.twitch.tv/xy");
  assert.deepEqual(parseKickChannel({ user: { username: "Kk" }, livestream: null }, "kk"), { name: "Kk", live: undefined });
  const k = parseKickChannel({ user: { username: "Kk" }, livestream: { id: 9, session_title: "t", created_at: "2026-01-01 10:00:00", categories: [{ name: "IRL" }] } }, "kk");
  assert.equal(k.live?.id, "9");
  assert.equal(k.live?.publishedAt, Date.parse("2026-01-01T10:00:00Z"));
  assert.throws(() => parseKickChannel("<html>blocked</html>", "kk"));
});

const item = (id: string, at?: number): FeedItem => ({ id, title: id, url: `https://x.test/${id}`, author: "a", publishedAt: at });

test("first check records a baseline and posts nothing", () => {
  const r = selectNewItems([item("b", 2000), item("a", 1000)], {}, 0);
  assert.deepEqual(r.post, []);
  assert.deepEqual(r.state, { baseline: true, seen: ["b", "a"] });
});

test("new items: unseen, not older than the feed, capped, oldest first", () => {
  const state = { baseline: true, seen: ["a"] };
  const items = [item("e", 5000), item("d", 4000), item("c", 3000), item("b", 2000), item("old", 500), item("a", 1000)];
  const r = selectNewItems(items, state, 1500, 3);
  assert.deepEqual(r.post.map((i) => i.id), ["c", "d", "e"]);
  assert.ok(r.state.seen!.includes("b"), "skipped items are still marked seen");
  assert.ok(r.state.seen!.includes("old"));
  const again = selectNewItems(items, r.state, 1500, 3);
  assert.deepEqual(again.post, []);
});

test("NSFW posts are skipped", () => {
  const r = selectNewItems([{ ...item("n", 2000), nsfw: true }], { baseline: true, seen: [] }, 0);
  assert.deepEqual(r.post, []);
});

test("live: baseline, announce once, cooldown", () => {
  const s1 = selectLive(item("s1"), {}, null);
  assert.deepEqual(s1.post, []);
  assert.equal(s1.state.liveId, "s1");
  assert.deepEqual(selectLive(item("s1"), s1.state, null).post, []);
  assert.deepEqual(selectLive(undefined, s1.state, null).post, []);
  const now = 10_000_000;
  assert.equal(selectLive(item("s2"), s1.state, null, now).post.length, 1);
  const restart = selectLive(item("s3"), s1.state, now - 60_000, now);
  assert.deepEqual(restart.post, []);
  assert.equal(restart.state.liveId, "s3");
});

test("rendering escapes outside text and places the role", () => {
  const out = renderPost({
    kind: "youtube",
    source: UC,
    template: "",
    roleMention: "[@Fans](root://role/r1)",
    item: { id: "v", title: "[@Owner](root://user/1) *wow*", url: "https://www.youtube.com/watch?v=v", author: "Me_Too" },
  });
  assert.equal(out, "[@Fans](root://role/r1) 📺 **Me\\_Too** uploaded a new video: **\\[@Owner\\](root://user/1) \\*wow\\***\nhttps://www.youtube.com/watch?v=v");
  const custom = renderPost({ kind: "twitch", source: "x", template: "{role} {author} live: {game} {unknown}", roleMention: "@R", item: { ...item("s"), game: "Go" } });
  assert.equal(custom, "@R a live: Go {unknown}");
});

test("safeUrl and escapeMarkdown", () => {
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("https://a.test/x(y)"), "https://a.test/x%28y%29");
  assert.equal(escapeMarkdown("a  \n b_c"), "a b\\_c");
});

test("poll timing: backoff and stagger", () => {
  assert.equal(nextDelayMs(10, 0), 600_000);
  assert.equal(nextDelayMs(1, 0), 300_000, "minimum 5 minutes");
  assert.equal(nextDelayMs(10, 1), 1_200_000);
  assert.equal(nextDelayMs(10, 20), 6 * 3_600_000, "capped");
  const s = staggerMs(7, 10);
  assert.ok(s >= 0 && s < 600_000);
  assert.notEqual(staggerMs(1, 10), staggerMs(2, 10));
});

test("voice grant keeps explicit denials", () => {
  assert.deepEqual(grantPatch(undefined), { channelView: true, channelViewMessageHistory: true, channelCreateMessage: true });
  assert.equal(grantPatch({ channelView: false }), undefined);
  assert.deepEqual(grantPatch({ channelCreateMessage: false }), { channelView: true, channelViewMessageHistory: true });
});

test("voice revoke restores only the granted fields", () => {
  const patch = { channelView: true, channelCreateMessage: true };
  assert.equal(stripGrant({ channelView: true, channelCreateMessage: true }, null, patch), undefined);
  assert.deepEqual(stripGrant({ channelView: true, channelCreateMessage: true, channelVoiceTalk: false }, { channelVoiceTalk: false }, patch), {
    channelVoiceTalk: false,
  });
  // A mute added while in voice (createMessage false) survives.
  assert.deepEqual(stripGrant({ channelView: true, channelCreateMessage: false }, null, patch), { channelCreateMessage: false });
  assert.deepEqual(stripGrant({ channelView: true }, { channelView: false }, { channelView: true }), { channelView: false });
});
