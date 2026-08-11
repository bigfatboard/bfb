// ABOUTME: Proves empty and previous-schema migration paths converge on the same head/schema.
// ABOUTME: Injects every local-verifier interruption boundary while Wrangler owns deployment.

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyMigrationsForVerification,
  assertNoStartupMigrationImport,
  discoveredSqlFiles,
  listMigrationFiles,
  migrationHead,
  readVerificationMigrationState,
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

function writeMigrationFixture(input: {
  head: string;
  entries: Array<{ id: string; file: string }>;
  sqlFiles: string[];
}): string {
  const directory = mkdtempSync(path.join(tmpdir(), "bfb-migration-fixture-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({ migration_head: input.head, migrations: input.entries }),
  );
  for (const file of input.sqlFiles) {
    writeFileSync(
      path.join(directory, file),
      "-- ABOUTME: Synthetic migration validator fixture.\n-- ABOUTME: Exists only in a temporary test directory.\nSELECT 1;\n",
    );
  }
  return directory;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(directory, entry.name))
        : entry.name.endsWith(".ts")
          ? [path.join(directory, entry.name)]
          : [],
    )
    .sort();
}

describe("d1 migrations", () => {
  it("applies empty database to migration head", () => {
    const db = openDb();
    const result = applyMigrationsForVerification(db, migrationsDir);
    expect(result.status).toBe("complete");
    expect(result.head).toBe(migrationHead(migrationsDir));
    expect(result.head).toBe("0010_workspace_authorization");
    const tables = schemaSnapshot(db).filter((entry) => entry.startsWith("table:workspaces:"));
    expect(tables.length).toBe(1);
  });

  it("previous-schema path converges on the same snapshot", () => {
    const first = openDb();
    applyMigrationsForVerification(first, migrationsDir);
    const snapshotA = schemaSnapshot(first);

    const second = openDb();
    const previous = listMigrationFiles(migrationsDir).slice(0, 4);
    for (const migration of previous) {
      second.exec(migration.sql);
    }
    second.exec(`
      CREATE TABLE verification_migrations (
        id TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE verification_migration_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        status TEXT NOT NULL,
        current_migration_id TEXT,
        detail TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    const applied = second.prepare(
      "INSERT INTO verification_migrations (id, applied_at) VALUES (?, ?)",
    );
    for (const migration of previous) {
      applied.run(migration.id, "2026-08-07T12:00:00Z");
    }
    const result = applyMigrationsForVerification(second, migrationsDir);
    expect(result.status).toBe("complete");
    expect(schemaSnapshot(second)).toEqual(snapshotA);
  });

  it("keeps the ordered manifest and checked-in SQL files in exact agreement", () => {
    const migrations = listMigrationFiles(migrationsDir);
    expect(migrations.map((migration) => migration.file)).toEqual(
      discoveredSqlFiles(migrationsDir),
    );
    expect(migrationHead(migrationsDir)).toBe(migrations.at(-1)?.id);
  });

  it("rejects manifest head, ordering, and checked-in file drift", () => {
    const validEntry = { id: "0001_first", file: "0001_first.sql" };
    expect(() =>
      listMigrationFiles(
        writeMigrationFixture({
          head: "0002_missing",
          entries: [validEntry],
          sqlFiles: [validEntry.file],
        }),
      ),
    ).toThrow(/head/);
    expect(() =>
      listMigrationFiles(
        writeMigrationFixture({
          head: "0001_first",
          entries: [{ id: "0002_second", file: "0002_second.sql" }, validEntry],
          sqlFiles: [validEntry.file, "0002_second.sql"],
        }),
      ),
    ).toThrow(/ordered/);
    expect(() =>
      listMigrationFiles(
        writeMigrationFixture({
          head: "0001_first",
          entries: [validEntry],
          sqlFiles: [validEntry.file, "0002_unlisted.sql"],
        }),
      ),
    ).toThrow(/checked-in SQL files differ/);
  });

  it("resumes from every supported pre-apply interruption boundary", () => {
    const expected = openDb();
    applyMigrationsForVerification(expected, migrationsDir);
    const expectedSnapshot = schemaSnapshot(expected);

    for (const migration of listMigrationFiles(migrationsDir)) {
      const db = openDb();
      const result = applyMigrationsForVerification(db, migrationsDir, {
        stopBeforeId: migration.id,
      });
      expect(result.status).toBe("interrupted_before_apply");
      expect(readVerificationMigrationState(db)).toMatchObject({
        status: "idle",
        current_migration_id: migration.id,
        detail: "interrupted_before_apply",
      });
      expect(applyMigrationsForVerification(db, migrationsDir).status).toBe("complete");
      expect(schemaSnapshot(db)).toEqual(expectedSnapshot);
    }
  });

  it("rolls back and resumes from every post-SQL interruption boundary", () => {
    const expected = openDb();
    applyMigrationsForVerification(expected, migrationsDir);
    const expectedSnapshot = schemaSnapshot(expected);

    for (const migration of listMigrationFiles(migrationsDir)) {
      const db = openDb();
      expect(() =>
        applyMigrationsForVerification(db, migrationsDir, { failAfterSqlId: migration.id }),
      ).toThrow(/interrupted after SQL/);
      expect(readVerificationMigrationState(db)).toMatchObject({
        status: "failed",
        current_migration_id: migration.id,
        detail: "injected_failure_after_sql",
      });
      expect(applyMigrationsForVerification(db, migrationsDir).status).toBe("complete");
      expect(schemaSnapshot(db)).toEqual(expectedSnapshot);
    }
  });

  it("keeps migration execution out of Worker startup", () => {
    const appRoot = path.resolve(migrationsDir, "../../apps");
    for (const directory of ["control-worker/src", "artifact-worker/src"]) {
      for (const file of sourceFiles(path.join(appRoot, directory))) {
        expect(
          () => assertNoStartupMigrationImport(readFileSync(file, "utf8")),
          file,
        ).not.toThrow();
      }
    }
    expect(() =>
      assertNoStartupMigrationImport(
        "import { applyMigrations } from '@bfb/db';\napplyMigrations();",
      ),
    ).toThrow(/must not import or call migrations/);
    expect(() =>
      assertNoStartupMigrationImport("await db.prepare('CREATE TABLE runtime (id TEXT)').run();"),
    ).toThrow(/must not mutate the database schema/);
  });
});
