// Reactions report standard emoji as ":name:" and community emoji as
// ":name:emojiId:"; messages write community emoji as links. The name is the
// stable part, so panels match reactions on it. Pure: no SDK imports.

import { EMOJI_MAP } from "../lib/emojiMap";

export function emojiKey(shortcode: string): string {
  return shortcode.split(":").filter(Boolean)[0]?.toLowerCase() ?? "";
}

/** The ":name:" form an admin types, from either reaction shortcode form. */
export function emojiAsTyped(shortcode: string): string {
  const name = shortcode.split(":").filter(Boolean)[0];
  return name ? `:${name}:` : shortcode;
}

/**
 * The Unicode text for a standard ":name:" shortcode, e.g. ":tada:" -> "🎉".
 * Root only turns shortcodes into emoji for reactions, not in message text.
 * Anything it doesn't know (community emoji, typos) comes back unchanged.
 */
export function shortcodeToUnicode(shortcode: string): string {
  const match = /^:([^:\s]+):$/.exec(shortcode.trim());
  return (match && Object.prototype.hasOwnProperty.call(EMOJI_MAP, match[1]) && EMOJI_MAP[match[1]]) || shortcode;
}

/** How an emoji is written in message text: Unicode, or a link for community emoji. */
export function emojiDisplay(shortcode: string): string {
  const parts = shortcode.split(":").filter(Boolean);
  return parts.length > 1 ? `[:${parts[0]}:](root://emoji/:${parts[0]}:)` : shortcodeToUnicode(shortcode);
}
