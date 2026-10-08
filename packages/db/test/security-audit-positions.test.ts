// ABOUTME: Proves immutable hash-only audit-position metadata is additive to existing security history.
// ABOUTME: Enforces bounded position grammar and write-only atomic guard failures without audit anchor foreign keys.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../src/migrations.js";

const migrations = listMigrationFiles(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
);
const positionIndex = migrations.findIndex(
  (migration) => migration.id === "0047_security_audit_positions",
);
if (positionIndex < 0) throw new Error("audit position migration is missing");
const positionMigration = migrations[positionIndex]!;
const id = (value: number) => value.toString().padStart(26, "0");
const now = "2026-10-06T12:00:00.000Z";

function previousDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations.slice(0, positionIndex)) db.exec(migration.sql);
  db.prepare(
    "INSERT INTO workspaces(id,slug,jurisdiction,created_at) VALUES (?,'position-fixture','eu',?)",
  ).run(id(1), now);
  db.prepare(
    "INSERT INTO humans(id,email,display_name,created_at) VALUES (?,'position@synthetic.test','Synthetic position human',?)",
  ).run(id(2), now);
  db.prepare(
    "INSERT INTO audit_events(workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'synthetic.history','{}',?)",
  ).run(id(1), id(3), id(2), now);
  return db;
}
function migratedDatabase() {
  const db = previousDatabase();
  db.exec(positionMigration.sql);
  return db;
}
const row = {
  position_hash: "a".repeat(64),
  workspace_id: id(1),
  human_id: id(2),
  authorization_epoch: 1,
  projection_version: 1,
  page_limit: 2,
  audience_json: "[]",
  after_hash: null as string | null,
  capture_ceiling: 1,
  expires_at: "2026-10-06T12:10:00.000Z",
  anchor_audit_id: id(3),
  anchor_sort_key: "2026-10-06T12:00:00.000000",
  anchor_rowid: 1,
  created_at: now,
};
function insert(db: Database.Database, overrides: Partial<typeof row> = {}) {
  const value = { ...row, ...overrides };
  db.prepare(
    `INSERT INTO security_audit_positions(${Object.keys(value).join(",")})
    VALUES (${Object.keys(value)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(value));
}

describe("security audit position migration", () => {
  it("adds only empty position metadata without rewriting security history or rowids", () => {
    const db = previousDatabase();
    const before = db.prepare("SELECT rowid,* FROM audit_events").all();
    db.exec(positionMigration.sql);
    expect(db.prepare("SELECT rowid,* FROM audit_events").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM security_audit_positions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM security_audit_position_guards").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("stores only a bounded hash and rejects malformed hashes, UTC values, tuple metadata and audience sizes", () => {
    const db = migratedDatabase();
    for (const overrides of [
      { position_hash: "A".repeat(64) },
      { position_hash: "a".repeat(63) },
      { position_hash: row.position_hash + "\n" },
      { position_hash: row.position_hash + "\u0000synthetic" },
      { after_hash: "not-a-hash" },
      { page_limit: 0 },
      { page_limit: 101 },
      { projection_version: 2 },
      { authorization_epoch: 0 },
      { capture_ceiling: -1 },
      { anchor_audit_id: id(3) + "\u0000synthetic" },
      { anchor_rowid: 0 },
      { anchor_sort_key: row.anchor_sort_key + "\u0000synthetic" },
      { expires_at: "2026-02-30T12:10:00.000Z" },
      { expires_at: "2026-10-06T99:10:00.000Z" },
      { created_at: now + "\u0000synthetic" },
      { audience_json: "{}" },
      { audience_json: JSON.stringify(["x".repeat(32768)]) },
    ])
      expect(() => insert(db, overrides)).toThrow(/CHECK/);
    insert(db);
    expect(db.prepare("SELECT * FROM security_audit_positions").get()).toEqual(row);
  });
  it("makes every field immutable and enforces global hash uniqueness", () => {
    const db = migratedDatabase();
    insert(db);
    for (const [field, value] of Object.entries(row))
      expect(() =>
        db
          .prepare(`UPDATE security_audit_positions SET ${field}=? WHERE position_hash=?`)
          .run(value, row.position_hash),
      ).toThrow(/immutable/);
    expect(() => insert(db)).toThrow(/UNIQUE/);
    db.prepare(
      "INSERT INTO workspaces(id,slug,jurisdiction,created_at) VALUES (?,'position-other','eu',?)",
    ).run(id(5), now);
    expect(() => insert(db, { workspace_id: id(5) })).toThrow(/UNIQUE/);
    for (const table of ["security_audit_positions", "security_audit_position_guards"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        pk: number;
      }>;
      expect(columns.some((column) => column.name === "workspace_id" && column.pk > 0)).toBe(true);
    }
    expect(db.prepare("SELECT * FROM security_audit_positions").get()).toEqual(row);
  });
  it("does not couple audit-anchor deletion or newer membership epochs to historical position metadata", () => {
    const db = migratedDatabase();
    insert(db);
    db.prepare("DELETE FROM audit_events WHERE audit_id=?").run(id(3));
    expect(
      db.prepare("SELECT anchor_audit_id,authorization_epoch FROM security_audit_positions").get(),
    ).toEqual({ anchor_audit_id: id(3), authorization_epoch: 1 });
    const keys = db.prepare("PRAGMA foreign_key_list(security_audit_positions)").all() as Array<{
      table: string;
    }>;
    expect(keys.map((key) => key.table).sort()).toEqual(["humans", "workspaces"]);
  });
  it("rolls back position writes when a write-only current-selection CHECK rejects", () => {
    const db = migratedDatabase();
    expect(() =>
      db.transaction(() => {
        db.prepare(
          "INSERT INTO security_audit_position_guards(workspace_id,id,valid) VALUES (?,?,0)",
        ).run(id(1), id(4));
        insert(db);
      })(),
    ).toThrow(/CHECK/);
    expect(db.prepare("SELECT * FROM security_audit_positions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM security_audit_position_guards").all()).toEqual([]);
  });
});
