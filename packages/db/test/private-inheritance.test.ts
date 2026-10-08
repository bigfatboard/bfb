// ABOUTME: Verifies additive private inheritance storage and exact retained parent/root relationships.
// ABOUTME: Preserves populated history and truthful child authorship while testing database backstops.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIGRATION_HEAD } from "../src/index.js";
import { listMigrationFiles, loadMigrationManifest } from "../src/migrations.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);
const migrations = listMigrationFiles(migrationsDir);
const inheritanceIndex = migrations.findIndex(({ id }) => id === "0050_task_privacy_inheritance");
if (inheritanceIndex < 0) throw new Error("private inheritance migration is missing");
const inheritanceMigration = migrations[inheritanceIndex]!;
const id = (number: number) => String(number).padStart(26, "0");
const now = "2026-10-08T12:00:00.000Z";

function task(
  db: Database.Database,
  taskId: number,
  parent: number | null,
  human: number | null,
  delegation: number | null = null,
  project = 4,
  workspace = 1,
) {
  db.prepare(
    `INSERT INTO tasks (workspace_id,id,project_id,parent_task_id,title,state,priority,
      next_owner_type,punchline,created_by_human_id,created_by_delegation_id,created_at)
     VALUES (?,?,?,?,'Synthetic retained task','ready','P2','unassigned',
      'Synthetic retained task',?,?,?)`,
  ).run(
    id(workspace),
    id(taskId),
    id(project),
    parent === null ? null : id(parent),
    human === null ? null : id(human),
    delegation === null ? null : id(delegation),
    now,
  );
}

function policy(db: Database.Database, taskId: number, human: number, workspace = 1) {
  db.prepare(
    "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
  ).run(id(workspace), id(taskId), id(human), now);
}

function fixture(applyInheritance = true) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations.slice(0, inheritanceIndex)) db.exec(migration.sql);
  // Synthetic historical rows preserve old policy/grant/checkpoint storage, not an activated feature.
  for (const workspace of [1, 101])
    db.prepare("INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,?,'eu',?)").run(
      id(workspace),
      `inheritance-${workspace}`,
      now,
    );
  for (const human of [2, 3])
    db.prepare(
      "INSERT INTO humans (id,email,display_name,created_at) VALUES (?,?,'Synthetic inheritance human',?)",
    ).run(id(human), `inheritance-${human}@synthetic.test`, now);
  for (const [workspace, human, role] of [
    [1, 2, "owner"],
    [1, 3, "member"],
    [101, 3, "owner"],
  ] as const) {
    db.prepare(
      "INSERT INTO workspace_authorization_epochs (workspace_id,human_id,authorization_epoch,updated_at) VALUES (?,?,1,?)",
    ).run(id(workspace), id(human), now);
    db.prepare(
      "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,?,1,?)",
    ).run(id(workspace), id(human), role, now);
  }
  for (const [workspace, project] of [
    [1, 4],
    [1, 5],
    [101, 104],
  ])
    db.prepare(
      "INSERT INTO projects (workspace_id,id,name,slug,tint,created_at) VALUES (?,?,'Synthetic inheritance project',?,'#abcdef',?)",
    ).run(id(workspace!), id(project!), `inheritance-${project}`, now);
  db.prepare(
    `INSERT INTO oauth_delegations (workspace_id,id,human_id,client_id,resource,project_id,
      scopes_json,authorization_epoch,expires_at,created_at)
     VALUES (?,?,?,'synthetic-inheritance-client','https://synthetic.test/mcp',?,
      '["bfb:read"]',1,?,?)`,
  ).run(id(1), id(7), id(2), id(4), now, now);
  task(db, 10, null, 3);
  task(db, 11, 10, 2);
  task(db, 12, 11, null);
  task(db, 13, 12, null);
  task(db, 14, 11, 3);
  task(db, 15, 11, 2, 7);
  task(db, 16, 10, 3);
  task(db, 17, 11, 3);
  task(db, 18, null, 3);
  task(db, 21, null, 2, null, 5);
  task(db, 22, 21, null, null, 5);
  task(db, 23, null, 2);
  task(db, 24, 23, null);
  task(db, 111, null, 3, null, 104, 101);
  task(db, 112, 111, null, null, 104, 101);
  for (const [taskId, human] of [
    [11, 2],
    [17, 3],
    [18, 3],
    [21, 2],
  ])
    policy(db, taskId!, human!);
  policy(db, 111, 3, 101);
  db.prepare(
    `INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,
      permission,created_at) VALUES (?,?,?,?,1,'read',?)`,
  ).run(id(1), id(30), id(11), id(3), now);
  db.prepare(
    `INSERT INTO comments (workspace_id,id,task_id,author_human_id,body,kind,created_at)
     VALUES (?,?,?,?,'Synthetic retained progress','progress',?)`,
  ).run(id(1), id(31), id(11), id(2), now);
  db.prepare(
    `INSERT INTO task_private_checkpoints (workspace_id,id,task_id,project_id,owner_human_id,
      body,content_hash,created_at) VALUES (?,?,?,?,?,'Synthetic retained checkpoint',?,?)`,
  ).run(id(1), id(32), id(11), id(4), id(2), "sha256:" + "a".repeat(64), now);
  if (applyInheritance) db.exec(inheritanceMigration.sql);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return db;
}

function inherit(db: Database.Database, overrides: Record<string, unknown> = {}, replace = false) {
  const row = {
    workspace_id: id(1),
    project_id: id(4),
    task_id: id(12),
    root_task_id: id(11),
    created_at: now,
    ...overrides,
  };
  const columns = Object.keys(row);
  return db
    .prepare(
      `INSERT ${replace ? "OR REPLACE " : ""}INTO task_privacy_inheritance (${columns.join(",")})
     VALUES (${columns.map(() => "?").join(",")})`,
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

describe("retained private-task inheritance migration", () => {
  it("adds empty association storage without backfilling or changing populated history", () => {
    const db = fixture(false),
      before = snapshot(db);
    const oldSchema = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;
    db.exec(inheritanceMigration.sql);
    const { task_privacy_inheritance, ...after } = snapshot(db);
    expect(task_privacy_inheritance).toEqual([]);
    expect(after).toEqual(before);
    for (const row of oldSchema)
      expect(db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(row.name)).toEqual({
        sql: row.sql,
      });
    expect(loadMigrationManifest(migrationsDir).migration_head).toBe(
      "0050_task_privacy_inheritance",
    );
    expect(MIGRATION_HEAD).toBe(inheritanceMigration.id);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("binds both tasks to the exact workspace/project and the root to its retained policy", () => {
    const db = fixture();
    const keys = db.prepare("PRAGMA foreign_key_list(task_privacy_inheritance)").all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const groups = [...new Set(keys.map((key) => key.id))].map((group) =>
      keys.filter((key) => key.id === group).sort((a, b) => a.seq - b.seq),
    );
    expect(
      groups.map((group) => ({
        table: group[0]!.table,
        from: group.map((key) => key.from),
        to: group.map((key) => key.to),
        deletion: group[0]!.on_delete,
      })),
    ).toEqual([
      {
        table: "task_privacy",
        from: ["workspace_id", "root_task_id"],
        to: ["workspace_id", "task_id"],
        deletion: "RESTRICT",
      },
      {
        table: "tasks",
        from: ["workspace_id", "project_id", "root_task_id"],
        to: ["workspace_id", "project_id", "id"],
        deletion: "RESTRICT",
      },
      {
        table: "tasks",
        from: ["workspace_id", "project_id", "task_id"],
        to: ["workspace_id", "project_id", "id"],
        deletion: "RESTRICT",
      },
    ]);
  });

  it("accepts two-level null-author children and truthful human/delegation children", () => {
    const db = fixture();
    inherit(db);
    for (const child of [13, 14, 15]) inherit(db, { task_id: id(child) });
    inherit(db, {
      workspace_id: id(101),
      project_id: id(104),
      task_id: id(112),
      root_task_id: id(111),
    });
    // A new direct root may also sit beneath a shared parent; inheritance does not forbid it.
    task(db, 26, 10, 2);
    policy(db, 26, 2);
    task(db, 27, 26, null);
    inherit(db, { task_id: id(27), root_task_id: id(26) });
    expect(
      db
        .prepare(
          "SELECT id,created_by_human_id,created_by_delegation_id FROM tasks WHERE id IN (?,?,?,?) ORDER BY id",
        )
        .all(id(12), id(13), id(14), id(15)),
    ).toEqual([
      { id: id(12), created_by_human_id: null, created_by_delegation_id: null },
      { id: id(13), created_by_human_id: null, created_by_delegation_id: null },
      { id: id(14), created_by_human_id: id(3), created_by_delegation_id: null },
      { id: id(15), created_by_human_id: id(2), created_by_delegation_id: id(7) },
    ]);
    expect(db.prepare("SELECT parent_task_id FROM tasks WHERE id=?").get(id(11))).toEqual({
      parent_task_id: id(10),
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM task_privacy WHERE task_id IN (?,?,?,?)")
        .get(id(12), id(13), id(14), id(15)),
    ).toEqual({ count: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects absent, self, cross-tenant/project, unpolicied and wrong-parent roots", () => {
    const db = fixture(),
      before = snapshot(db);
    for (const invalid of [
      { workspace_id: id(99) },
      { workspace_id: id(101), project_id: id(104), root_task_id: id(111) },
      { project_id: id(5) },
      { task_id: id(99) },
      { task_id: id(11) },
      { root_task_id: id(21) },
      { root_task_id: id(111) },
      { task_id: id(24), root_task_id: id(23) },
      { task_id: id(16) },
      { task_id: id(13) },
      { project_id: id(5), task_id: id(22), root_task_id: id(11) },
    ])
      expect(() => inherit(db, invalid)).toThrow();
    expect(snapshot(db)).toEqual(before);
    inherit(db);
    expect(() => inherit(db, { task_id: id(13), root_task_id: id(18) })).toThrow(
      "private task inheritance parent mismatch",
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("excludes direct policies in both insertion orders while keeping creator binding", () => {
    const db = fixture();
    expect(() => inherit(db, { task_id: id(17) })).toThrow(
      "private task inheritance parent mismatch",
    );
    inherit(db, { task_id: id(14) });
    const before = snapshot(db);
    expect(() => policy(db, 14, 3)).toThrow("inherited private task cannot have a direct policy");
    expect(() => policy(db, 10, 2)).toThrow("private task creator mismatch");
    expect(() =>
      db
        .prepare("UPDATE tasks SET created_by_human_id=? WHERE workspace_id=? AND id=?")
        .run(id(3), id(1), id(11)),
    ).toThrow("private task creator is immutable");
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains associations against duplicate replacement, every update and deletion", () => {
    const db = fixture();
    inherit(db);
    const before = snapshot(db);
    expect(() => inherit(db)).toThrow("private task inheritance cannot be replaced");
    expect(() => inherit(db, { created_at: "2026-10-09T12:00:00.000Z" }, true)).toThrow(
      "private task inheritance cannot be replaced",
    );
    for (const [column, value] of [
      ["workspace_id", id(101)],
      ["project_id", id(5)],
      ["task_id", id(13)],
      ["root_task_id", id(18)],
      ["created_at", now],
    ] as const)
      expect(() =>
        db.prepare(`UPDATE task_privacy_inheritance SET ${column}=?`).run(value),
      ).toThrow("private task inheritance is immutable");
    expect(() => db.prepare("DELETE FROM task_privacy_inheritance").run()).toThrow(
      "private task inheritance is retained",
    );
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("retains nullable authors, parent/project and creation identity while allowing workflow edits", () => {
    const db = fixture();
    inherit(db);
    for (const child of [13, 14, 15]) inherit(db, { task_id: id(child) });
    const before = snapshot(db);
    for (const [taskId, column, value] of [
      [12, "workspace_id", id(101)],
      [12, "id", id(99)],
      [12, "project_id", id(5)],
      [12, "parent_task_id", id(10)],
      [12, "created_by_human_id", id(2)],
      [12, "created_by_delegation_id", id(7)],
      [12, "created_at", "2026-10-09T12:00:00.000Z"],
      [13, "parent_task_id", id(11)],
      [14, "created_by_human_id", id(2)],
      [15, "created_by_delegation_id", null],
    ] as const)
      expect(() =>
        db
          .prepare(`UPDATE tasks SET ${column}=? WHERE workspace_id=? AND id=?`)
          .run(value, id(1), id(taskId)),
      ).toThrow("inherited private task lineage is immutable");
    expect(snapshot(db)).toEqual(before);
    db.prepare(
      "UPDATE tasks SET title='Edited workflow',state='active',priority='P1',punchline='Next step',resource_version=2,parent_task_id=parent_task_id WHERE workspace_id=? AND id=?",
    ).run(id(1), id(12));
    expect(
      db
        .prepare(
          "SELECT state,resource_version,created_by_human_id,created_by_delegation_id,parent_task_id FROM tasks WHERE id=?",
        )
        .get(id(12)),
    ).toEqual({
      state: "active",
      resource_version: 2,
      created_by_human_id: null,
      created_by_delegation_id: null,
      parent_task_id: id(11),
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("prevents source deletion and atomically rolls back an invalid staged association", () => {
    const db = fixture();
    inherit(db);
    const before = snapshot(db);
    for (const [sql, key] of [
      ["DELETE FROM tasks WHERE workspace_id=? AND id=?", id(12)],
      ["DELETE FROM tasks WHERE workspace_id=? AND id=?", id(11)],
      ["DELETE FROM task_privacy WHERE workspace_id=? AND task_id=?", id(11)],
    ] as const)
      expect(() => db.prepare(sql).run(id(1), key)).toThrow();
    expect(() =>
      db.transaction(() => {
        task(db, 25, 11, null);
        inherit(db, { task_id: id(25) });
        inherit(db, { task_id: id(16) });
      })(),
    ).toThrow("private task inheritance parent mismatch");
    expect(snapshot(db)).toEqual(before);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
