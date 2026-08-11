// ABOUTME: Proves adaptD1 withTransaction commits via D1 batch, not SQL BEGIN/COMMIT.
// ABOUTME: Uses a structural D1-like shim with a real better-sqlite3 backend.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adaptD1, type D1Like, type D1StatementLike } from "../src/d1-adapter.js";
import { applyMigrations } from "../src/migrations.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

function asD1(raw: Database.Database): D1Like & { batchCalls: number } {
  let batchCalls = 0;
  const d1 = {
    prepare(sql: string): D1StatementLike {
      let bound: unknown[] = [];
      const statement: D1StatementLike = {
        bind(...params: unknown[]) {
          bound = params;
          return statement;
        },
        async first() {
          const stmt = raw.prepare(sql);
          const row = bound.length > 0 ? stmt.get(...bound) : stmt.get();
          return row ?? null;
        },
        async all() {
          const stmt = raw.prepare(sql);
          const results = bound.length > 0 ? stmt.all(...bound) : stmt.all();
          return { results };
        },
        async run() {
          // Reject interactive transaction SQL — D1 production path must not use it.
          const head = sql.trim().split(/\s+/)[0]?.toUpperCase();
          if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") {
            throw new Error("interactive SQL transactions are not supported on D1");
          }
          const stmt = raw.prepare(sql);
          const result = bound.length > 0 ? stmt.run(...bound) : stmt.run();
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
    async batch(statements: D1StatementLike[]) {
      batchCalls += 1;
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
    get batchCalls() {
      return batchCalls;
    },
  };
  return d1;
}

describe("adaptD1 batch transactions", () => {
  it("requires batch on the D1 binding", () => {
    expect(() =>
      adaptD1({
        prepare() {
          throw new Error("unused");
        },
      } as unknown as D1Like),
    ).toThrow(/batch/);
  });

  it("flushes writes through batch and does not use BEGIN/COMMIT", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrations(raw, migrationsDir);
    raw
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES ('01JBFB0W0RKSPACE0000000000', 'acme', 'eu', '2026-08-07T12:00:00Z', 1)`,
      )
      .run();

    const d1 = asD1(raw);
    const db = adaptD1(d1);
    await db.withTransaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
           VALUES (?, ?, ?, 1)`,
        )
        .run("01JBFB0W0RKSPACE0000000000", "01JBFB01TEM000100000000000", "batched");
    });
    expect(d1.batchCalls).toBe(1);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM tenant_fixture_items").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  it("does not batch writes when the transaction body throws", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrations(raw, migrationsDir);
    raw
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES ('01JBFB0W0RKSPACE0000000000', 'acme', 'eu', '2026-08-07T12:00:00Z', 1)`,
      )
      .run();

    const d1 = asD1(raw);
    const db = adaptD1(d1);
    await expect(
      db.withTransaction(async (tx) => {
        await tx
          .prepare(
            `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
             VALUES (?, ?, ?, 1)`,
          )
          .run("01JBFB0W0RKSPACE0000000000", "01JBFB01TEM000100000000000", "lost");
        throw new Error("abort batch");
      }),
    ).rejects.toThrow(/abort batch/);
    expect(d1.batchCalls).toBe(0);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM tenant_fixture_items").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
