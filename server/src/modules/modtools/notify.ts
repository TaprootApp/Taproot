import { rootServer, CommunityEvent, RootGuidType, RootGuidUtils, UserGuid } from "@rootsdk/server-app";
import { all, get } from "../../db";
import { read, write } from "../../lib/api";
import { log, errMessage } from "../../lib/log";
import { onChange } from "../../services/changes";
import { NotifyAction, NOTIFY_ACTIONS, notificationFor } from "./logic";
import { config } from "./store";

// Member notifications on moderation actions (Dyno DMs the member). Apps
// can't DM on Root, so this is a push notification, off by default. It
// follows new cases rather than hooking each action, so warnings, mutes,
// kicks and bans from commands, the GUI and automatic punishments are all
// covered. Notifications show on lock screens, so they only say what
// happened and where, never the reason.

let lastCaseId = 0;
let communityName = "";
let timer: ReturnType<typeof setTimeout> | undefined;

function isPerson(id: string): boolean {
  try {
    return RootGuidUtils.toRootGuidType(id) === RootGuidType.Person;
  } catch {
    return false;
  }
}

async function sendNew(): Promise<void> {
  const rows = await all<{ id: number; action: string; user_id: string }>(
    "SELECT id, action, user_id FROM mod_cases WHERE id > ? ORDER BY id LIMIT 50",
    [lastCaseId],
  );
  if (rows.length === 0) return;
  lastCaseId = rows[rows.length - 1].id;
  const enabled = config().notify;
  for (const row of rows) {
    const action = row.action as NotifyAction;
    if (!NOTIFY_ACTIONS.includes(action) || !enabled[action] || !isPerson(row.user_id)) continue;
    const { title, description } = notificationFor(action, communityName);
    try {
      await write("notifications.send", () =>
        rootServer.community.notifications.send({ title, description, userIds: [row.user_id as UserGuid] }),
      );
    } catch (err) {
      log("warn", "member notification failed", { caseId: row.id, error: errMessage(err) });
    }
  }
  // More than one page arrived at once (a raid): keep going.
  if (rows.length === 50) await sendNew();
}

export async function initNotify(): Promise<void> {
  lastCaseId = (await get<{ n: number | null }>("SELECT MAX(id) AS n FROM mod_cases"))?.n ?? 0;
  try {
    communityName = (await read("communities.get", () => rootServer.community.communities.get())).name;
  } catch {
    communityName = "";
  }
  rootServer.community.communities.on(CommunityEvent.CommunityEdited, (evt) => {
    if (evt.name) communityName = evt.name;
  });
  onChange((area) => {
    if (area !== "cases" || timer) return;
    // Coalesce: a mute creates a case and then updates it.
    timer = setTimeout(() => {
      timer = undefined;
      sendNew().catch((err) => log("warn", "member notifications failed", { error: errMessage(err) }));
    }, 1500);
  });
}
