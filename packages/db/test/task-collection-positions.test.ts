// ABOUTME: Proves hash-only task collection positions preserve existing child rows and canonical history.
// ABOUTME: Checks immutable bounded metadata, retained parent anchors and atomic write-only guard rollback.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrations.js";

const migrations = listMigrationFiles(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
);
const positionIndex = migrations.findIndex(
  (migration) => migration.id === "0048_task_collection_positions",
);
if (positionIndex < 0) throw new Error("task collection position migration is missing");
const positionMigration = migrations[positionIndex]!;
const databases: Database.Database[] = [];
const id = (value: number) => value.toString().padStart(26, "0");
const now = "2026-10-07T12:00:00.000Z";
const families = ["comments", "dependencies", "links", "runs"] as const;
const row = {
  position_hash: "a".repeat(64),
  workspace_id: id(1),
  human_id: id(2),
  authorization_epoch: 1,
  projection_version: 1,
  page_limit: 2,
  audience_json: JSON.stringify([id(3)]),
  after_hash: null as string | null,
  task_id: id(5),
  project_id: id(3),
  collection: "comments",
  capture_ceiling: 2,
  expires_at: "2026-10-07T12:10:00.000Z",
  anchor_id: id(7),
  anchor_rowid: 1,
  created_at: now,
};
type Overrides = Partial<Record<keyof typeof row, unknown>>;

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function previousDatabase(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  for (const migration of migrations.slice(0, positionIndex)) db.exec(migration.sql);
  db.prepare(
    "INSERT INTO workspaces(id,slug,jurisdiction,created_at) VALUES (?,'child-position-fixture','eu',?)",
  ).run(id(1), now);
  db.prepare(
    "INSERT INTO humans(id,email,display_name,created_at) VALUES (?,'child-position@synthetic.test','Synthetic child position human',?)",
  ).run(id(2), now);
  db.prepare(
    "INSERT INTO projects(workspace_id,id,name,slug,tint,created_at) VALUES (?,?,'Synthetic project','child-position','#222222',?)",
  ).run(id(1), id(3), now);
  db.prepare(
    "INSERT INTO agent_profiles(workspace_id,id,name,provider) VALUES (?,?,'Synthetic profile','codex')",
  ).run(id(1), id(4));
  for (const taskId of [id(5), id(6)]) {
    db.prepare(
      `INSERT INTO tasks(workspace_id,id,project_id,title,state,priority,next_owner_type,
        punchline,created_by_human_id,created_at)
       VALUES (?,?,?,'Synthetic task','ready','P2','unassigned','Synthetic summary',?,?)`,
    ).run(id(1), taskId, id(3), id(2), now);
  }
  for (const [commentId, linkId, runId] of [
    [id(7), id(9), id(11)],
    [id(8), id(10), id(12)],
  ]) {
    db.prepare(
      `INSERT INTO comments(workspace_id,id,task_id,author_human_id,body,kind,created_at)
       VALUES (?,?,?,?,'Synthetic comment','discussion',?)`,
    ).run(id(1), commentId, id(5), id(2), now);
    db.prepare(
      `INSERT INTO task_links(workspace_id,id,task_id,kind,url,label,created_at)
       VALUES (?,?,?,'external','https://synthetic.test/child','Synthetic link',?)`,
    ).run(id(1), linkId, id(5), now);
    db.prepare(
      `INSERT INTO runs(workspace_id,id,project_id,task_id,requested_by_human_id,
        agent_profile_id,result_state,activity,created_at)
       VALUES (?,?,?,?,?,?,'open','unknown',?)`,
    ).run(id(1), runId, id(3), id(5), id(2), id(4), now);
  }
  db.prepare(
    `INSERT INTO task_dependencies(workspace_id,project_id,task_id,depends_on_task_id,kind,created_at)
     VALUES (?,?,?,?,'blocks',?)`,
  ).run(id(1), id(3), id(5), id(6), now);
  db.prepare(
    `INSERT INTO task_context_items(workspace_id,id,task_id,kind,audience,body,version,content_hash,created_at)
     VALUES (?,?,?,'note','both','Synthetic context',1,?,?)`,
  ).run(id(1), id(13), id(5), "sha256:" + "0".repeat(64), now);
  db.prepare(
    "INSERT INTO semantic_events(workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,1,'synthetic.history','{}',?)",
  ).run(id(1), id(14), now);
  db.prepare(
    "INSERT INTO audit_events(workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'synthetic.history','{}',?)",
  ).run(id(1), id(15), id(2), now);
  db.prepare(
    "INSERT INTO outbox_records(workspace_id,outbox_id,kind,payload_json,created_at) VALUES (?,?,'synthetic.history','{}',?)",
  ).run(id(1), id(16), now);
  db.prepare(
    "INSERT INTO idempotency_records(workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,'synthetic-history','synthetic.history','{}',?)",
  ).run(id(1), now);
  db.prepare("INSERT INTO workspace_cursors(workspace_id,cursor) VALUES (?,1)").run(id(1));
  db.prepare(
    `INSERT INTO security_audit_positions(position_hash,workspace_id,human_id,authorization_epoch,
      projection_version,page_limit,audience_json,after_hash,capture_ceiling,expires_at,
      anchor_audit_id,anchor_sort_key,anchor_rowid,created_at)
     VALUES (?,?,?,1,1,2,?,NULL,1,?,?,?,1,?)`,
  ).run(
    "b".repeat(64),
    id(1),
    id(2),
    JSON.stringify([id(3)]),
    row.expires_at,
    id(15),
    "2026-10-07T12:00:00.000000",
    now,
  );
  return db;
}

function migratedDatabase(): Database.Database {
  const db = previousDatabase();
  db.exec(positionMigration.sql);
  return db;
}

function insert(db: Database.Database, overrides: Overrides = {}): void {
  const value = { ...row, ...overrides };
  db.prepare(
    `INSERT INTO task_collection_positions(${Object.keys(value).join(",")})
     VALUES (${Object.keys(value)
       .map(() => "?")
       .join(",")})`,
  ).run(...Object.values(value));
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function snapshot(db: Database.Database, tables = tableNames(db)): Record<string, unknown[]> {
  return Object.fromEntries(
    tables.map((table) => [
      table,
      db.prepare(`SELECT rowid,* FROM ${JSON.stringify(table)} ORDER BY rowid`).all(),
    ]),
  );
}

describe("browser task collection position migration", () => {
  it("adds empty metadata without rewriting any existing history or child insertion rowids", () => {
    const db = previousDatabase();
    const tables = tableNames(db);
    const before = snapshot(db, tables);
    for (const child of ["comments", "task_dependencies", "task_links", "runs"])
      expect(before[child]?.length).toBeGreaterThan(0);
    db.exec(positionMigration.sql);
    expect(snapshot(db, tables)).toEqual(before);
    expect(tableNames(db).filter((table) => !tables.includes(table))).toEqual([
      "task_collection_position_guards",
      "task_collection_positions",
    ]);
    expect(db.prepare("SELECT * FROM task_collection_positions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM task_collection_position_guards").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("accepts all four families, boundary limits and bounded hash-only metadata", () => {
    const db = migratedDatabase();
    for (const [index, collection] of families.entries())
      insert(db, {
        position_hash: String(index).repeat(64),
        collection,
        page_limit: index % 2 === 0 ? 1 : 100,
        after_hash: index === 0 ? null : "f".repeat(64),
        authorization_epoch: 9007199254740991,
        capture_ceiling: 0,
        audience_json: JSON.stringify(["x".repeat(32764)]),
      });
    expect(
      db.prepare("SELECT collection FROM task_collection_positions ORDER BY position_hash").all(),
    ).toEqual(families.map((collection) => ({ collection })));
    const columns = db.prepare("PRAGMA table_info(task_collection_positions)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toEqual(Object.keys(row));
    expect(columns.some(({ name }) => /plaintext|secret|body|token/.test(name))).toBe(false);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects malformed hashes and noncanonical task, project or anchor identities", () => {
    const db = migratedDatabase();
    for (const field of ["position_hash", "after_hash"] as const)
      for (const invalid of [
        "A".repeat(64),
        "a".repeat(63),
        "g".repeat(64),
        "a".repeat(65),
        "a".repeat(64) + "\u0000synthetic",
        Buffer.from("a".repeat(64)),
      ])
        expect(() => insert(db, { [field]: invalid })).toThrow(/CHECK/);
    for (const field of ["task_id", "project_id", "anchor_id"] as const)
      for (const invalid of [
        id(5).slice(1),
        id(5) + "0",
        "a".repeat(26),
        "I".repeat(26),
        id(5) + "\u0000synthetic",
        Buffer.from(id(5)),
      ])
        expect(() => insert(db, { [field]: invalid })).toThrow(/CHECK/);
    expect(db.prepare("SELECT * FROM task_collection_positions").all()).toEqual([]);
    insert(db);
    expect(db.prepare("SELECT * FROM task_collection_positions").get()).toEqual(row);
  });

  it("rejects unsupported families and noninteger or out-of-range numeric metadata", () => {
    const db = migratedDatabase();
    const invalid: Overrides[] = [
      { authorization_epoch: 0 },
      { authorization_epoch: -1 },
      { authorization_epoch: 1.5 },
      { authorization_epoch: 9007199254740992 },
      { projection_version: 0 },
      { projection_version: 2 },
      { projection_version: 1.5 },
      { page_limit: 0 },
      { page_limit: 101 },
      { page_limit: 1.5 },
      { capture_ceiling: -1 },
      { capture_ceiling: 1.5 },
      { anchor_rowid: 0 },
      { anchor_rowid: 1.5 },
      { collection: "context" },
      { collection: "agent_context" },
      { collection: "Comments" },
      { collection: "comments\u0000synthetic" },
    ];
    for (const overrides of invalid) expect(() => insert(db, overrides)).toThrow(/CHECK/);
    expect(db.prepare("SELECT * FROM task_collection_positions").all()).toEqual([]);
  });

  it("requires canonical millisecond UTC and a JSON array bounded by UTF-8 bytes", () => {
    const db = migratedDatabase();
    for (const field of ["expires_at", "created_at"] as const)
      for (const invalid of [
        "2026-02-30T12:00:00.000Z",
        "2026-10-07T99:00:00.000Z",
        "2026-10-07T12:00:00Z",
        "2026-10-07T12:00:00.000000Z",
        "2026-10-07T12:00:00.000+00:00",
        now + "\n",
        now + "\u0000synthetic",
      ])
        expect(() => insert(db, { [field]: invalid })).toThrow(/CHECK/);
    for (const audience of [
      "{",
      "{}",
      '"array"',
      "null",
      JSON.stringify(["x".repeat(32765)]),
      JSON.stringify(["é".repeat(16383)]),
    ])
      expect(() => insert(db, { audience_json: audience })).toThrow();
    insert(db, { audience_json: "[]" });
    expect(db.prepare("SELECT audience_json FROM task_collection_positions").get()).toEqual({
      audience_json: "[]",
    });
  });

  it("makes every stored field immutable and enforces composite identity plus global hash uniqueness", () => {
    const db = migratedDatabase();
    insert(db);
    for (const [field, value] of Object.entries(row))
      expect(() =>
        db
          .prepare(`UPDATE task_collection_positions SET ${field}=? WHERE position_hash=?`)
          .run(value, row.position_hash),
      ).toThrow(/immutable/);
    expect(() => insert(db)).toThrow(/UNIQUE/);
    db.prepare(
      "INSERT INTO workspaces(id,slug,jurisdiction,created_at) VALUES (?,'child-position-other','eu',?)",
    ).run(id(30), now);
    expect(() => insert(db, { workspace_id: id(30) })).toThrow(/UNIQUE/);
    for (const [table, primary] of [
      ["task_collection_positions", ["workspace_id", "position_hash"]],
      ["task_collection_position_guards", ["workspace_id", "id"]],
    ] as const) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        pk: number;
      }>;
      expect(
        columns
          .filter(({ pk }) => pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map(({ name }) => name),
      ).toEqual(primary);
    }
    expect(db.prepare("SELECT * FROM task_collection_positions").get()).toEqual(row);
  });

  it("requires existing workspace and human identities without child, task or project foreign keys", () => {
    const db = migratedDatabase();
    for (const overrides of [{ workspace_id: id(30) }, { human_id: id(31) }])
      expect(() => insert(db, overrides)).toThrow(/FOREIGN KEY/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO task_collection_position_guards(workspace_id,id,valid) VALUES (?,?,1)",
        )
        .run(id(30), id(32)),
    ).toThrow(/FOREIGN KEY/);
    const keys = db.prepare("PRAGMA foreign_key_list(task_collection_positions)").all() as Array<{
      table: string;
      from: string;
      to: string;
    }>;
    expect(keys.map(({ table, from, to }) => [table, from, to]).sort()).toEqual([
      ["humans", "human_id", "id"],
      ["workspaces", "workspace_id", "id"],
    ]);
    insert(db, { collection: "links", anchor_id: id(9) });
    // Schema retention, not an authorized business deletion path: positions must not add parent FKs.
    db.prepare("DELETE FROM task_links WHERE workspace_id=? AND id=?").run(id(1), id(9));
    expect(
      db.prepare("SELECT task_id,project_id,anchor_id FROM task_collection_positions").get(),
    ).toEqual({ task_id: id(5), project_id: id(3), anchor_id: id(9) });
    db.prepare(
      `INSERT INTO tasks(workspace_id,id,project_id,title,state,priority,next_owner_type,
        punchline,created_by_human_id,created_at)
       VALUES (?,?,?,'Synthetic deletable task','ready','P2','unassigned','Synthetic summary',?,?)`,
    ).run(id(1), id(40), id(3), id(2), now);
    insert(db, {
      position_hash: "c".repeat(64),
      task_id: id(40),
      project_id: id(41),
      anchor_id: id(42),
    });
    db.prepare("DELETE FROM tasks WHERE workspace_id=? AND id=?").run(id(1), id(40));
    expect(
      db
        .prepare(
          "SELECT task_id,project_id,anchor_id FROM task_collection_positions WHERE position_hash=?",
        )
        .get("c".repeat(64)),
    ).toEqual({ task_id: id(40), project_id: id(41), anchor_id: id(42) });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back prior position and ledger writes when the CHECK guard rejects", () => {
    const db = migratedDatabase();
    const before = snapshot(db);
    expect(() =>
      db.transaction(() => {
        insert(db);
        db.prepare("UPDATE workspace_cursors SET cursor=2 WHERE workspace_id=?").run(id(1));
        db.prepare(
          "INSERT INTO semantic_events(workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,2,'synthetic.position','{}',?)",
        ).run(id(1), id(50), now);
        db.prepare(
          "INSERT INTO audit_events(workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'synthetic.position','{}',?)",
        ).run(id(1), id(51), id(2), now);
        db.prepare(
          "INSERT INTO outbox_records(workspace_id,outbox_id,kind,payload_json,created_at) VALUES (?,?,'synthetic.position','{}',?)",
        ).run(id(1), id(52), now);
        db.prepare(
          "INSERT INTO idempotency_records(workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,'synthetic-position','synthetic.position','{}',?)",
        ).run(id(1), now);
        db.prepare(
          "INSERT INTO task_collection_position_guards(workspace_id,id,valid) VALUES (?,?,0)",
        ).run(id(1), id(53));
      })(),
    ).toThrow(/CHECK/);
    expect(snapshot(db)).toEqual(before);
    db.transaction(() => {
      db.prepare(
        "INSERT INTO task_collection_position_guards(workspace_id,id,valid) VALUES (?,?,1)",
      ).run(id(1), id(53));
      insert(db);
      db.prepare("DELETE FROM task_collection_position_guards WHERE workspace_id=? AND id=?").run(
        id(1),
        id(53),
      );
    })();
    expect(db.prepare("SELECT * FROM task_collection_positions").get()).toEqual(row);
    expect(db.prepare("SELECT * FROM task_collection_position_guards").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
