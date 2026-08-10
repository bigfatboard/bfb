// ABOUTME: Shared test helpers that open a migrated SQLite database with synthetic fixtures.
// ABOUTME: Drives real migrations and seed helpers rather than reimplementing schema.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyMigrations } from "@bfb/db";

import { seedSyntheticWorkspace } from "../src/fixtures.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

export function openDomainDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, migrationsDir);
  seedSyntheticWorkspace(db);
  return db;
}
