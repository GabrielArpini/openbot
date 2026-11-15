// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

// Failure modes: the upgrade loses a chat or a saved skill mode; a pre-release database that recorded the
// skill-mode tables as version 62 stays without the messaging history table, or fails because its tables
// exist; a failed upgrade leaves a table or its marker; a newer or incomplete history is accepted.
const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

// The skill-mode tables exactly as the pre-release build (commit ca0b859) created them as version 62.
const PRE_RELEASE_V62_SQL = `
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

const SKILL_MODE_TABLES = ["agent_skill_mode_defaults", "provider_session_skill_modes", "thread_skill_modes"];
const HISTORY_OBJECTS = [
  { type: "index", name: "idx_projection_messaging_history_place" },
  { type: "index", name: "idx_projection_messaging_history_saved" },
  { type: "index", name: "idx_projection_messaging_history_sent" },
  { type: "table", name: "projection_messaging_history" },
  { type: "index", name: "sqlite_autoindex_projection_messaging_history_1" },
];

function at(version: number) {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_upgrade BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow(`migration to version ${version + 1} failed`);
  db.exec("DROP TRIGGER stop_upgrade");
  return db;
}

/** A database that a pre-release build moved to version 62 with the skill-mode tables, holding saved modes. */
function preReleaseAt62() {
  const db = at(61);
  db.exec(PRE_RELEASE_V62_SQL);
  db.exec("INSERT INTO schema_migrations VALUES(62,'2026-11-14T00:00:00.000Z')");
  seed(db);
  const defaults = db.prepare("INSERT INTO agent_skill_mode_defaults VALUES(?,?)");
  for (let index = 1; index <= 11; index++) {
    defaults.run(`agent-mode-${index}`, JSON.stringify({ skillId: `local-skill-${index}`, revision: index }));
  }
  db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("mode-chat", '{"skillId":"local-skill-1"}');
  db.prepare("INSERT INTO provider_session_skill_modes VALUES(?,?,?)").run("session-1", "mode-chat", "key-1");
  return db;
}

function seed(db: DatabaseSync) {
  db.exec(
    "INSERT INTO projection_threads VALUES('mode-chat','agent-test','Keep this chat',NULL,'2026-01-01','2026-01-01',0)",
  );
}

/** Every row of every table, by table name. */
function contents(db: DatabaseSync) {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND name <> 'schema_migrations' AND name NOT LIKE 'agent_memory_search%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
}

function objects(db: DatabaseSync) {
  return db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY name").all();
}

function historyObjects(db: DatabaseSync) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'projection_messaging_history' ORDER BY name")
    .all();
}

function version(db: DatabaseSync) {
  return db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
}

function healthy(db: DatabaseSync) {
  expect(version(db)).toEqual({ v: 63 });
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}

describe("skill mode upgrade", () => {
  for (let from = 8; from <= 62; from++)
    it(`keeps the chat from schema ${from}`, () => {
      const db = at(from);
      seed(db);
      const before = db.prepare("SELECT * FROM projection_threads").all();
      migrateOpenBotDatabase(db);
      expect(db.prepare("SELECT * FROM projection_threads").all()).toEqual(before);
      for (const table of SKILL_MODE_TABLES) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      expect(historyObjects(db)).toEqual(HISTORY_OBJECTS);
      healthy(db);
    });

  it("repairs a pre-release version 62: adds the messaging history and keeps every saved mode", () => {
    const db = preReleaseAt62();
    expect(historyObjects(db)).toEqual([]);
    const before = contents(db);
    expect(before.agent_skill_mode_defaults).toHaveLength(11);

    migrateOpenBotDatabase(db);

    expect(contents(db)).toEqual({ ...before, projection_messaging_history: [] });
    expect(historyObjects(db)).toEqual(HISTORY_OBJECTS);
    const clean = at(61);
    migrateOpenBotDatabase(clean);
    expect(objects(db)).toEqual(objects(clean));
    healthy(db);
    // A second start finds nothing to do and changes nothing.
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, projection_messaging_history: [] });
  });

  it("rolls back a failed repair of a pre-release version 62 without losing a mode, then retries", () => {
    const db = preReleaseAt62();
    const before = contents(db);
    db.exec(
      "CREATE TEMP TRIGGER fail_repair BEFORE INSERT ON schema_migrations WHEN new.version=63 BEGIN SELECT RAISE(ABORT,'fixture fail'); END",
    );
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 63 failed");
    expect(contents(db)).toEqual(before);
    expect(historyObjects(db)).toEqual([]);
    expect(version(db)).toEqual({ v: 62 });
    db.exec("DROP TRIGGER fail_repair");
    migrateOpenBotDatabase(db);
    expect(contents(db)).toEqual({ ...before, projection_messaging_history: [] });
    healthy(db);
  });

  it("rolls back all mode tables and marker on failure, then retries", () => {
    const db = at(62);
    seed(db);
    db.exec(
      "CREATE TEMP TRIGGER fail_mode BEFORE INSERT ON schema_migrations WHEN new.version=63 BEGIN SELECT RAISE(ABORT,'fixture fail'); END",
    );
    expect(() => migrateOpenBotDatabase(db)).toThrow("migration to version 63 failed");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('thread_skill_modes','provider_session_skill_modes','agent_skill_mode_defaults')",
        )
        .all(),
    ).toEqual([]);
    expect(version(db)).toEqual({ v: 62 });
    db.exec("DROP TRIGGER fail_mode");
    migrateOpenBotDatabase(db);
    healthy(db);
  });

  it("rejects orphan modes and cascades a chat deletion", () => {
    const db = at(61);
    migrateOpenBotDatabase(db);
    seed(db);
    expect(() => db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("missing", "{}")).toThrow();
    db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("mode-chat", "{}");
    db.prepare("INSERT INTO provider_session_skill_modes VALUES(?,?,?)").run("session", "mode-chat", "null");
    db.exec("DELETE FROM projection_threads WHERE thread_id='mode-chat'");
    expect(db.prepare("SELECT * FROM thread_skill_modes").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM provider_session_skill_modes").all()).toEqual([]);
    healthy(db);
  });

  it("rejects newer and incomplete histories without dropping the selected mode", () => {
    const db = at(61);
    migrateOpenBotDatabase(db);
    seed(db);
    db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("mode-chat", "{}");
    db.exec("INSERT INTO schema_migrations VALUES(64,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow("newer than this application supports");
    db.exec("DELETE FROM schema_migrations WHERE version=64; DELETE FROM schema_migrations WHERE version=60");
    expect(() => migrateOpenBotDatabase(db)).toThrow("missing version 60");
    expect(db.prepare("SELECT selection_json FROM thread_skill_modes").get()).toEqual({ selection_json: "{}" });
  });
});
