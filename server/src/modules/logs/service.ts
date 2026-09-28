import { Client } from "@rootsdk/server-app";
import { LogsServiceBase } from "@taproot/gen-server";
import { LogsConfig as WireLogsConfig } from "@taproot/gen-shared";
import { log, errMessage } from "../../lib/log";
import { send } from "../../messaging";
import { Level } from "../../permissions";
import { act, invalid, requireLevel } from "../../services/auth";
import { onChange } from "../../services/changes";
import { visibleChannels } from "../../services/sessionService";
import { saveModuleConfig } from "../../settings";
import { config, NAME, pruneMessageCache } from "./actionLog";
import { fromWireLogsConfig, savedChannelIds, toWireLogsConfig } from "./wire";

// The "Action log" settings page. Admin only; validation matches the logs
// command, so the GUI can't save anything the command would refuse.

class LogsService extends LogsServiceBase {
  constructor() {
    super();
    onChange((area) => {
      if (area !== NAME) return;
      try {
        this.broadcastLogsChanged({ area }, "all");
      } catch (err) {
        log("warn", "logs broadcast failed", { error: errMessage(err) });
      }
    });
  }

  async getLogsConfig(client: Client): Promise<WireLogsConfig> {
    await requireLevel(client, Level.Admin);
    return toWireLogsConfig(config());
  }

  async updateLogsConfig(request: WireLogsConfig, client: Client): Promise<WireLogsConfig> {
    await requireLevel(client, Level.Admin);
    const current = config();
    const result = fromWireLogsConfig(request, current);
    if ("error" in result) invalid(result.error);
    const { next, channelIds } = result;

    // IDs already saved stay valid, so a deleted channel doesn't block saving the rest.
    const saved = savedChannelIds(current);
    if (channelIds.some((id) => !saved.has(id))) {
      const known = new Set((await act(visibleChannels)).map((c) => c.id));
      if (channelIds.some((id) => !saved.has(id) && !known.has(id))) {
        invalid("One of the channels doesn't exist or Taproot can't see it.");
      }
    }

    // Like picking the mod log: announce in a new log channel, and don't save if Taproot can't post there.
    if (next.channel && next.channel !== current.channel) {
      const channelId = next.channel;
      await act(() => send(channelId, "📋 Taproot will post the action log here."));
    }
    await saveModuleConfig(NAME, next);
    pruneMessageCache();
    return toWireLogsConfig(next);
  }
}

export const logsService = new LogsService();
