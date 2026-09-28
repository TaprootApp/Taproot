import { rootServer } from "@rootsdk/server-app";
import sqlite3 from "sqlite3";

// Root backs up and restores only the SQLite file it hands us, so all bot state
// lives there. Each community runs its own bot instance with its own file.

let db: sqlite3.Database | undefined;

export async function openDatabase(): Promise<void> {
  const config = rootServer.dataStore.config.sqlite3;
  if (!config) throw new Error("Root did not provide a SQLite database");
  db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const d = new sqlite3.Database(config.filename, (err) => (err ? reject(err) : resolve(d)));
  });
  await migrate();
}

function conn(): sqlite3.Database {
  if (!db) throw new Error("Database not opened");
  return db;
}

export function run(sql: string, params: unknown[] = []): Promise<{ lastID: number; changes: number }> {
  return new Promise((resolve, reject) => {
    conn().run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

export function get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    conn().get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
  });
}

export function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    conn().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
  });
}

// There is no migration framework, so every step is idempotent and runs on
// each start. To change the schema later, append steps; never edit old ones.
async function migrate(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Every moderation action gets a case: manual and automatic alike.
  // Warnings are cases with action 'warn'; delwarn voids them.
  await run(`CREATE TABLE IF NOT EXISTS mod_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL DEFAULT '',
    moderator_id TEXT NOT NULL DEFAULT '',
    moderator_name TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER,
    voided INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cases_user ON mod_cases (user_id, id DESC)`);

  // Warn thresholds: reaching warn_count active warnings triggers the action.
  await run(`CREATE TABLE IF NOT EXISTS warn_actions (
    warn_count INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    duration_ms INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS mutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    case_id INTEGER,
    expires_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_mutes_active ON mutes (active, user_id)`);

  // One row per access rule a mute touched, so unmute can restore exactly what
  // was there before (a pre-existing member rule is edited back, not deleted).
  await run(`CREATE TABLE IF NOT EXISTS mute_rules (
    mute_id INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    original_overlay TEXT,
    PRIMARY KEY (mute_id, target_id)
  )`);

  // Channel locks work the same way, against the @everyone role.
  await run(`CREATE TABLE IF NOT EXISTS locks (
    target_id TEXT PRIMARY KEY,
    original_overlay TEXT,
    created_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS automod_strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    rule TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_strikes_user ON automod_strikes (user_id, created_at)`);

  await run(`CREATE TABLE IF NOT EXISTS custom_commands (
    name TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_by TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS member_names (
    user_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message TEXT NOT NULL,
    next_at INTEGER NOT NULL,
    repeat TEXT NOT NULL DEFAULT 'once',
    job_id TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS reaction_panels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS reaction_roles (
    panel_id INTEGER NOT NULL,
    emoji_key TEXT NOT NULL,
    shortcode TEXT NOT NULL,
    role_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (panel_id, emoji_key)
  )`);
}
