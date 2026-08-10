// ABOUTME: Adapts Cloudflare D1Database to the shared SqlDatabase interface used by domain code.
// ABOUTME: Production Worker fetch always binds env.DB through this adapter; tests inject better-sqlite3.

import type { SqlDatabase } from "./workspace-repository.js";

/** Minimal structural D1 statement surface used by the adapter. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first(colName?: string): Promise<unknown> | unknown;
  all(): Promise<{ results?: unknown[] }> | { results?: unknown[] } | unknown[];
  run():
    | Promise<{ meta?: { changes?: number }; results?: unknown[] }>
    | { meta?: { changes?: number }; changes?: number; results?: unknown[] };
}

/** Minimal structural D1 surface so @bfb/db does not depend on Workers types at compile time. */
export interface D1Like {
  prepare(query: string): D1StatementLike;
}

/**
 * Wraps a D1 binding so domain repositories can prepare/run/get/all against Workers D1.
 * D1 APIs are async; callers that already await statement results work for both D1 and better-sqlite3.
 */
export function adaptD1(d1: D1Like): SqlDatabase {
  return {
    prepare(sql: string) {
      const base = d1.prepare(sql);
      return {
        run(...params: unknown[]) {
          const stmt = params.length > 0 ? base.bind(...params) : base;
          const result = stmt.run();
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<{ meta?: { changes?: number } }>).then((row) => ({
              changes: row.meta?.changes ?? 0,
            })) as unknown as { changes: number };
          }
          return { changes: (result as { changes?: number }).changes ?? 0 };
        },
        get(...params: unknown[]) {
          const stmt = params.length > 0 ? base.bind(...params) : base;
          return stmt.first() as unknown;
        },
        all(...params: unknown[]) {
          const stmt = params.length > 0 ? base.bind(...params) : base;
          const result = stmt.all();
          if (result && typeof (result as Promise<unknown>).then === "function") {
            return (result as Promise<{ results?: unknown[] }>).then(
              (row) => row.results ?? [],
            ) as unknown as unknown[];
          }
          if (Array.isArray(result)) {
            return result;
          }
          return (result as { results?: unknown[] }).results ?? [];
        },
      };
    },
  };
}
