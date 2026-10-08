// ABOUTME: Proves the additive notification identity migration preserves populated delivery and inbox history.
// ABOUTME: Checks random-identity grammar, global uniqueness and immutable source bindings without freezing lifecycle fields.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listMigrationFiles } from "../src/migrations.js";

const migrations = listMigrationFiles(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
);
const identityMigrationIndex = migrations.findIndex(
  (migration) => migration.id === "0046_notification_public_identities",
);
if (identityMigrationIndex < 0) throw new Error("notification identity migration is missing");
const identityMigration = migrations[identityMigrationIndex]!;
const id = (value: number) => value.toString().padStart(26, "0");
const now = "2026-09-12T12:00:00.000Z";
const alias = "7" + "Z".repeat(25);

function previousDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const migration of migrations.slice(0, identityMigrationIndex)) db.exec(migration.sql);
  db.prepare(
    "INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,'identity-fixture','eu',?)",
  ).run(id(1), now);
  db.prepare(
    "INSERT INTO humans (id,email,display_name,created_at) VALUES (?,'identity@synthetic.test','Synthetic identity human',?)",
  ).run(id(2), now);
  for (const [index, state] of [
    "pending",
    "delivered",
    "suppressed",
    "failed",
    "dead_lettered",
  ].entries()) {
    db.prepare(
      `INSERT INTO notification_deliveries
      (workspace_id,delivery_id,channel,human_id,runner_id,event_cursor,event_kind,category,state,attempt_count,last_error,created_at,updated_at,delivered_at)
      VALUES (?,?,'macos',?,?,?,'attention.request','attention',?,3,'synthetic_error',?,?,?)`,
    ).run(
      id(1),
      id(10 + index),
      id(2),
      id(3),
      index + 1,
      state,
      now,
      now,
      state === "delivered" ? now : null,
    );
    db.prepare(
      "INSERT INTO notification_macos_inbox (workspace_id,runner_id,delivery_id,created_at,acked_at) VALUES (?,?,?,?,?)",
    ).run(id(1), id(3), id(10 + index), now, index === 1 ? now : null);
  }
  return db;
}

describe("notification public identity migration", () => {
  it("adds NULL metadata to every historical state without changing original rows or inbox foreign keys", () => {
    const db = previousDatabase();
    const before = db.prepare("SELECT * FROM notification_deliveries ORDER BY delivery_id").all();
    const inbox = db.prepare("SELECT * FROM notification_macos_inbox ORDER BY delivery_id").all();
    db.exec(identityMigration.sql);
    const after = db
      .prepare("SELECT * FROM notification_deliveries ORDER BY delivery_id")
      .all() as Array<Record<string, unknown>>;
    expect(
      after.map(({ public_id, ...row }) => {
        expect(public_id).toBeNull();
        return row;
      }),
    ).toEqual(before);
    expect(db.prepare("SELECT * FROM notification_macos_inbox ORDER BY delivery_id").all()).toEqual(
      inbox,
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("accepts timestamp-free 128-bit Crockford identities and rejects malformed or NUL-suffixed metadata", () => {
    const db = previousDatabase();
    db.exec(identityMigration.sql);
    const statement = db.prepare(
      "UPDATE notification_deliveries SET public_id = ? WHERE delivery_id = ?",
    );
    for (const invalid of [
      "0".repeat(25),
      "8" + "0".repeat(25),
      "0" + "a".repeat(25),
      "0" + "I".repeat(25),
      alias + "\u0000synthetic",
    ]) {
      expect(() => statement.run(invalid, id(10))).toThrow(/CHECK/);
    }
    statement.run(alias, id(10));
    expect(
      db.prepare("SELECT public_id FROM notification_deliveries WHERE delivery_id = ?").get(id(10)),
    ).toEqual({ public_id: alias });
  });

  it("enforces global identity uniqueness instead of silently ignoring a different delivery", () => {
    const db = previousDatabase();
    db.exec(identityMigration.sql);
    db.prepare("UPDATE notification_deliveries SET public_id = ? WHERE delivery_id = ?").run(
      alias,
      id(10),
    );
    db.prepare(
      "INSERT INTO workspaces (id,slug,jurisdiction,created_at) VALUES (?,'identity-other','eu',?)",
    ).run(id(4), now);
    expect(() =>
      db
        .prepare(
          `INSERT INTO notification_deliveries
      (workspace_id,delivery_id,public_id,channel,human_id,event_cursor,event_kind,category,state,created_at,updated_at)
      VALUES (?,?,?,'browser_push',?,1,'attention.request','attention','pending',?,?)
      ON CONFLICT(workspace_id,delivery_id) DO NOTHING`,
        )
        .run(id(4), id(20), alias, id(2), now, now),
    ).toThrow(/UNIQUE/);
    expect(
      db
        .prepare("SELECT delivery_id FROM notification_deliveries WHERE workspace_id = ?")
        .all(id(4)),
    ).toEqual([]);
  });

  it("freezes assigned identity and its source tuple but allows delivery bookkeeping updates", () => {
    const db = previousDatabase();
    db.exec(identityMigration.sql);
    db.prepare("UPDATE notification_deliveries SET public_id = ? WHERE delivery_id = ?").run(
      alias,
      id(10),
    );
    for (const [column, value] of [
      ["public_id", null],
      ["public_id", "0".repeat(26)],
      ["workspace_id", id(4)],
      ["delivery_id", id(30)],
      ["event_cursor", 9],
      ["channel", "browser_push"],
      ["human_id", id(5)],
      ["runner_id", null],
    ] as const) {
      expect(() =>
        db
          .prepare(`UPDATE notification_deliveries SET ${column} = ? WHERE delivery_id = ?`)
          .run(value, id(10)),
      ).toThrow("notification identity is immutable");
    }
    db.prepare(
      `UPDATE notification_deliveries SET state = 'failed',attempt_count = 4,last_error = 'retry_failed',
      updated_at = ?,delivered_at = ? WHERE delivery_id = ?`,
    ).run(now, now, id(10));
    expect(
      db
        .prepare(
          "SELECT public_id,state,attempt_count,last_error FROM notification_deliveries WHERE delivery_id = ?",
        )
        .get(id(10)),
    ).toEqual({ public_id: alias, state: "failed", attempt_count: 4, last_error: "retry_failed" });
  });

  it("does not allow first assignment to rebind its existing source tuple", () => {
    const db = previousDatabase();
    db.exec(identityMigration.sql);
    expect(() =>
      db
        .prepare(
          "UPDATE notification_deliveries SET public_id = ?,event_cursor = 99 WHERE delivery_id = ?",
        )
        .run(alias, id(10)),
    ).toThrow("notification identity is immutable");
    expect(
      db
        .prepare("SELECT public_id,event_cursor FROM notification_deliveries WHERE delivery_id = ?")
        .get(id(10)),
    ).toEqual({ public_id: null, event_cursor: 1 });
  });
});
