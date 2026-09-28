import { loadModuleConfig, moduleConfig, saveModuleConfig } from "../../settings";
import { defaultConfig, PlusConfig } from "./config";

// Access to the module's config. Core auto-mod (features/automod.ts) reads it
// too, so a read before the module has loaded falls back to the defaults,
// which behave exactly like auto-mod did before the module existed.

export const MODULE = "automodplus";

/** Change-feed areas, one per GUI page. */
export const AREA = {
  automod: "automodplus:automod",
  channels: "automodplus:channels",
  join: "automodplus:join",
} as const;

const DEFAULTS = defaultConfig();

export async function loadPlusConfig(): Promise<void> {
  await loadModuleConfig<PlusConfig>(MODULE, defaultConfig());
}

export function plusConfig(): Readonly<PlusConfig> {
  try {
    return moduleConfig<PlusConfig>(MODULE);
  } catch {
    return DEFAULTS;
  }
}

/** Applies a change to a copy of the config and saves it, notifying `area`. */
export async function updatePlus(area: string, change: (config: PlusConfig) => void): Promise<PlusConfig> {
  const next = structuredClone(plusConfig()) as PlusConfig;
  change(next);
  await saveModuleConfig(MODULE, next, area);
  return next;
}
