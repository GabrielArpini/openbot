import type { DatabaseSync } from "node:sqlite";
import { MESSAGING_HISTORY_SCHEMA_SQL } from "./0062-messaging-history";
import type { OpenBotMigration } from "./migration";

export const THREAD_SKILL_MODES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agent_skill_mode_defaults (
    agent_id TEXT PRIMARY KEY,
    selection_json TEXT NOT NULL CHECK(json_valid(selection_json))
  );
  CREATE TABLE IF NOT EXISTS thread_skill_modes (
    thread_id TEXT PRIMARY KEY REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    selection_json TEXT NOT NULL CHECK(json_valid(selection_json))
  );
  CREATE TABLE IF NOT EXISTS provider_session_skill_modes (
    session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    selection_key TEXT NOT NULL
  );
`;

export const migration: OpenBotMigration = {
  version: 67,
  name: "thread-skill-modes",
  up: (db) => {
    repairForkMessagingHistory(db);
    db.exec(THREAD_SKILL_MODES_SCHEMA_SQL);
  },
};

function canonicalSql(sql: string): string {
  return sql.replace(/IF NOT EXISTS/gi, "").replace(/\s+/g, "").replace(/;$/, "").toUpperCase();
}

function repairForkMessagingHistory(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projection_messaging_history'").get()) return;
  const forkTables = [...THREAD_SKILL_MODES_SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) ([\s\S]*?);/g)];
  const matchesFork = forkTables.length === 3 && forkTables.every(([statement, name]) => {
    if (!statement || !name) return false;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return typeof row?.sql === "string" && canonicalSql(row.sql) === canonicalSql(statement);
  });
  if (!matchesFork || !db.prepare("SELECT 1 FROM schema_migrations WHERE version=62").get()) {
    throw new Error("Missing messaging history does not match the released skill-mode fork schema.");
  }
  db.exec(MESSAGING_HISTORY_SCHEMA_SQL);
}
