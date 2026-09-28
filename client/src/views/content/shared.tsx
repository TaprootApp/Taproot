import React from "react";
import type { ChangeEvent } from "@taproot/gen-shared";
import { contentServiceClient, ContentServiceClientEvent } from "@taproot/gen-client";
import { useBroadcast } from "../../lib";
import styles from "./content.module.css";

// Bits shared by the content screens and the member page.

/** Longest message Taproot posts before truncating (server/src/lib/text.ts). */
export const MAX_MESSAGE = 9500;

/**
 * Calls `onChange` when the server broadcasts a content change in one of
 * `areas` ("commands", "panels", "announcements", "selfroles", "reminders").
 * An event with no area refreshes everything, to be safe.
 */
export function useContentChanged(areas: string[], onChange: (area: string) => void): void {
  useBroadcast(
    contentServiceClient,
    ContentServiceClientEvent.ContentChanged,
    (event: ChangeEvent) => onChange(event?.area ?? ""),
    { filter: (event: ChangeEvent) => !event?.area || areas.includes(event.area) },
  );
}

export interface Placeholder {
  token: string;
  meaning: string;
}

/** Placeholders a custom command response can use (server/src/features/customCommands.ts). */
export const COMMAND_PLACEHOLDERS: Placeholder[] = [
  { token: "{user}", meaning: "mentions whoever ran it" },
  { token: "{user.name}", meaning: "their name" },
  { token: "{target}", meaning: "the first member they mentioned" },
  { token: "{args}", meaning: "text after the command" },
  { token: "{channel}", meaning: "the channel it ran in" },
  { token: "{server}", meaning: "the community's name" },
];

/** Clickable placeholder list; clicking one appends it to the text. */
export const PlaceholderHelp: React.FC<{ placeholders: Placeholder[]; onInsert: (token: string) => void }> = ({
  placeholders,
  onInsert,
}) => (
  <div className={styles.tokens}>
    {placeholders.map((p) => (
      <button
        key={p.token}
        type="button"
        className={styles.token}
        onClick={() => onInsert(p.token)}
        title={`Insert ${p.token}`}
      >
        <code>{p.token}</code>
        <span>{p.meaning}</span>
      </button>
    ))}
  </div>
);

/** Adds `token` to the end of `text` with a space between if needed. */
export function appendToken(text: string, token: string): string {
  if (!text || /\s$/.test(text)) return text + token;
  return `${text} ${token}`;
}

/** "#general", or a fallback when the channel is gone. */
export function channelLabel(name: string | undefined): string {
  return name ? `#${name}` : "unknown channel";
}
