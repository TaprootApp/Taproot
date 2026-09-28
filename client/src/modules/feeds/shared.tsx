import React, { useMemo } from "react";
import type { FeedsChangeEvent, FeedsChannel } from "@taproot/gen-shared";
import { FeedsKind } from "@taproot/gen-shared";
import { feedsServiceClient, FeedsServiceClientEvent } from "@taproot/gen-client";
import { ErrorState, Select } from "../../components";
import type { SelectOption } from "../../components";
import { useBroadcast, useRpc } from "../../lib";

// Bits shared by the Feeds and Voice links pages.

/** Refetch when the server says one of `areas` changed ("feeds:feeds", "feeds:settings", "feeds:voice"). */
export function useFeedsChanged(areas: string[], onChange: () => void): void {
  useBroadcast(feedsServiceClient, FeedsServiceClientEvent.FeedsChanged, () => onChange(), {
    filter: (event: FeedsChangeEvent) => !event?.area || areas.includes(event.area),
  });
}

export const KIND_LABEL: Record<number, string> = {
  [FeedsKind.YOUTUBE]: "YouTube",
  [FeedsKind.REDDIT]: "Reddit",
  [FeedsKind.TWITCH]: "Twitch",
  [FeedsKind.KICK]: "Kick",
};

export const KINDS = [FeedsKind.YOUTUBE, FeedsKind.REDDIT, FeedsKind.TWITCH, FeedsKind.KICK];

/** What to type for each kind, shown under the source box. */
export const KIND_HELP: Record<number, { placeholder: string; help: string }> = {
  [FeedsKind.YOUTUBE]: {
    placeholder: "https://youtube.com/@creator",
    help: "A channel link, @handle, or channel ID (starts with UC). Posts new uploads.",
  },
  [FeedsKind.REDDIT]: { placeholder: "r/gaming", help: "A subreddit. Posts new posts (NSFW posts are skipped)." },
  [FeedsKind.TWITCH]: { placeholder: "streamer_name", help: "A Twitch channel name or link. Posts when they go live." },
  [FeedsKind.KICK]: {
    placeholder: "streamer-name",
    help: "A Kick channel name or link. Posts when they go live. Kick sometimes blocks checks; errors show on this page.",
  },
};

export const FEED_PLACEHOLDERS = [
  { token: "{title}", meaning: "video, post, or stream title" },
  { token: "{url}", meaning: "link to it" },
  { token: "{author}", meaning: "channel, poster, or streamer" },
  { token: "{source}", meaning: "what the feed follows" },
  { token: "{game}", meaning: "stream category (Twitch, Kick)" },
  { token: "{role}", meaning: "the role to mention" },
];

/** Text and voice channels from the feeds service (the shared picker doesn't know channel types). */
export function useFeedChannels() {
  return useRpc(() => feedsServiceClient.listChannels());
}

export const FeedChannelSelect: React.FC<{
  channels: FeedsChannel[] | undefined;
  loading: boolean;
  error: string | undefined;
  onRetry: () => void;
  voice: boolean;
  value: string | undefined;
  onChange: (id: string) => void;
  id?: string;
}> = ({ channels, loading, error, onRetry, voice, value, onChange, id }) => {
  const options = useMemo(() => {
    const list: SelectOption<string>[] = (channels ?? [])
      .filter((c) => c.voice === voice)
      .map((c) => ({ value: c.id, label: `${voice ? "🔊" : "#"} ${c.name}`, group: c.groupName }));
    if (value && !list.some((o) => o.value === value) && !loading) list.unshift({ value, label: "Unknown channel (deleted or hidden)" });
    return list;
  }, [channels, voice, value, loading]);
  if (error && !channels) return <ErrorState compact message={error} onRetry={onRetry} />;
  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      options={options}
      placeholder={loading && !channels ? "Loading channels…" : voice ? "Choose a voice channel" : "Choose a text channel"}
      disabled={loading && !channels}
    />
  );
};
