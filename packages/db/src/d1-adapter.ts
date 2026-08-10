// ABOUTME: Adapts Cloudflare D1Database to the shared async SqlDatabase interface.
// ABOUTME: Production Worker fetch always binds env.DB through this adapter.

import type { SqlDatabase } from "./workspace-repository.js";

/** Minimal structural D1 statement surface used by the adapter. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first(colName?: string): Promise<unknown | null>;
  all(): Promise<{ results?: unknown[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}

/** Minimal structural D1 surface so @bfb/db does not depend on Workers types at compile time. */
export interface D1Like {
  prepare(query: string): D1StatementLike;
}

/**
 * Wraps a D1 binding so domain code always awaits prepare/run/get/all.
 * Always returns real rows, never casts a Promise to a row.
 */
export function adaptD1(d1: D1Like): SqlDatabase {
  return {
    prepare(sql: string) {
      const base = d1.prepare(sql);
      return {
        async run(...params: unknown[]) {
          const stmt = params.length > 0 ? base.bind(...params) : base;
          const result = await stmt.run();
          return { changes: result.meta?.changes ?? 0 };
        },
        async get(...params: unknown[]) {
          const stmt = params.length > 0 ? base.bind(...params) : base;
          return await stmt.first();
        },
        async all(...params: unknown[]) {
          const stmt = params.length > 0 ? base.bind(...params) : base;
          const result = await stmt.all();
          return result.results ?? [];
        },
      };
    },
  };
}
