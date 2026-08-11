// ABOUTME: Verifies tenant repository auth-context boundaries and composite foreign keys.
// ABOUTME: Uses the real WorkspaceRepository and BootstrapWorkspaceWriter against SQLite.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createAuthorizationContext, createBootstrapContext } from "../src/auth-context.js";
import { applyMigrations } from "../src/migrations.js";
import { adaptBetterSqlite3 } from "../src/sqlite-adapter.js";
import {
  BootstrapWorkspaceWriter,
  WorkspaceRepository,
  type SqlDatabase,
} from "../src/workspace-repository.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

const WS_A = "01JBFB0W0RKSPACE0000000000";
const WS_B = "01JBFB0W0RKSPACEB000000000";
const ITEM = "01JBFB01TEM000100000000000";
const CHILD = "01JBFB0CH11D00100000000000";
const HUMAN = "01JBFB0HVMAN1DX00000000000";

function openMigrated(): { raw: Database.Database; db: SqlDatabase } {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw, migrationsDir);
  return { raw, db: adaptBetterSqlite3(raw) };
}

describe("workspace repository boundaries", () => {
  it("bootstrap creates first workspace only with matching jurisdiction", async () => {
    const { db } = openMigrated();
    const bootstrap = BootstrapWorkspaceWriter.forBootstrap(db, createBootstrapContext("eu"));
    const row = await bootstrap.createFirstWorkspace({
      id: WS_A,
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    expect(row.id).toBe(WS_A);
    await expect(
      bootstrap.createFirstWorkspace({
        id: WS_B,
        slug: "other",
        jurisdiction: "eu",
        createdAt: "2026-08-07T12:00:01Z",
      }),
    ).rejects.toThrow(/cannot mutate or create additional/);
    expect(() => bootstrap.getWorkspace(WS_A)).toThrow(/cannot read/);
  });

  it("rejects jurisdiction mismatch with deployment", async () => {
    const { db } = openMigrated();
    const bootstrap = BootstrapWorkspaceWriter.forBootstrap(db, createBootstrapContext("eu"));
    await expect(
      bootstrap.createFirstWorkspace({
        id: WS_A,
        slug: "acme",
        jurisdiction: "us",
        createdAt: "2026-08-07T12:00:00Z",
      }),
    ).rejects.toThrow(/must match deployment jurisdiction/);
  });

  it("requires authorization context and scopes reads to workspace", async () => {
    const { raw, db } = openMigrated();
    await BootstrapWorkspaceWriter.forBootstrap(
      db,
      createBootstrapContext("eu"),
    ).createFirstWorkspace({
      id: WS_A,
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    // Second workspace inserted only via raw SQL to simulate peer tenant.
    raw
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
       VALUES (?, 'peer', 'eu', '2026-08-07T12:00:02Z', 1)`,
      )
      .run(WS_B);

    const repoA = WorkspaceRepository.forAuthorization(
      db,
      createAuthorizationContext({
        workspaceId: WS_A,
        principalId: HUMAN,
        authorizationEpoch: 1,
        jurisdiction: "eu",
      }),
    );
    expect((await repoA.getWorkspace())?.id).toBe(WS_A);
    await repoA.insertFixtureItem(ITEM, "synthetic-item");
    expect(await repoA.listFixtureItems()).toHaveLength(1);

    const repoB = WorkspaceRepository.forAuthorization(
      db,
      createAuthorizationContext({
        workspaceId: WS_B,
        principalId: HUMAN,
        authorizationEpoch: 1,
        jurisdiction: "eu",
      }),
    );
    expect(await repoB.listFixtureItems()).toHaveLength(0);
    expect((await repoB.getWorkspace())?.id).toBe(WS_B);
  });

  it("rejects cross-workspace parent references at the database layer", async () => {
    const { raw, db } = openMigrated();
    await BootstrapWorkspaceWriter.forBootstrap(
      db,
      createBootstrapContext("eu"),
    ).createFirstWorkspace({
      id: WS_A,
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    raw
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
       VALUES (?, 'peer', 'eu', '2026-08-07T12:00:02Z', 1)`,
      )
      .run(WS_B);
    raw
      .prepare(
        `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
       VALUES (?, ?, 'parent', 1)`,
      )
      .run(WS_A, ITEM);

    expect(() =>
      raw
        .prepare(
          `INSERT INTO tenant_fixture_children (workspace_id, id, parent_id, label)
           VALUES (?, ?, ?, 'child')`,
        )
        .run(WS_B, CHILD, ITEM),
    ).toThrow();
  });

  it("does not expose unscoped getById on the repository class", () => {
    const proto = WorkspaceRepository.prototype as unknown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(WorkspaceRepository.prototype)).not.toContain("getById");
    expect(proto.getById).toBeUndefined();
  });

  it("rolls back multi-statement work when withTransaction fails", async () => {
    const { raw, db } = openMigrated();
    await BootstrapWorkspaceWriter.forBootstrap(
      db,
      createBootstrapContext("eu"),
    ).createFirstWorkspace({
      id: WS_A,
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    await expect(
      db.withTransaction(async (tx) => {
        await tx
          .prepare(
            `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
             VALUES (?, ?, ?, 1)`,
          )
          .run(WS_A, ITEM, "synthetic-item");
        throw new Error("force rollback");
      }),
    ).rejects.toThrow(/force rollback/);
    expect(
      raw.prepare("SELECT COUNT(*) AS n FROM tenant_fixture_items").get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it("rejects optimistic fixture updates on version mismatch", async () => {
    const { db } = openMigrated();
    await BootstrapWorkspaceWriter.forBootstrap(
      db,
      createBootstrapContext("eu"),
    ).createFirstWorkspace({
      id: WS_A,
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    const repo = WorkspaceRepository.forAuthorization(
      db,
      createAuthorizationContext({
        workspaceId: WS_A,
        principalId: HUMAN,
        authorizationEpoch: 1,
        jurisdiction: "eu",
      }),
    );
    await repo.insertFixtureItem(ITEM, "v1");
    const stale = await repo.updateFixtureItemLabel(ITEM, "stale", 99);
    expect(stale.updated).toBe(false);
    const ok = await repo.updateFixtureItemLabel(ITEM, "v2", 1);
    expect(ok.updated).toBe(true);
    expect(ok.resourceVersion).toBe(2);
  });

  it("rejects jurisdiction mutation at the database layer", async () => {
    const { raw, db } = openMigrated();
    await BootstrapWorkspaceWriter.forBootstrap(
      db,
      createBootstrapContext("eu"),
    ).createFirstWorkspace({
      id: WS_A,
      slug: "acme",
      jurisdiction: "eu",
      createdAt: "2026-08-07T12:00:00Z",
    });
    expect(() =>
      raw.prepare(`UPDATE workspaces SET jurisdiction = 'us' WHERE id = ?`).run(WS_A),
    ).toThrow(/immutable/);
  });

  it("rejects non-UTC createdAt on bootstrap", async () => {
    const { db } = openMigrated();
    const bootstrap = BootstrapWorkspaceWriter.forBootstrap(db, createBootstrapContext("eu"));
    await expect(
      bootstrap.createFirstWorkspace({
        id: WS_A,
        slug: "acme",
        jurisdiction: "eu",
        createdAt: "2026-08-07 12:00:00",
      }),
    ).rejects.toThrow(/invalid UTC timestamp/);
  });
});
