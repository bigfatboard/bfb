// ABOUTME: Defines the typed Drizzle contract for F04-owned D1 workspace tables.
// ABOUTME: Reviewed SQL migrations remain deployment source while tests prevent shape drift.

import { sql } from "drizzle-orm";
import { check, foreignKey, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey().notNull(),
    slug: text("slug").notNull().unique(),
    jurisdiction: text("jurisdiction", { enum: ["eu", "us", "global"] }).notNull(),
    createdAt: text("created_at").notNull(),
    resourceVersion: integer("resource_version").notNull().default(1),
  },
  (table) => [
    check("workspaces_id_length", sql`length(${table.id}) = 26`),
    check("workspaces_jurisdiction", sql`${table.jurisdiction} IN ('eu', 'us', 'global')`),
    check("workspaces_resource_version", sql`${table.resourceVersion} >= 1`),
  ],
);

export const tenantFixtureItems = sqliteTable(
  "tenant_fixture_items",
  {
    workspaceId: text("workspace_id").notNull(),
    id: text("id").notNull(),
    label: text("label").notNull(),
    resourceVersion: integer("resource_version").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({ columns: [table.workspaceId], foreignColumns: [workspaces.id] }),
    check("tenant_fixture_items_resource_version", sql`${table.resourceVersion} >= 1`),
  ],
);

export const tenantFixtureChildren = sqliteTable(
  "tenant_fixture_children",
  {
    workspaceId: text("workspace_id").notNull(),
    id: text("id").notNull(),
    parentId: text("parent_id").notNull(),
    label: text("label").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.id] }),
    foreignKey({
      columns: [table.workspaceId, table.parentId],
      foreignColumns: [tenantFixtureItems.workspaceId, tenantFixtureItems.id],
    }),
  ],
);
