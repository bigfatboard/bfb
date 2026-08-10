// ABOUTME: Applies ordered, checked-in D1 SQL migrations with recoverable interruption state.
// ABOUTME: Never runs at Worker startup; callers invoke the runner explicitly in tests/deploy.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface MigrationStatement {
  id: string;
  file: string;
  sql: string;
}

export interface MigrationDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
  pragma?(value: string): unknown;
}

export interface MigrationManifest {
  migration_head: string;
  migrations: Array<{ id: string; file: string }>;
}

export function loadMigrationManifest(migrationsDir: string): MigrationManifest {
  return JSON.parse(
    readFileSync(path.join(migrationsDir, "manifest.json"), "utf8"),
  ) as MigrationManifest;
}

export function listMigrationFiles(migrationsDir: string): MigrationStatement[] {
  const manifest = loadMigrationManifest(migrationsDir);
  return manifest.migrations.map((entry) => ({
    id: entry.id,
    file: entry.file,
    sql: readFileSync(path.join(migrationsDir, entry.file), "utf8"),
  }));
}

export function migrationHead(migrationsDir: string): string {
  return loadMigrationManifest(migrationsDir).migration_head;
}

function ensureBookkeeping(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      current_migration_id TEXT,
      detail TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function appliedIds(db: MigrationDatabase): Set<string> {
  const rows = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{
    id: string;
  }>;
  return new Set(rows.map((row) => row.id));
}

function setState(
  db: MigrationDatabase,
  status: "idle" | "applying" | "failed" | "complete",
  migrationId: string | null,
  detail: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO schema_migration_state (id, status, current_migration_id, detail, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       current_migration_id = excluded.current_migration_id,
       detail = excluded.detail,
       updated_at = excluded.updated_at`,
  ).run(status, migrationId, detail, now);
}

export interface ApplyOptions {
  stopBeforeId?: string;
  failDuringId?: string;
}

export function applyMigrations(
  db: MigrationDatabase,
  migrationsDir: string,
  options: ApplyOptions = {},
): { head: string; applied: string[]; status: string } {
  ensureBookkeeping(db);
  if (typeof db.pragma === "function") {
    db.pragma("foreign_keys = ON");
  }

  const migrations = listMigrationFiles(migrationsDir);
  const done = appliedIds(db);
  const newly: string[] = [];

  for (const migration of migrations) {
    if (options.stopBeforeId === migration.id) {
      setState(db, "idle", migration.id, "interrupted_before_apply");
      return {
        head: [...done].sort().at(-1) ?? "none",
        applied: newly,
        status: "interrupted_before_apply",
      };
    }
    if (done.has(migration.id)) {
      continue;
    }
    setState(db, "applying", migration.id, null);
    if (options.failDuringId === migration.id) {
      setState(db, "failed", migration.id, "injected_failure");
      throw new Error("migration interrupted during " + migration.id);
    }
    db.exec(migration.sql);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
      migration.id,
      now,
    );
    done.add(migration.id);
    newly.push(migration.id);
  }

  const head = migrationHead(migrationsDir);
  setState(db, "complete", head, null);
  return { head, applied: newly, status: "complete" };
}

export function readMigrationState(db: MigrationDatabase): {
  status: string;
  current_migration_id: string | null;
  detail: string | null;
} {
  ensureBookkeeping(db);
  const row = db
    .prepare("SELECT status, current_migration_id, detail FROM schema_migration_state WHERE id = 1")
    .get() as
    { status: string; current_migration_id: string | null; detail: string | null } | undefined;
  return row ?? { status: "idle", current_migration_id: null, detail: null };
}

export function schemaSnapshot(db: MigrationDatabase): string[] {
  const rows = db
    .prepare(
      `SELECT type || ':' || name || ':' || COALESCE(sql, '') AS entry
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all() as Array<{ entry: string }>;
  return rows.map((row) => row.entry.replace(/\s+/g, " ").trim());
}

export function assertNoStartupMigrationImport(source: string): void {
  if (/applyMigrations\s*\(/.test(source) && /export\s+default/.test(source)) {
    // Worker entrypoints must not call applyMigrations.
    if (!source.includes("F04 migration runner is explicit")) {
      throw new Error("Worker entry must not apply migrations at startup");
    }
  }
}

export function discoveredSqlFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}
