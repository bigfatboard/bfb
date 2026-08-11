// ABOUTME: Verifies ordered D1 SQL migrations locally with recoverable interruption injection.
// ABOUTME: Wrangler remains the sole deployment migration authority and runs outside Workers.

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
  const parsed = JSON.parse(
    readFileSync(path.join(migrationsDir, "manifest.json"), "utf8"),
  ) as Partial<MigrationManifest> | null;
  if (!parsed || typeof parsed.migration_head !== "string" || !Array.isArray(parsed.migrations)) {
    throw new Error("invalid migration manifest");
  }
  const ids = new Set<string>();
  const files = new Set<string>();
  let previousId = "";
  for (const entry of parsed.migrations) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      typeof entry.file !== "string" ||
      !/^[0-9]{4}_[a-z0-9_]+$/.test(entry.id) ||
      entry.file !== `${entry.id}.sql` ||
      ids.has(entry.id) ||
      files.has(entry.file) ||
      entry.id <= previousId
    ) {
      throw new Error("invalid ordered migration entry");
    }
    ids.add(entry.id);
    files.add(entry.file);
    previousId = entry.id;
  }
  if (parsed.migrations.length === 0 || parsed.migration_head !== previousId) {
    throw new Error("migration head must match the final ordered migration");
  }
  const discovered = discoveredSqlFiles(migrationsDir);
  if (
    discovered.length !== files.size ||
    discovered.some((file, index) => file !== parsed.migrations?.[index]?.file)
  ) {
    throw new Error("migration manifest and checked-in SQL files differ");
  }
  return parsed as MigrationManifest;
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
    CREATE TABLE IF NOT EXISTS verification_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      current_migration_id TEXT,
      detail TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function appliedIds(db: MigrationDatabase): Set<string> {
  const rows = db.prepare("SELECT id FROM verification_migrations ORDER BY id").all() as Array<{
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
    `INSERT INTO verification_migration_state (id, status, current_migration_id, detail, updated_at)
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
  failAfterSqlId?: string;
}

export function applyMigrationsForVerification(
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
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(migration.sql);
      if (options.failAfterSqlId === migration.id) {
        throw new Error("migration interrupted after SQL " + migration.id);
      }
      const now = new Date().toISOString();
      db.prepare("INSERT INTO verification_migrations (id, applied_at) VALUES (?, ?)").run(
        migration.id,
        now,
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A failure before BEGIN leaves no transaction to roll back.
      }
      setState(
        db,
        "failed",
        migration.id,
        options.failAfterSqlId === migration.id ? "injected_failure_after_sql" : "migration_failed",
      );
      throw error;
    }
    done.add(migration.id);
    newly.push(migration.id);
  }

  const head = migrationHead(migrationsDir);
  setState(db, "complete", head, null);
  return { head, applied: newly, status: "complete" };
}

export function readVerificationMigrationState(db: MigrationDatabase): {
  status: string;
  current_migration_id: string | null;
  detail: string | null;
} {
  ensureBookkeeping(db);
  const row = db
    .prepare(
      "SELECT status, current_migration_id, detail FROM verification_migration_state WHERE id = 1",
    )
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
  if (/\bapplyMigrations(?:ForVerification)?\b/.test(source)) {
    throw new Error("Worker startup must not import or call migrations");
  }
  if (/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER)\b/i.test(source)) {
    throw new Error("Worker runtime must not mutate the database schema");
  }
}

export function discoveredSqlFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}
