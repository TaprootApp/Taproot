import "./env";
import { rootServer, ChannelGuid, MessageDirectionTake, RootAppStartState, RootGuidUtils } from "@rootsdk/server-app";
import { openDatabase } from "../src/db";
import { listPanels, refreshPanel } from "../src/features/roles";
import { read } from "../src/lib/api";
import { errMessage } from "../src/lib/log";
import { loadSettings } from "../src/settings";
import { MODULES } from "../src/modules";
import { listPolls, refreshPoll } from "../src/modules/events/polls";
import { editMessage, isBot } from "../src/modules/events/shared";

// DEV ONLY. Re-renders Taproot's existing reaction-role panels and poll
// messages (and a closed poll's "results" reply) in place, so formatting fixes
// show up on messages posted earlier. Edits only; never posts or reacts.
// Idempotent.
//
//   cd server && npm run refresh   (stop `npm run server` first, restart it after)

function say(message: string): void {
  console.log(`[refresh] ${message}`);
}

/** Taproot's "📊 **Poll #n results**" reply, searched among the newer messages after the poll. */
async function resultsReply(channelId: string, pollMessageId: string, id: number): Promise<string | undefined> {
  const res = await read("channelMessages.list", () =>
    rootServer.community.channelMessages.list({
      channelId: channelId as ChannelGuid,
      messageDirectionTake: MessageDirectionTake.Newer,
      dateAt: new Date(RootGuidUtils.toMilliseconds(pollMessageId)),
      limit: 50,
    }),
  );
  const heading = `📊 **Poll #${id} results**`;
  return res.messages.find((m) => isBot(m.userId) && !m.deletedAt && m.messageContent.startsWith(heading))?.id;
}

async function refresh(): Promise<void> {
  await openDatabase();
  await loadSettings();
  for (const m of MODULES) {
    try {
      await m.init();
    } catch (err) {
      say(`module ${m.name} failed to start: ${errMessage(err)}`);
    }
  }

  for (const panel of await listPanels()) {
    try {
      await refreshPanel(panel);
      say(`panel #${panel.id} "${panel.title}" re-rendered`);
    } catch (err) {
      say(`panel #${panel.id} failed: ${errMessage(err)}`);
    }
  }

  for (const poll of await listPolls(1000)) {
    if (!poll.message_id) continue;
    const content = await refreshPoll(poll);
    say(`poll #${poll.id} re-rendered${poll.closed ? " (closed)" : ""}`);
    if (!poll.closed) continue;
    try {
      const replyId = await resultsReply(poll.channel_id, poll.message_id, poll.id);
      if (!replyId) {
        say(`poll #${poll.id}: no results reply found`);
        continue;
      }
      await editMessage(poll.channel_id, replyId, `📊 **Poll #${poll.id} results**\n\n${content}`);
      say(`poll #${poll.id} results reply re-rendered`);
    } catch (err) {
      say(`poll #${poll.id} results reply failed: ${errMessage(err)}`);
    }
  }
  say("done");
}

function finish(code: number): void {
  // As in seed.ts: let the write queue drain, then stop the dev host too.
  setTimeout(() => {
    try {
      process.kill(process.ppid, "SIGINT");
    } catch {
      // Already gone.
    }
    process.exit(code);
  }, 3000);
}

async function onStarting(_state: RootAppStartState): Promise<void> {
  setTimeout(() => {
    refresh()
      .then(() => finish(0))
      .catch((err) => {
        console.error("[refresh] failed:", err);
        finish(1);
      });
  }, 500);
}

process.on("unhandledRejection", (err) => console.error("[refresh] unhandled rejection:", errMessage(err)));

(async () => {
  await rootServer.lifecycle.start(onStarting);
})();
