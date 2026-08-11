// ABOUTME: Promisifies better-sqlite3 so tests share the async SqlDatabase contract with D1.
// ABOUTME: Every test/fixture path should inject this adapter rather than raw Database.

import type { SqlDatabase } from "./workspace-repository.js";

/** Minimal better-sqlite3 surface used by the async adapter. */
export interface BetterSqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface BetterSqliteDatabase {
  prepare(sql: string): BetterSqliteStatement;
  exec?(sql: string): void;
}

/** Wraps a better-sqlite3 Database as Promise-only SqlDatabase with transactions. */
export function adaptBetterSqlite3(db: BetterSqliteDatabase): SqlDatabase {
  const self: SqlDatabase = {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        async run(...params: unknown[]) {
          const result = params.length > 0 ? stmt.run(...params) : stmt.run();
          return { changes: result.changes };
        },
        async get(...params: unknown[]) {
          return params.length > 0 ? stmt.get(...params) : stmt.get();
        },
        async all(...params: unknown[]) {
          return params.length > 0 ? stmt.all(...params) : stmt.all();
        },
      };
    },
    async withTransaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
      const begin = db.prepare("BEGIN IMMEDIATE");
      const commit = db.prepare("COMMIT");
      const rollback = db.prepare("ROLLBACK");
      begin.run();
      try {
        const result = await fn(self);
        commit.run();
        return result;
      } catch (error) {
        try {
          rollback.run();
        } catch {
          // ignore rollback failures when no transaction is open
        }
        throw error;
      }
    },
  };
  return self;
}
