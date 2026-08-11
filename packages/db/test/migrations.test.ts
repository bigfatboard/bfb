// ABOUTME: Proves empty and previous-schema migration paths converge on the same head/schema.
// ABOUTME: Injects interruption boundaries against the real applyMigrations runner.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyMigrations,
  migrationHead,
  readMigrationState,
  schemaSnapshot,
} from "../src/migrations.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

function openDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("d1 migrations", () => {
  it("applies empty database to migration head", () => {
    const db = openDb();
    const result = applyMigrations(db, migrationsDir);
    expect(result.status).toBe("complete");
    expect(result.head).toBe(migrationHead(migrationsDir));
    expect(result.head).toBe("0006_reviewer_role");
    const tables = schemaSnapshot(db).filter((entry) => entry.startsWith("table:workspaces:"));
    expect(tables.length).toBe(1);
  });

  it("previous-schema path converges on the same snapshot", () => {
    const first = openDb();
    applyMigrations(first, migrationsDir);
    const snapshotA = schemaSnapshot(first);

    const second = openDb();
    // Simulate previous released schema fixture: empty bookkeeping only.
    second.exec(`
      CREATE TABLE schema_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const result = applyMigrations(second, migrationsDir);
    expect(result.status).toBe("complete");
    expect(schemaSnapshot(second)).toEqual(snapshotA);
  });

  it("records recoverable state when interrupted before a migration", () => {
    const db = openDb();
    const result = applyMigrations(db, migrationsDir, {
      stopBeforeId: "0001_workspace_registry",
    });
    expect(result.status).toBe("interrupted_before_apply");
    const state = readMigrationState(db);
    expect(state.status).toBe("idle");
    expect(state.detail).toBe("interrupted_before_apply");

    const resumed = applyMigrations(db, migrationsDir);
    expect(resumed.status).toBe("complete");
    expect(resumed.head).toBe("0006_reviewer_role");
  });

  it("records failed state when interrupted during a migration", () => {
    const db = openDb();
    expect(() =>
      applyMigrations(db, migrationsDir, { failDuringId: "0001_workspace_registry" }),
    ).toThrow(/interrupted during/);
    const state = readMigrationState(db);
    expect(state.status).toBe("failed");
    expect(state.current_migration_id).toBe("0001_workspace_registry");
  });
});
