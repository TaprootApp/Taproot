import { all, get, run } from "./db";
import { ChangeArea, notifyChange } from "./services/changes";

// Per-community configuration, stored as JSON values in the settings table
// and cached in memory. Root's Global Settings UI can only render role/member
// pickers today, so everything else (channels, messages, filters) is set
// through admin commands and lives here.

export interface AutomodConfig {
  enabled: boolean;
  words: { enabled: boolean; list: string[] };
  links: { enabled: boolean; allow: string[] };
  mentions: { enabled: boolean; max: number; blockAll: boolean };
  spam: { enabled: boolean; messages: number; seconds: number; duplicates: number };
  caps: { enabled: boolean; percent: number; minLength: number };
  /** Strikes within the window trigger an automatic mute. */
  strikes: { count: number; windowMinutes: number; muteMinutes: number };
  ignoredChannels: string[];
}

export interface Settings {
  prefix: string;
  modLogChannel: string | null;
  welcomeChannel: string | null;
  welcomeMessage: string;
  goodbyeChannel: string | null;
  goodbyeMessage: string;
  autoroles: string[];
  selfRoles: string[];
  automod: AutomodConfig;
}

const DEFAULTS: Settings = {
  prefix: "!",
  modLogChannel: null,
  welcomeChannel: null,
  welcomeMessage: "Welcome to **{server}**, {user}! 🌱",
  goodbyeChannel: null,
  goodbyeMessage: "**{user.name}** has left the community.",
  autoroles: [],
  selfRoles: [],
  automod: {
    enabled: false,
    words: { enabled: true, list: [] },
    links: { enabled: false, allow: [] },
    mentions: { enabled: true, max: 5, blockAll: true },
    spam: { enabled: true, messages: 5, seconds: 5, duplicates: 3 },
    caps: { enabled: false, percent: 70, minLength: 12 },
    strikes: { count: 3, windowMinutes: 10, muteMinutes: 10 },
    ignoredChannels: [],
  },
};

let cache: Settings = structuredClone(DEFAULTS);

export async function loadSettings(): Promise<void> {
  const rows = await all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const loaded: Record<string, unknown> = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  for (const row of rows) {
    if (!(row.key in DEFAULTS)) continue;
    try {
      loaded[row.key] = JSON.parse(row.value);
    } catch {
      // A corrupt value falls back to the default rather than blocking startup.
    }
  }
  // Merge stored automod over defaults so fields added in later versions get defaults.
  const storedAutomod = loaded.automod as Partial<AutomodConfig>;
  loaded.automod = mergeDeep(structuredClone(DEFAULTS.automod), storedAutomod);
  cache = loaded as unknown as Settings;
}

export function settings(): Readonly<Settings> {
  return cache;
}

// Which GUI area each setting belongs to, so open GUIs refresh after any
// change, whether it came from the GUI or a text command.
const AREA: Record<keyof Settings, ChangeArea> = {
  prefix: "general",
  modLogChannel: "general",
  selfRoles: "general",
  welcomeChannel: "welcome",
  welcomeMessage: "welcome",
  goodbyeChannel: "welcome",
  goodbyeMessage: "welcome",
  autoroles: "welcome",
  automod: "automod",
};

async function store<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    JSON.stringify(value),
  ]);
  cache = { ...cache, [key]: value };
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await store(key, value);
  notifyChange(AREA[key]);
}

/** Saves several settings, notifying each affected area once. */
export async function setSettings(values: Partial<Settings>): Promise<void> {
  const areas = new Set<ChangeArea>();
  for (const key of Object.keys(values) as (keyof Settings)[]) {
    await store(key, values[key] as Settings[typeof key]);
    areas.add(AREA[key]);
  }
  for (const area of areas) notifyChange(area);
}

// --- Feature module config ---------------------------------------------------
// Modules (server/src/modules) keep their own config as one JSON value under
// the settings key "module:<name>", merged over the module's defaults so
// fields added later get their default.

const moduleCache = new Map<string, unknown>();

export async function loadModuleConfig<T extends object>(name: string, defaults: T): Promise<T> {
  const row = await get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [`module:${name}`]);
  let stored: unknown;
  try {
    stored = row ? JSON.parse(row.value) : undefined;
  } catch {
    stored = undefined;
  }
  const value = mergeDeep(structuredClone(defaults), stored);
  moduleCache.set(name, value);
  return value;
}

/** The module's cached config; call loadModuleConfig once in the module's init first. */
export function moduleConfig<T>(name: string): T {
  if (!moduleCache.has(name)) throw new Error(`Module config "${name}" not loaded`);
  return moduleCache.get(name) as T;
}

/** Saves the module's config and notifies `area` (defaults to the module name). */
export async function saveModuleConfig<T>(name: string, value: T, area: ChangeArea = name): Promise<void> {
  await run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    `module:${name}`,
    JSON.stringify(value),
  ]);
  moduleCache.set(name, value);
  notifyChange(area);
}

/** Applies a change to a copy of the automod config and saves it. */
export async function updateAutomod(change: (config: AutomodConfig) => void): Promise<void> {
  const next = structuredClone(cache.automod);
  change(next);
  await setSetting("automod", next);
}

function mergeDeep<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over)) return base;
  const out = base as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const current = out[k];
    if (current && typeof current === "object" && !Array.isArray(current) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = mergeDeep(current, v);
    } else if (k in out) {
      out[k] = v;
    }
  }
  return base;
}
