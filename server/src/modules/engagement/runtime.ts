import { UserGuid } from "@rootsdk/server-app";
import { nicknameOf } from "../../members";
import { notifyChange } from "../../services/changes";
import { moduleConfig, saveModuleConfig } from "../../settings";
import { EngagementConfig } from "./logic";

// Config access, display names and the coalesced change feed shared by the
// commands, the XP listener and the GUI service.

export const NAME = "engagement";

export const AREA = {
  xp: "engagement:xp",
  money: "engagement:money",
  shop: "engagement:shop",
  config: "engagement:config",
} as const;

export function config(): EngagementConfig {
  return moduleConfig<EngagementConfig>(NAME);
}

export async function saveConfig(next: EngagementConfig): Promise<void> {
  await saveModuleConfig(NAME, next, AREA.config);
}

// XP and balances change on almost every message in a busy community, so
// those notifications are batched: open GUIs refetch at most every few seconds.
const COALESCE_MS = 4000;
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;

export function notifySoon(area: string): void {
  pending.add(area);
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const areas = [...pending];
    pending.clear();
    for (const a of areas) notifyChange(a);
  }, COALESCE_MS);
}

// Leaderboards show up to 10-25 names per page; cache them briefly so paging
// doesn't re-fetch every member from Root.
const NAME_TTL = 10 * 60_000;
const names = new Map<string, { at: number; name: string }>();

export async function displayName(userId: string): Promise<string> {
  const cached = names.get(userId);
  if (cached && Date.now() - cached.at < NAME_TTL) return cached.name;
  const name = await nicknameOf(userId as UserGuid);
  if (names.size > 2000) names.clear();
  names.set(userId, { at: Date.now(), name });
  return name;
}
