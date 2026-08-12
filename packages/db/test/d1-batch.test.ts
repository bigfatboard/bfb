// ABOUTME: Proves adaptD1 withTransaction commits via D1 batch, not SQL BEGIN/COMMIT.
// ABOUTME: Uses a structural D1-like shim with a real better-sqlite3 backend.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adaptD1, type D1Like, type D1StatementLike } from "../src/d1-adapter.js";
import { createAuthorizationContext, createBootstrapContext } from "../src/auth-context.js";
import { applyMigrationsForVerification } from "../src/migrations.js";
import { BootstrapWorkspaceWriter, WorkspaceRepository } from "../src/workspace-repository.js";

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
      raw.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.run());
        }
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
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
    applyMigrationsForVerification(raw, migrationsDir);
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

  it("does not invent a conditional-write change count before batch commit", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE guarded (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const db = adaptD1(asD1(raw));
    let deferredChanges: number | null | undefined;
    await db.withTransaction(async (tx) => {
      deferredChanges = (
        await tx.prepare("UPDATE guarded SET value = ? WHERE id = ?").run("missing", 404)
      ).changes;
    });
    expect(deferredChanges).toBeNull();
  });

  it("rolls back the complete D1 batch when a later statement fails", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE unique_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL UNIQUE)");
    const db = adaptD1(asD1(raw));
    await expect(
      db.withTransaction(async (tx) => {
        await tx.prepare("INSERT INTO unique_values (id, value) VALUES (?, ?)").run(1, "same");
        await tx.prepare("INSERT INTO unique_values (id, value) VALUES (?, ?)").run(2, "same");
      }),
    ).rejects.toThrow();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM unique_values").get()).toEqual({ n: 0 });
  });

  it("does not batch writes when the transaction body throws", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrationsForVerification(raw, migrationsDir);
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

  it("returns authoritative repository outcomes on immediate D1 writes", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrationsForVerification(raw, migrationsDir);
    const db = adaptD1(asD1(raw));
    await BootstrapWorkspaceWriter.forBootstrap(
      db,
      createBootstrapContext("eu"),
    ).createFirstWorkspace({
      id: "01JBFB0W0RKSPACE0000000000",
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    const repo = WorkspaceRepository.forAuthorization(
      db,
      createAuthorizationContext({
        workspaceId: "01JBFB0W0RKSPACE0000000000",
        principalId: "01JBFB0HVMAN1DX00000000000",
        authorizationEpoch: 1,
        jurisdiction: "eu",
      }),
    );
    await repo.insertFixtureItem("01JBFB01TEM000100000000000", "v1");
    await expect(
      repo.updateFixtureItemLabel("01JBFB01TEM000100000000000", "stale", 2),
    ).resolves.toEqual({ updated: false, resourceVersion: 1 });
    await expect(
      repo.updateFixtureItemLabel("01JBFB01TEM000100000000000", "v2", 1),
    ).resolves.toEqual({ updated: true, resourceVersion: 2 });
    expect(
      raw
        .prepare("SELECT label, resource_version FROM tenant_fixture_items WHERE id = ?")
        .get("01JBFB01TEM000100000000000"),
    ).toEqual({ label: "v2", resource_version: 2 });
  });

  it("fails closed when result-dependent repositories receive a deferred batch write", async () => {
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");
    applyMigrationsForVerification(raw, migrationsDir);
    const d1 = asD1(raw);
    const db = adaptD1(d1);
    await expect(
      db.withTransaction(async (tx) => {
        await BootstrapWorkspaceWriter.forBootstrap(
          tx,
          createBootstrapContext("eu"),
        ).createFirstWorkspace({
          id: "01JBFB0W0RKSPACE0000000000",
          slug: "acme",
          jurisdiction: "eu",
          createdAt: "2026-08-07T12:00:00Z",
        });
      }),
    ).rejects.toThrow(/authoritative write result outside a D1 batch/);
    expect(d1.batchCalls).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 0 });

    raw.exec(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
       VALUES ('01JBFB0W0RKSPACE0000000000', 'acme', 'eu', '2026-08-07T12:00:00Z', 1);
       INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
       VALUES ('01JBFB0W0RKSPACE0000000000', '01JBFB01TEM000100000000000', 'v1', 1);`,
    );
    const repoFor = (transaction: ReturnType<typeof adaptD1>) =>
      WorkspaceRepository.forAuthorization(
        transaction,
        createAuthorizationContext({
          workspaceId: "01JBFB0W0RKSPACE0000000000",
          principalId: "01JBFB0HVMAN1DX00000000000",
          authorizationEpoch: 1,
          jurisdiction: "eu",
        }),
      );
    await expect(
      db.withTransaction(async (tx) => {
        await repoFor(tx).updateFixtureItemLabel("01JBFB01TEM000100000000000", "v2", 1);
      }),
    ).rejects.toThrow(/authoritative write result outside a D1 batch/);
    expect(d1.batchCalls).toBe(0);
    expect(
      raw
        .prepare("SELECT label, resource_version FROM tenant_fixture_items WHERE id = ?")
        .get("01JBFB01TEM000100000000000"),
    ).toEqual({ label: "v1", resource_version: 1 });
  });

  it("rejects reads after queued D1 writes and flushes no partial batch", async () => {
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE guarded (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const d1 = asD1(raw);
    const db = adaptD1(d1);
    await expect(
      db.withTransaction(async (tx) => {
        await tx.prepare("INSERT INTO guarded (id, value) VALUES (?, ?)").run(1, "queued");
        await tx.prepare("SELECT value FROM guarded WHERE id = ?").get(1);
      }),
    ).rejects.toThrow(/cannot read after a queued write/);
    expect(d1.batchCalls).toBe(0);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM guarded").get()).toEqual({ n: 0 });
  });

  it("rejects mutating RETURNING statements through transaction read methods", async () => {
    for (const method of ["get", "all"] as const) {
      const raw = new Database(":memory:");
      raw.exec("CREATE TABLE escaped_writes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      const d1 = asD1(raw);
      const db = adaptD1(d1);
      await expect(
        db.withTransaction(async (tx) => {
          await tx
            .prepare("INSERT INTO escaped_writes (id, value) VALUES (?, ?) RETURNING id")
            [method](1, method);
        }),
      ).rejects.toThrow(/reads require a SELECT statement/);
      expect(d1.batchCalls).toBe(0);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM escaped_writes").get()).toEqual({ n: 0 });
    }
  });
});
