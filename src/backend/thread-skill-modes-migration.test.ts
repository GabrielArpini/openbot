// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { THREAD_SKILL_MODES_SCHEMA_SQL } from "./migrations/0067-thread-skill-modes";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
function at(version: number) {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  migrateOpenBotDatabase(db, { throughVersion: version });
  return db;
}
function seed(db: DatabaseSync) {
  db.exec(
    "INSERT INTO projection_threads(thread_id,agent_id,title,active_turn_id,created_at,updated_at,last_event_sequence) VALUES('mode-chat','agent-test','Keep this chat',NULL,'2026-01-01','2026-01-01',0)",
  );
}
function healthy(db: DatabaseSync) {
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}
describe("skill mode upgrade", () => {
  function fork62() {
    const db = at(61);
    seed(db);
    db.exec(THREAD_SKILL_MODES_SCHEMA_SQL);
    db.exec("INSERT INTO schema_migrations VALUES(62,'fork-release')");
    db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("mode-chat", '{"skill":"engineer"}');
    db.prepare("INSERT INTO agent_skill_mode_defaults VALUES(?,?)").run("agent-test", '{"skill":"chief"}');
    db.prepare("INSERT INTO provider_session_skill_modes VALUES(?,?,?)").run("session", "mode-chat", "pinned");
    return db;
  }
  it("upgrades the released fork 62 without losing chats or selected skills", () => {
    const db = fork62();
    const tables = ["projection_threads", "thread_skill_modes", "agent_skill_mode_defaults", "provider_session_skill_modes"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    migrateOpenBotDatabase(db);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(db.prepare("SELECT * FROM projection_messaging_history").all()).toEqual([]);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 67 });
    migrateOpenBotDatabase(db);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    healthy(db);
  });
  it("rolls back fork compatibility repair with its marker and retries", () => {
    const db = fork62();
    db.exec("CREATE TEMP TRIGGER fail_mode BEFORE INSERT ON schema_migrations WHEN new.version=67 BEGIN SELECT RAISE(ABORT,'fixture fail'); END");
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='projection_messaging_history'").all()).toEqual([]);
    expect(db.prepare("SELECT selection_json FROM thread_skill_modes").get()).toEqual({ selection_json: '{"skill":"engineer"}' });
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 66 });
    db.exec("DROP TRIGGER fail_mode");
    migrateOpenBotDatabase(db);
    expect(db.prepare("SELECT * FROM projection_messaging_history").all()).toEqual([]);
    healthy(db);
  });
  it("does not repair an unknown schema that only resembles the fork", () => {
    const db = fork62();
    db.exec("ALTER TABLE agent_skill_mode_defaults ADD COLUMN unknown_field TEXT");
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='projection_messaging_history'").all()).toEqual([]);
    expect(db.prepare("SELECT selection_json FROM thread_skill_modes").get()).toEqual({ selection_json: '{"skill":"engineer"}' });
  });
  for (let version = 8; version <= 66; version++)
    it(`keeps the chat from schema ${version}`, () => {
      const db = at(version);
      seed(db);
      const before = db.prepare("SELECT * FROM projection_threads").all();
      migrateOpenBotDatabase(db);
      expect(db.prepare("SELECT * FROM projection_threads").all()).toEqual(before);
      expect(db.prepare("SELECT * FROM thread_skill_modes").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM agent_skill_mode_defaults").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM provider_session_skill_modes").all()).toEqual([]);
      healthy(db);
    });
  it("rolls back all mode tables and marker on failure, then retries", () => {
    const db = at(66);
    seed(db);
    db.exec(
      "CREATE TEMP TRIGGER fail_mode BEFORE INSERT ON schema_migrations WHEN new.version=67 BEGIN SELECT RAISE(ABORT,'fixture fail'); END",
    );
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('thread_skill_modes','provider_session_skill_modes','agent_skill_mode_defaults')",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 66 });
    db.exec("DROP TRIGGER fail_mode");
    migrateOpenBotDatabase(db);
    healthy(db);
  });
  it("keeps selected modes on a second start", () => {
    const db = at(66);
    migrateOpenBotDatabase(db);
    seed(db);
    db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("mode-chat", "null");
    db.prepare("INSERT INTO agent_skill_mode_defaults VALUES(?,?)").run("agent-test", "{}");
    db.prepare("INSERT INTO provider_session_skill_modes VALUES(?,?,?)").run("session", "mode-chat", "null");
    const before = ["thread_skill_modes", "agent_skill_mode_defaults", "provider_session_skill_modes"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    migrateOpenBotDatabase(db);
    expect(["thread_skill_modes", "agent_skill_mode_defaults", "provider_session_skill_modes"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    )).toEqual(before);
    healthy(db);
  });
  it("rejects orphan modes and cascades a chat deletion", () => {
    const db = at(66);
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
    const db = at(66);
    migrateOpenBotDatabase(db);
    seed(db);
    db.prepare("INSERT INTO thread_skill_modes VALUES(?,?)").run("mode-chat", "{}");
    db.exec("INSERT INTO schema_migrations VALUES(68,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    db.exec("DELETE FROM schema_migrations WHERE version=68; DELETE FROM schema_migrations WHERE version=60");
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    expect(db.prepare("SELECT selection_json FROM thread_skill_modes").get()).toEqual({ selection_json: "{}" });
  });
});
