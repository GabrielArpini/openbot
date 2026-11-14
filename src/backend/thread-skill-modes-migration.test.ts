// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOpenBotDatabase } from "./openbot-database-schema";

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});
function at(version: number) {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER stop_upgrade BEFORE INSERT ON schema_migrations WHEN new.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture stop'); END;`);
  expect(() => migrateOpenBotDatabase(db)).toThrow();
  db.exec("DROP TRIGGER stop_upgrade");
  return db;
}
function seed(db: DatabaseSync) {
  db.exec(
    "INSERT INTO projection_threads VALUES('mode-chat','agent-test','Keep this chat',NULL,'2026-01-01','2026-01-01',0)",
  );
}
function healthy(db: DatabaseSync) {
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
}
describe("skill mode upgrade", () => {
  for (let version = 8; version <= 61; version++)
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
    const db = at(61);
    seed(db);
    db.exec(
      "CREATE TEMP TRIGGER fail_mode BEFORE INSERT ON schema_migrations WHEN new.version=62 BEGIN SELECT RAISE(ABORT,'fixture fail'); END",
    );
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('thread_skill_modes','provider_session_skill_modes','agent_skill_mode_defaults')",
        )
        .all(),
    ).toEqual([]);
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 61 });
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
    db.exec("INSERT INTO schema_migrations VALUES(63,'now')");
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    db.exec("DELETE FROM schema_migrations WHERE version=63; DELETE FROM schema_migrations WHERE version=60");
    expect(() => migrateOpenBotDatabase(db)).toThrow();
    expect(db.prepare("SELECT selection_json FROM thread_skill_modes").get()).toEqual({ selection_json: "{}" });
  });
});
