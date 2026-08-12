// ABOUTME: Checks the F04 Drizzle model against the reviewed SQLite migration shape.
// ABOUTME: Covers names, composite identities, foreign keys, and required checks.

import Database from "better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { applyMigrationsForVerification } from "../src/migrations.js";
import { tenantFixtureChildren, tenantFixtureItems, workspaces } from "../src/schema.js";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

describe("F04 Drizzle schema", () => {
  it("models the workspace registry and composite tenant fixture relationships", () => {
    const workspace = getTableConfig(workspaces);
    const items = getTableConfig(tenantFixtureItems);
    const children = getTableConfig(tenantFixtureChildren);

    expect(workspace.name).toBe("workspaces");
    expect(workspace.columns.map((column) => column.name)).toEqual([
      "id",
      "slug",
      "jurisdiction",
      "created_at",
      "resource_version",
    ]);
    expect(workspace.checks).toHaveLength(3);
    expect(items.checks).toHaveLength(1);
    expect(children.checks).toHaveLength(0);
    expect(items.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "workspace_id",
      "id",
    ]);
    expect(items.foreignKeys[0]?.reference().foreignColumns.map((column) => column.name)).toEqual([
      "id",
    ]);
    expect(children.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "workspace_id",
      "id",
    ]);
    expect(children.foreignKeys[0]?.reference().columns.map((column) => column.name)).toEqual([
      "workspace_id",
      "parent_id",
    ]);
    expect(
      children.foreignKeys[0]?.reference().foreignColumns.map((column) => column.name),
    ).toEqual(["workspace_id", "id"]);

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrationsForVerification(db, migrationsDir);
    for (const config of [workspace, items, children]) {
      const actualColumns = (
        db.prepare(`PRAGMA table_info('${config.name}')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(actualColumns).toEqual(config.columns.map((column) => column.name));
      const tableSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(config.name) as {
          sql: string;
        }
      ).sql;
      expect(tableSql.match(/\bCHECK\s*\(/g) ?? []).toHaveLength(config.checks.length);
    }
    const actualChildForeignKey = db
      .prepare("PRAGMA foreign_key_list('tenant_fixture_children')")
      .all() as Array<{ from: string; to: string }>;
    expect(actualChildForeignKey.map((row) => [row.from, row.to]).sort()).toEqual(
      [
        ["parent_id", "id"],
        ["workspace_id", "workspace_id"],
      ].sort(),
    );
    const ulidTriggers = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name LIKE '%_ulid_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(ulidTriggers.map((row) => row.name)).toEqual([
      "tenant_fixture_children_ulid_insert",
      "tenant_fixture_children_ulid_update",
      "tenant_fixture_items_ulid_insert",
      "tenant_fixture_items_ulid_update",
      "workspaces_ulid_insert",
      "workspaces_ulid_update",
    ]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
           VALUES ('!!!!!!!!!!!!!!!!!!!!!!!!!!', 'invalid', 'eu', '2026-08-07T12:00:00Z', 1)`,
        )
        .run(),
    ).toThrow(/must be a ULID/);
  });
});
