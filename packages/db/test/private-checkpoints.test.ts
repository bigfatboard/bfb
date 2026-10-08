// ABOUTME: Verifies additive private checkpoint storage and retained tenant-aware origin relationships.
// ABOUTME: Preserves old records while rejecting checkpoint rebinding, deletion and invalid provenance.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../src/migrations.js";
import { MIGRATION_HEAD } from "../src/index.js";

const migrations = listMigrationFiles(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
);
const checkpointIndex = migrations.findIndex(({ id }) => id === "0049_task_private_checkpoints");
if (checkpointIndex < 0) throw new Error("private checkpoint migration is missing");
const checkpointMigration = migrations[checkpointIndex]!;
const id = (number: number) => String(number).padStart(26, "0");
const now = "2026-10-08T12:00:00.000Z";
const digest = "sha256:" + "a".repeat(64);

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations.slice(0, checkpointIndex)) db.exec(migration.sql);
  // Synthetic historical rows establish the pre-migration relationships, not a feature write path.
  db.prepare(
    "INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,'checkpoint-fixture','eu',?)",
  ).run(id(1), now);
  for (const human of [2, 3]) {
    db.prepare(
      "INSERT INTO humans (id,email,display_name,created_at) VALUES (?,?,'Synthetic checkpoint human',?)",
    ).run(id(human), `checkpoint-${human}@synthetic.test`, now);
    db.prepare(
      "INSERT INTO workspace_authorization_epochs (workspace_id,human_id,authorization_epoch,updated_at) VALUES (?,?,1,?)",
    ).run(id(1), id(human), now);
  }
  for (const project of [4, 5])
    db.prepare(
      "INSERT INTO projects (workspace_id,id,name,slug,tint,created_at) VALUES (?,?,'Synthetic checkpoint project',?,'#abcdef',?)",
    ).run(id(1), id(project), `checkpoint-${project}`, now);
  db.prepare(
    `INSERT INTO tasks (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic retained task','ready','P2','unassigned','Synthetic retained task',?,?)`,
  ).run(id(1), id(6), id(4), id(2), now);
  db.prepare(
    `INSERT INTO oauth_delegations (workspace_id,id,human_id,client_id,resource,project_id,scopes_json,authorization_epoch,expires_at,created_at)
    VALUES (?,?,?,'synthetic-checkpoint-client','https://synthetic.test/mcp',?,'["bfb:read"]',1,?,?)`,
  ).run(id(1), id(7), id(2), id(4), now, now);
  db.prepare(
    "INSERT INTO comments (workspace_id,id,task_id,author_human_id,body,kind,created_at) VALUES (?,?,?,?,'Synthetic ordinary progress','progress',?)",
  ).run(id(1), id(8), id(6), id(2), now);
  return db;
}
function insert(db: Database.Database, overrides: Record<string, unknown> = {}) {
  const row = {
    workspace_id: id(1),
    id: id(9),
    task_id: id(6),
    project_id: id(4),
    owner_human_id: id(2),
    origin_delegation_id: null,
    origin_client_id: null,
    body: "Synthetic private checkpoint",
    content_hash: digest,
    created_at: now,
    ...overrides,
  };
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT INTO task_private_checkpoints (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
}
function snapshot(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
  );
}

describe("author-private checkpoint migration", () => {
  it("adds empty storage without changing any populated historical table", () => {
    const db = fixture(),
      before = snapshot(db);
    db.exec(checkpointMigration.sql);
    const { task_private_checkpoints, ...after } = snapshot(db);
    expect(task_private_checkpoints).toEqual([]);
    expect(after).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(MIGRATION_HEAD).toBe(checkpointMigration.id);
  });
  it("accepts direct human and exact delegation/client origins without an epoch history cutoff", () => {
    const db = fixture();
    db.exec(checkpointMigration.sql);
    insert(db);
    insert(db, {
      id: id(10),
      origin_delegation_id: id(7),
      origin_client_id: "synthetic-checkpoint-client",
    });
    db.prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch=2,revoked_at=? WHERE workspace_id=? AND human_id=?",
    ).run(now, id(1), id(2));
    expect(
      db
        .prepare(
          "SELECT origin_delegation_id,origin_client_id FROM task_private_checkpoints ORDER BY id",
        )
        .all(),
    ).toEqual([
      { origin_delegation_id: null, origin_client_id: null },
      { origin_delegation_id: id(7), origin_client_id: "synthetic-checkpoint-client" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("rejects mismatched owner, task/project, OAuth/client and partial origin pairs", () => {
    const db = fixture();
    db.exec(checkpointMigration.sql);
    for (const invalid of [
      { project_id: id(5) },
      { task_id: id(99) },
      { workspace_id: id(99) },
      { owner_human_id: id(99) },
      { origin_delegation_id: id(7) },
      { origin_client_id: "synthetic-checkpoint-client" },
      { origin_delegation_id: id(7), origin_client_id: "wrong-client" },
      {
        origin_delegation_id: id(7),
        origin_client_id: "synthetic-checkpoint-client",
        owner_human_id: id(3),
      },
    ])
      expect(() => insert(db, invalid)).toThrow();
    expect(db.prepare("SELECT * FROM task_private_checkpoints").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("retains every checkpoint field and prevents parent/owner/origin deletion", () => {
    const db = fixture();
    db.exec(checkpointMigration.sql);
    insert(db, { origin_delegation_id: id(7), origin_client_id: "synthetic-checkpoint-client" });
    const before = snapshot(db);
    for (const [column, value] of [
      ["body", "Changed"],
      ["task_id", id(99)],
      ["owner_human_id", id(3)],
      ["origin_client_id", null],
      ["content_hash", digest],
      ["created_at", now],
    ] as const)
      expect(() =>
        db.prepare(`UPDATE task_private_checkpoints SET ${column}=?`).run(value),
      ).toThrow("private checkpoint is immutable");
    expect(() => db.prepare("DELETE FROM task_private_checkpoints").run()).toThrow(
      "private checkpoint is retained",
    );
    expect(() => db.prepare("DELETE FROM oauth_delegations WHERE id=?").run(id(7))).toThrow();
    expect(() => db.prepare("DELETE FROM tasks WHERE id=?").run(id(6))).toThrow();
    expect(() =>
      db.prepare("DELETE FROM workspace_authorization_epochs WHERE human_id=?").run(id(2)),
    ).toThrow();
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("bounds bodies and canonical hashes without truncating Unicode", () => {
    const db = fixture();
    db.exec(checkpointMigration.sql);
    for (const invalid of [
      { body: "" },
      { body: "x".repeat(2049) },
      { body: "x\u0000hidden" },
      { content_hash: digest + "\n" },
      { content_hash: "sha256:" + "g".repeat(64) },
      { content_hash: digest + "\u0000" },
    ])
      expect(() => insert(db, invalid)).toThrow(/CHECK/);
    insert(db, { body: "🙂".repeat(2048) });
    expect(
      db.prepare("SELECT length(body) AS characters FROM task_private_checkpoints").get(),
    ).toEqual({ characters: 2048 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
