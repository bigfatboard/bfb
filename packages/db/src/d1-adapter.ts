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
  /** Required for atomic multi-statement writes (Cloudflare D1 batch API). */
  batch(statements: D1StatementLike[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

function immediateStatement(d1: D1Like, sql: string) {
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
}

function assertReadOnlyTransactionQuery(sql: string): void {
  if (!/^SELECT\b/i.test(sql.trimStart())) {
    throw new Error("D1 batch transaction reads require a SELECT statement");
  }
}

/**
 * Wraps a D1 binding so domain code always awaits prepare/run/get/all.
 * Always returns real rows, never casts a Promise to a row.
 *
 * withTransaction queues write statements and commits them with d1.batch().
 * It does not use SQL BEGIN/COMMIT (unsupported as interactive TX on D1).
 */
export function adaptD1(d1: D1Like): SqlDatabase {
  if (typeof d1.batch !== "function") {
    throw new Error("D1 binding must expose batch() for atomic multi-statement writes");
  }

  const self: SqlDatabase = {
    prepare(sql: string) {
      return immediateStatement(d1, sql);
    },
    async withTransaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
      // D1 has no interactive BEGIN/COMMIT. Queue writes and flush once with batch().
      // Reads go to live D1 (no read-your-writes). Domain commands must not re-read
      // rows they just wrote inside the same transaction.
      const writes: D1StatementLike[] = [];
      let failed = false;
      const tx: SqlDatabase = {
        prepare(sql: string) {
          return {
            async run(...params: unknown[]) {
              const base = d1.prepare(sql);
              const stmt = params.length > 0 ? base.bind(...params) : base;
              writes.push(stmt);
              // D1 returns authoritative change counts only after the callback has
              // produced the complete batch. Callers must not branch on a queued write.
              return { changes: null };
            },
            async get(...params: unknown[]) {
              assertReadOnlyTransactionQuery(sql);
              if (writes.length > 0) {
                throw new Error("D1 batch transactions cannot read after a queued write");
              }
              return immediateStatement(d1, sql).get(...params);
            },
            async all(...params: unknown[]) {
              assertReadOnlyTransactionQuery(sql);
              if (writes.length > 0) {
                throw new Error("D1 batch transactions cannot read after a queued write");
              }
              return immediateStatement(d1, sql).all(...params);
            },
          };
        },
        async withTransaction() {
          throw new Error("nested withTransaction is not supported");
        },
      };

      try {
        const result = await fn(tx);
        if (writes.length > 0) {
          await d1.batch(writes);
        }
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (failed) {
          // Writes never flushed when fn throws — atomic abort for the batch path.
          writes.length = 0;
        }
      }
    },
  };
  return self;
}
