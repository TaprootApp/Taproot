import { rootServer, ChannelGuid, ChannelMessage, MessageGuid } from "@rootsdk/server-app";
import { write } from "./lib/api";
import { log, errMessage } from "./lib/log";
import { MAX_MESSAGE, truncate } from "./lib/text";

export async function send(channelId: string, content: string): Promise<ChannelMessage> {
  return write("channelMessages.create", () =>
    rootServer.community.channelMessages.create({
      channelId: channelId as ChannelGuid,
      content: truncate(content, MAX_MESSAGE),
    }),
  );
}

export async function reply(channelId: string, messageId: string, content: string): Promise<ChannelMessage> {
  return write("channelMessages.create", () =>
    rootServer.community.channelMessages.create({
      channelId: channelId as ChannelGuid,
      content: truncate(content, MAX_MESSAGE),
      parentMessageIds: [messageId as MessageGuid],
    }),
  );
}

export async function deleteMessage(channelId: string, messageId: string): Promise<void> {
  await write("channelMessages.delete", () =>
    rootServer.community.channelMessages.delete({ channelId: channelId as ChannelGuid, id: messageId as MessageGuid }),
  );
}

/** Posts a short notice and removes it after a few seconds. Best effort. */
export function sendEphemeral(channelId: string, content: string, ttlMs = 8000): void {
  send(channelId, content)
    .then((msg) => {
      setTimeout(() => {
        deleteMessage(channelId, msg.id).catch(() => undefined);
      }, ttlMs);
    })
    .catch((err) => log("warn", "ephemeral notice failed", { error: errMessage(err) }));
}
