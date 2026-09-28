// Detection for the extra auto-mod filters (invites, scam links, zalgo, emoji
// spam, walls of text, repeated characters, attachment spam). Pure functions
// over message data, no SDK imports, so they can be unit tested. automod.ts
// runs them alongside the core rules and applies each rule's action.

import { externalLinks, hostOf, isAllowedHost, MessageFacts, Violation } from "../../features/automodRules";
import type { FilterConfig } from "./config";

/** Mentions and custom emoji carry IDs that could accidentally match; keep only their text. */
function visibleText(content: string): string {
  return content.replace(/\[([^\]]*)\]\(root:\/\/[^)]*\)/g, "$1");
}

// --- Invite links -------------------------------------------------------------
//
// Root doesn't document its invite URL format and there's no API to list a
// community's invite links. Invites are shared as links on Root's own domains
// (rootapp.com, rootapp.gg), so any link there that looks like an invite
// counts: /invite/<code>, /i/<code>, /join/<code>, /j/<code>, or a bare code on
// the short domain (rootapp.gg/<code>). Root's site pages (download, developer,
// support...) and subdomains like docs. and dev. are left alone. Admins allow
// their own community's codes by listing them.

const ROOT_HOST = /(^|\.)rootapp\.(com|gg)$/i;
const SITE_SUBDOMAINS = new Set(["dev", "docs", "api", "cdn", "status", "blog", "help", "support", "assets", "static"]);
const INVITE_SEGMENTS = new Set(["invite", "invites", "i", "join", "j"]);
const SITE_PAGES = new Set([
  "download",
  "developer",
  "developers",
  "support",
  "about",
  "blog",
  "privacy",
  "terms",
  "legal",
  "careers",
  "press",
  "features",
  "pricing",
  "login",
  "signup",
  "apps",
  "app",
  "docs",
  "faq",
  "contact",
  "community-guidelines",
  "guidelines",
  "security",
  "brand",
]);
const CODE = /^[A-Za-z0-9_-]{3,64}$/;
const ROOT_LINK = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)*rootapp\.(?:com|gg))(\/[^\s)<>\]]*)/gi;

/** Invite codes linked in the message (as typed; compare case-insensitively). */
export function findInviteCodes(content: string, uris: string[]): string[] {
  const candidates: Array<{ host: string; path: string }> = [];
  for (const uri of uris) {
    const m = /^https?:\/\/([^/?#:]+)(?::\d+)?(\/[^?#]*)?/i.exec(uri);
    if (m && ROOT_HOST.test(m[1])) candidates.push({ host: m[1].toLowerCase(), path: m[2] ?? "/" });
  }
  for (const m of visibleText(content).matchAll(ROOT_LINK)) {
    candidates.push({ host: m[1].toLowerCase(), path: m[2].replace(/[?#].*$/, "") });
  }

  const codes: string[] = [];
  for (const { host, path } of candidates) {
    const sub = host.replace(/\.?rootapp\.(com|gg)$/, "").replace(/^www\.?/, "");
    if (sub && SITE_SUBDOMAINS.has(sub.split(".")[0])) continue;
    const parts = path.split("/").filter(Boolean);
    let code: string | undefined;
    if (parts.length >= 2 && INVITE_SEGMENTS.has(parts[0].toLowerCase())) code = parts[1];
    else if (parts.length === 1 && host.endsWith("rootapp.gg") && !SITE_PAGES.has(parts[0].toLowerCase())) code = parts[0];
    if (code && CODE.test(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** Codes not on the allow list. */
export function blockedInvites(content: string, uris: string[], allowCodes: string[]): string[] {
  const allow = new Set(allowCodes.map((c) => c.toLowerCase()));
  return findInviteCodes(content, uris).filter((c) => !allow.has(c.toLowerCase()));
}

// --- Scam / phishing ----------------------------------------------------------
//
// A bundled list, no outside lookups. Three signals:
//   - hosts that imitate well-known brands (dlscord, steamcommunlty, r00tapp);
//   - phrases that are almost only ever scams, which count on their own;
//   - bait phrases ("free nitro", "claim your prize") that count when the
//     message also has a link.
// Admins can add known-bad domains.

interface Brand {
  /** The brand as it's really spelled in hostnames. */
  word: string;
  /** Loose pattern for the brand with common letter swaps; the real spelling must match as exactly `word`. */
  lookalike: RegExp;
  /** The real domains (and their subdomains) are always fine. */
  official: string[];
  /** A different domain named exactly the brand (discord.ru, steamcommunity.ru) is phishing too. */
  sldExact?: boolean;
}

const BRANDS: Brand[] = [
  {
    word: "discord",
    lookalike: /d[i1l!|]+[s5$]+c[o0]+r+[dcl]/,
    official: ["discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discordstatus.com", "discord.dev", "discord.new", "discord.gift"],
    sldExact: true,
  },
  {
    word: "steamcommunity",
    lookalike: /st[e3][a4]?(?:rn|m)+-?c[o0](?:rn|m)+[uv]n[i1l|]ty/,
    official: ["steamcommunity.com"],
    sldExact: true,
  },
  {
    word: "steampowered",
    lookalike: /st[e3][a4]?(?:rn|m)+-?p[o0]w[e3]r[e3]d/,
    official: ["steampowered.com"],
    sldExact: true,
  },
  { word: "rootapp", lookalike: /r[o0]{2,}t-?[a4]pp/, official: ["rootapp.com", "rootapp.gg"], sldExact: true },
  { word: "paypal", lookalike: /p[a4@]yp[a4@][l1i]/, official: ["paypal.com", "paypal.me", "paypalobjects.com"] },
  { word: "roblox", lookalike: /r[o0]b[l1i][o0]x/, official: ["roblox.com", "rbxcdn.com", "roblox.cn"] },
  { word: "epicgames", lookalike: /[e3]p[i1l]c-?g[a4]m[e3]s/, official: ["epicgames.com", "epicgames.dev"] },
  { word: "twitch", lookalike: /tw[i1l]tch/, official: ["twitch.tv", "twitchcdn.net", "twitchsvc.net"] },
];

/** Generic bait in a hostname, e.g. free-nitro-gift.xyz. */
const BAIT_HOST = /(free|gift|claim|airdrop|giveaway)[.-]?(nitro|robux|skins?|steam|crypto|nft|gift)|(nitro|robux|skins?)[.-]?(free|gift|claim|drop)/;
const BAIT_WORD = /nitro|gift|free|claim|drop|promo|reward|giveaway/;

/** The label before the TLD: "steamcommunity" for www.steamcommunity.ru. */
function secondLevel(host: string): string {
  const labels = host.split(".");
  return labels.length >= 2 ? labels[labels.length - 2] : host;
}

/** Phrases that are almost only ever scams, link or not. */
const STRONG_PHRASES = [
  "i accidentally reported you",
  "i accidently reported you",
  "accidentally reported your account",
  "your account will be banned",
  "your account will be suspended",
  "your account has been flagged",
  "send me your password",
  "send your password",
  "give me your password",
  "share your login",
  "verify your account to avoid",
  "double your crypto",
  "double your bitcoin",
  "send 1 get 2",
  "send 1 btc get 2",
];

/** Bait that counts only alongside a link. */
const LINK_PHRASES = [
  "free nitro",
  "nitro for free",
  "free discord nitro",
  "free robux",
  "free steam",
  "steam gift",
  "free skins",
  "free gift",
  "gift for you",
  "claim your prize",
  "claim your reward",
  "claim your gift",
  "claim now",
  "you have won",
  "you won a",
  "you've won",
  "free crypto",
  "crypto giveaway",
  "airdrop",
  "nft giveaway",
  "free giveaway",
  "first 100 users",
  "limited time only",
  "verify your account",
  "login to claim",
  "log in to claim",
];

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ");
}

/** Hostnames linked in the message, from its URIs and bare domains in the text. */
export function linkedHosts(content: string, uris: string[]): string[] {
  const hosts = new Set<string>();
  for (const uri of uris) {
    const host = hostOf(uri);
    if (host) hosts.add(host);
  }
  for (const m of visibleText(content).matchAll(/\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,24})(?=[/\s:?#.,!;)\]>]|$)/gi)) {
    // Bare "word.word" without a scheme only counts when it has a path or a
    // well-known TLD shape; hostOf-style strictness keeps "e.g." out.
    const host = m[1].toLowerCase();
    if (/^(e\.g|i\.e|etc)\./.test(host)) continue;
    if (m[0].includes("://") || /\.(com|net|org|io|gg|co|xyz|me|ru|info|biz|tv|app|dev|link|ly|to|us|uk|de|site|online|shop|live|store|club|gift|top|icu|pw|cc|ga|tk|ml|cf|gq)$/.test(host)) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

function isLookalike(host: string): boolean {
  const bare = host.replace(/^www\./, "");
  for (const brand of BRANDS) {
    if (isAllowedHost(bare, brand.official)) continue;
    const m = brand.lookalike.exec(bare);
    if (m && m[0] !== brand.word) return true;
    if (brand.sldExact && secondLevel(bare) === brand.word) return true;
    if (bare.includes(brand.word) && BAIT_WORD.test(bare.replace(brand.word, ""))) return true;
  }
  return BAIT_HOST.test(bare);
}

/** A short reason when the message looks like a scam, else undefined. */
export function scamReason(content: string, uris: string[], extraDomains: string[]): string | undefined {
  const hosts = linkedHosts(content, uris);
  for (const host of hosts) {
    if (extraDomains.length && isAllowedHost(host, extraDomains)) return `known scam domain (${host})`;
    if (isLookalike(host)) return `lookalike domain (${host})`;
  }
  const text = normalizeText(visibleText(content));
  for (const phrase of STRONG_PHRASES) if (text.includes(phrase)) return "scam phrase";
  if (hosts.length > 0) {
    for (const phrase of LINK_PHRASES) if (text.includes(phrase)) return "scam bait with a link";
  }
  return undefined;
}

// --- Zalgo --------------------------------------------------------------------

/**
 * Zalgo stacks many combining marks on one character. Real scripts use at
 * most two or three in a row (Vietnamese, Devanagari), so four or more
 * consecutive marks, or a message that's mostly marks, counts.
 */
export function isZalgo(content: string): boolean {
  const text = visibleText(content);
  if (/\p{M}{4,}/u.test(text)) return true;
  const marks = text.match(/\p{Mn}/gu)?.length ?? 0;
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return marks >= 12 && marks > letters;
}

// --- Emoji --------------------------------------------------------------------

const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:️|\p{EMod})?(?:‍\p{Extended_Pictographic}(?:️|\p{EMod})?)*|[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const CUSTOM_EMOJI = /\[[^\]]*\]\(root:\/\/emoji\/[^)]*\)|:[a-z][a-z0-9_+-]{1,31}:/gi;

/** Unicode emoji (a ZWJ family or flag counts once) plus custom and :shortcode: emoji. */
export function countEmoji(content: string): number {
  const custom = content.match(CUSTOM_EMOJI)?.length ?? 0;
  const rest = content.replace(CUSTOM_EMOJI, " ");
  // Keycap digits and © ® are pictographic too but aren't emoji spam.
  const unicode = (rest.match(EMOJI_SEQUENCE) ?? []).filter((e) => !/^[©®‼⁉™]$/.test(e)).length;
  return custom + unicode;
}

// --- Wall of text -------------------------------------------------------------

export function wallOfText(content: string, maxLines: number, maxChars: number): "lines" | "chars" | undefined {
  if (content.split(/\r?\n/).length > maxLines) return "lines";
  if (visibleText(content).length > maxChars) return "chars";
  return undefined;
}

// --- Repeated characters ------------------------------------------------------

/** Length of the longest run of one character (case-insensitive, whitespace ignored). */
export function longestRun(content: string): number {
  const chars = Array.from(visibleText(content).toLowerCase());
  let best = 0;
  let run = 0;
  let prev = "";
  for (const c of chars) {
    if (/\s/.test(c)) {
      prev = "";
      run = 0;
      continue;
    }
    run = c === prev ? run + 1 : 1;
    prev = c;
    if (run > best) best = run;
  }
  return best;
}

// --- Attachments --------------------------------------------------------------

export function countAttachments(uris: Array<{ uri: string; attachment?: unknown }>): number {
  return uris.filter((u) => u.attachment !== undefined && u.attachment !== null).length;
}

// --- Running the filters ------------------------------------------------------

export interface ExtraFacts extends MessageFacts {
  attachmentCount: number;
  /** How long ago the author joined; undefined when unknown. */
  memberForMs?: number;
}

/**
 * Scam and invite links run before the core rules, so they get their own
 * (usually stricter) action instead of the links rule's.
 */
export function checkPriorityFilters(facts: ExtraFacts, f: FilterConfig): Violation | undefined {
  if (f.scam.enabled && scamReason(facts.content, facts.uris, f.scam.extraDomains)) {
    return { rule: "scam", message: "that message looked like a scam and was removed" };
  }
  if (f.invites.enabled && blockedInvites(facts.content, facts.uris, f.invites.allowCodes).length > 0) {
    return { rule: "invites", message: "invite links to other communities aren't allowed here" };
  }
  return undefined;
}

/** The remaining extra filters, after the core rules. */
export function checkExtraFilters(facts: ExtraFacts, f: FilterConfig): Violation | undefined {
  if (
    f.newMemberLinks.enabled &&
    facts.memberForMs !== undefined &&
    facts.memberForMs < f.newMemberLinks.minutes * 60_000 &&
    externalLinks(facts).length > 0
  ) {
    return { rule: "newMemberLinks", message: "new members can't post links yet" };
  }
  if (f.attachments.enabled && facts.attachmentCount > f.attachments.max) {
    return { rule: "attachments", message: "too many attachments in one message" };
  }
  if (f.emoji.enabled && countEmoji(facts.content) > f.emoji.max) {
    return { rule: "emoji", message: "too many emoji in one message" };
  }
  if (f.zalgo.enabled && isZalgo(facts.content)) {
    return { rule: "zalgo", message: "please don't use zalgo text" };
  }
  if (f.repeated.enabled && longestRun(facts.content) > f.repeated.max) {
    return { rule: "repeated", message: "please don't spam repeated characters" };
  }
  if (f.newlines.enabled && wallOfText(facts.content, f.newlines.maxLines, f.newlines.maxChars)) {
    return { rule: "newlines", message: "that message was too long; please break it up" };
  }
  return undefined;
}
