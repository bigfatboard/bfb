// ABOUTME: Shared test helpers that open a migrated async SqlDatabase with synthetic fixtures.
// ABOUTME: Always uses adaptBetterSqlite3 so tests share the Promise-only contract with D1.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";

import { seedSyntheticWorkspace } from "../src/fixtures.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

export async function openMigratedDomainDb(): Promise<SqlDatabase> {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, migrationsDir);
  return adaptBetterSqlite3(raw);
}

export async function openDomainDb(): Promise<SqlDatabase> {
  const db = await openMigratedDomainDb();
  await seedSyntheticWorkspace(db);
  return db;
}
