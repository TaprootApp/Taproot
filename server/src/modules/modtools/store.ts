import { run } from "../../db";
import { loadModuleConfig, moduleConfig, saveModuleConfig } from "../../settings";
import { notifyChange } from "../../services/changes";
import { DEFAULT_CONFIG, ModtoolsConfig } from "./logic";

// Tables and config for the mod tools module. Change areas are
// "modtools:<thing>"; the GUI service turns them into ModtoolsChanged.

export const NAME = "modtools";

export type ModtoolsArea = "notes" | "temproles" | "voice" | "config";

export function changed(area: ModtoolsArea): void {
  notifyChange(`${NAME}:${area}`);
}

export async function createTables(): Promise<void> {
  // Staff-only notes about a member; kept until a moderator deletes them.
  await run(`CREATE TABLE IF NOT EXISTS modtools_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_modtools_notes_user ON modtools_notes (user_id, id DESC)`);

  // Roles given for a while; the row is deleted once the role is taken back.
  await run(`CREATE TABLE IF NOT EXISTS modtools_temp_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    added_by_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_modtools_temp_roles_user ON modtools_temp_roles (user_id)`);

  // Timed autoroles waiting to be given; deleted once given or the member leaves.
  await run(`CREATE TABLE IF NOT EXISTS modtools_pending_roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_modtools_pending_user ON modtools_pending_roles (user_id)`);

  // Members kept server-muted in voice until vunmute.
  await run(`CREATE TABLE IF NOT EXISTS modtools_voice_mutes (
    user_id TEXT PRIMARY KEY,
    moderator_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  // Small key/value state (the timed-autorole join watermark).
  await run(`CREATE TABLE IF NOT EXISTS modtools_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}

export async function loadConfig(): Promise<ModtoolsConfig> {
  return loadModuleConfig<ModtoolsConfig>(NAME, structuredClone(DEFAULT_CONFIG));
}

export function config(): ModtoolsConfig {
  return moduleConfig<ModtoolsConfig>(NAME);
}

export async function saveConfig(value: ModtoolsConfig): Promise<void> {
  await saveModuleConfig(NAME, value, `${NAME}:config`);
}
