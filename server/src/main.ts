import {
  rootServer,
  ChannelMessageCreatedEvent,
  ChannelMessageEvent,
  MessageType,
  RootAppStartState,
} from "@rootsdk/server-app";
import { handleCommand } from "./commands/router";
import { openDatabase } from "./db";
import { automodMessage, registerAutomod } from "./features/automod";
import { registerCustomCommands } from "./features/customCommands";
import { registerGeneral } from "./features/general";
import { registerModeration } from "./features/moderation";
import { initMutes } from "./features/mute";
import { registerReminders } from "./features/reminders";
import { registerRoles } from "./features/roles";
import { registerWelcome } from "./features/welcome";
import { initJobs, runReconcile } from "./jobs";
import { log, errMessage } from "./lib/log";
import { initPermissions } from "./permissions";
import { configService } from "./services/configService";
import { contentService } from "./services/contentService";
import { moderationService } from "./services/moderationService";
import { sessionService } from "./services/sessionService";
import { MODULES } from "./modules";
import { runMessageFilters, runMessageListeners } from "./pipeline";
import { loadSettings } from "./settings";

async function onMessage(evt: ChannelMessageCreatedEvent): Promise<void> {
  if (evt.messageType === MessageType.System) return;
  // Auto-mod first: a removed message never runs as a command.
  if (await automodMessage(evt)) return;
  if (await runMessageFilters(evt)) return;
  const wasCommand = await handleCommand(evt);
  await runMessageListeners(evt, wasCommand);
}

async function onStarting(_state: RootAppStartState): Promise<void> {
  await openDatabase();
  await loadSettings();
  await initPermissions();

  registerGeneral();
  registerModeration();
  registerAutomod();
  registerCustomCommands();
  registerWelcome();
  registerReminders();
  registerRoles();
  initMutes();

  // GUI services. The text commands above stay fully available.
  rootServer.lifecycle.addService(sessionService);
  rootServer.lifecycle.addService(configService);
  rootServer.lifecycle.addService(moderationService);
  rootServer.lifecycle.addService(contentService);

  // Feature modules. One failing to start is logged and skipped, never fatal.
  for (const m of MODULES) {
    try {
      await m.init();
      for (const service of m.services ?? []) rootServer.lifecycle.addService(service);
    } catch (err) {
      log("error", `module ${m.name} failed to start`, { error: errMessage(err) });
    }
  }

  const messages = rootServer.community.channelMessages;
  // Handlers never throw: an unhandled error restarts the server, and repeated
  // crashes take it offline in the community until a new version ships.
  messages.on(ChannelMessageEvent.ChannelMessageCreated, (evt) => {
    onMessage(evt).catch((err) => log("error", "message handler failed", { error: errMessage(err) }));
  });
  messages.on(ChannelMessageEvent.ChannelMessageEdited, (evt) => {
    automodMessage(evt, true).catch((err) => log("error", "edit handler failed", { error: errMessage(err) }));
  });

  await initJobs();
  // Catch up on unmutes, reminders and announcements that came due while offline.
  runReconcile().catch((err) => log("error", "startup reconcile failed", { error: errMessage(err) }));
  log("info", "Taproot started");
}

// Last-resort net: the SDK's broadcasts are fire-and-forget promises, and one
// stray rejection would otherwise restart the server (see onStarting).
process.on("unhandledRejection", (err) => log("error", "unhandled rejection", { error: errMessage(err) }));

(async () => {
  await rootServer.lifecycle.start(onStarting);
})();
