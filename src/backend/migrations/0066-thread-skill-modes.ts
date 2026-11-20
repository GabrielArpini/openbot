import type { OpenBotMigration } from "./migration";

/** Chat selections follow chat deletion. Agent defaults survive roster projection replacement. */
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
  version: 66,
  name: "thread-skill-modes",
  up: (db) => db.exec(THREAD_SKILL_MODES_SCHEMA_SQL),
};
