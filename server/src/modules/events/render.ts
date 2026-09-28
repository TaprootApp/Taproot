import { channelMention, truncate, userMention } from "../../lib/text";
import { formatUtc } from "../../lib/time";
import { bar, emojiDisplay, LIVE_FILL, NUMBER_EMOJI, percentages, quoteExcerpt } from "./logic";

// Message text for giveaways, polls and starboard posts. Pure (no SDK
// imports) so the tests can cover it. Hosts, authors and roles are written
// as bold names rather than mentions, so edits and reposts never ping.
// Only the winner announcement mentions people, on purpose.

// --- Giveaways ---------------------------------------------------------------

export type GiveawayState = "running" | "ended" | "cancelled";

export interface GiveawayText {
  id: number;
  prize: string;
  winnerCount: number;
  hostName: string;
  roleName?: string;
  endsAt: number;
  state: GiveawayState;
  entries: number;
  /** Winners of the first draw (rerolls are announced separately). */
  winners: Array<{ id: string; name: string }>;
}

export function renderGiveaway(g: GiveawayText): string {
  if (g.state === "cancelled") {
    return [`🎉 **GIVEAWAY CANCELLED**`, `~~${g.prize}~~`, "", `*Giveaway #${g.id}*`].join("\n");
  }
  const lines: string[] = [];
  if (g.state === "running") {
    lines.push("🎉 **GIVEAWAY** 🎉", `**${g.prize}**`, "", "React with 🎉 to enter!");
    lines.push(`**Winners:** ${g.winnerCount}`);
    lines.push(`**Ends:** ${formatUtc(g.endsAt)}`);
  } else {
    lines.push("🎉 **GIVEAWAY ENDED** 🎉", `**${g.prize}**`, "");
    lines.push(
      g.winners.length
        ? `**${g.winners.length === 1 ? "Winner" : "Winners"}:** ${g.winners.map((w) => `**${w.name}**`).join(", ")}`
        : "**Winners:** nobody entered",
    );
    lines.push(`**Entries:** ${g.entries}`);
    lines.push(`**Ended:** ${formatUtc(g.endsAt)}`);
  }
  if (g.roleName) lines.push(`**Required role:** ${g.roleName}`);
  lines.push(`**Hosted by:** ${g.hostName}`, "", `*Giveaway #${g.id}*`);
  return lines.join("\n");
}

/** The announcement posted under the giveaway. Mentions the winners. */
export function renderWinners(
  prize: string,
  winners: Array<{ id: string; name: string }>,
  entries: number,
  reroll: boolean,
): string {
  if (winners.length === 0) {
    return reroll
      ? `🎲 No one else is eligible to win **${prize}**.`
      : `😔 The giveaway for **${prize}** ended with no eligible entries.`;
  }
  const names = winners.map((w) => userMention(w.name, w.id)).join(", ");
  if (reroll) return `🎲 New ${winners.length === 1 ? "winner" : "winners"} for **${prize}**: ${names}! Congratulations!`;
  return `🎉 Congratulations ${names}! You won **${prize}**! (${entries} ${entries === 1 ? "entry" : "entries"})`;
}

// --- Polls -------------------------------------------------------------------

export interface PollText {
  id: number;
  question: string;
  options: string[];
  endsAt: number | null;
  closed: boolean;
  /** Votes per option: live results while open (none yet if omitted), the final results once closed. */
  counts?: number[];
}

export function renderPoll(p: PollText): string {
  const lines = [`📊 **${p.question}**${p.closed ? " *(closed)*" : ""}`, ""];
  if (p.closed && p.counts) {
    const pct = percentages(p.counts);
    const top = Math.max(...p.counts);
    p.options.forEach((o, i) => {
      const lead = top > 0 && p.counts![i] === top ? " 🏆" : "";
      lines.push(`${NUMBER_EMOJI[i]} ${o} · **${pct[i]}%** (${p.counts![i]})${lead}`, bar(pct[i]));
    });
    const total = p.counts.reduce((a, b) => a + b, 0);
    lines.push("", `${total} ${total === 1 ? "vote" : "votes"} · *Poll #${p.id}*`);
  } else {
    const counts = p.counts ?? p.options.map(() => 0);
    const pct = percentages(counts);
    const total = counts.reduce((a, b) => a + b, 0);
    p.options.forEach((o, i) => {
      lines.push(total > 0 ? `${NUMBER_EMOJI[i]} ${o} · **${pct[i]}%** (${counts[i] ?? 0})` : `${NUMBER_EMOJI[i]} ${o}`, bar(pct[i], 10, LIVE_FILL));
    });
    lines.push("", total > 0 ? `🗳️ **${total}** ${total === 1 ? "vote" : "votes"} so far · live results` : "🗳️ No votes yet · live results");
    lines.push("React with a number to vote. If you react more than once, your latest vote counts.");
    lines.push(p.endsAt ? `Closes ${formatUtc(p.endsAt)} · *Poll #${p.id}*` : `*Poll #${p.id}*`);
  }
  return lines.join("\n");
}

// --- Starboard ---------------------------------------------------------------

export interface StarPostText {
  emoji: string;
  count: number;
  channelId: string;
  channelName: string;
  authorName: string;
  content: string;
  attachments: string[];
}

export function renderStarPost(s: StarPostText): string {
  const lines = [`${emojiDisplay(s.emoji)} **${s.count}** · ${channelMention(s.channelName, s.channelId)}`, `**${s.authorName}**`];
  const excerpt = quoteExcerpt(s.content);
  if (excerpt) lines.push(excerpt);
  if (s.attachments.length) {
    lines.push(`📎 ${s.attachments.map((a) => truncate(a, 80)).join(", ")}`);
  }
  return lines.join("\n");
}
