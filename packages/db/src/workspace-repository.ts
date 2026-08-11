// ABOUTME: Implements the F04 workspace registry repository with mandatory auth contexts.
// ABOUTME: Bootstrap may insert the first workspace only; no unscoped getById exists.

import type { AuthorizationContext, BootstrapContext, Jurisdiction } from "./auth-context.js";
import { assertUtcTimestamp } from "./timestamps.js";

export interface WorkspaceRow {
  id: string;
  slug: string;
  jurisdiction: Jurisdiction;
  created_at: string;
  resource_version: number;
}

/** Promise-only prepared statement surface. */
export interface SqlStatement {
  run: (...params: unknown[]) => Promise<{ changes: number }>;
  get: (...params: unknown[]) => Promise<unknown>;
  all: (...params: unknown[]) => Promise<unknown[]>;
}

/**
 * Promise-only SQL surface shared by D1 (async) and better-sqlite3 (promisified).
 * Multi-statement atomic work must use withTransaction(tx => ...).
 */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  /**
   * Runs fn with a transaction-scoped database handle.
   * better-sqlite3: interactive BEGIN/COMMIT with read-your-writes.
   * D1: queues write statements and flushes them with batch() on success.
   */
  withTransaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

export class WorkspaceRepository {
  private constructor(
    private readonly db: SqlDatabase,
    private readonly auth: AuthorizationContext,
  ) {}

  static forAuthorization(db: SqlDatabase, auth: AuthorizationContext): WorkspaceRepository {
    if (auth.kind !== "authorized") {
      throw new Error("workspace repository requires authorization context");
    }
    return new WorkspaceRepository(db, auth);
  }

  // Intentionally no getById(id) without workspace scope.

  async getWorkspace(): Promise<WorkspaceRow | undefined> {
    const row = (await this.db
      .prepare(
        `SELECT id, slug, jurisdiction, created_at, resource_version
         FROM workspaces WHERE id = ?`,
      )
      .get(this.auth.workspaceId)) as WorkspaceRow | undefined;
    return row;
  }

  async listFixtureItems(): Promise<Array<{ workspace_id: string; id: string; label: string }>> {
    return (await this.db
      .prepare(
        `SELECT workspace_id, id, label FROM tenant_fixture_items WHERE workspace_id = ? ORDER BY id`,
      )
      .all(this.auth.workspaceId)) as Array<{ workspace_id: string; id: string; label: string }>;
  }

  async insertFixtureItem(id: string, label: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
         VALUES (?, ?, ?, 1)`,
      )
      .run(this.auth.workspaceId, id, label);
  }

  async insertFixtureChild(id: string, parentId: string, label: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tenant_fixture_children (workspace_id, id, parent_id, label)
         VALUES (?, ?, ?, ?)`,
      )
      .run(this.auth.workspaceId, id, parentId, label);
  }

  /**
   * Optimistic update of a fixture item label. Returns false when the expected
   * resource_version does not match (no row updated).
   */
  async updateFixtureItemLabel(
    id: string,
    label: string,
    expectedVersion: number,
  ): Promise<{ updated: boolean; resourceVersion: number }> {
    const current = (await this.db
      .prepare(
        `SELECT resource_version FROM tenant_fixture_items
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(this.auth.workspaceId, id)) as { resource_version: number } | undefined;
    if (!current) {
      return { updated: false, resourceVersion: expectedVersion };
    }
    if (!optimisticVersionPredicate(current.resource_version, expectedVersion)) {
      return { updated: false, resourceVersion: current.resource_version };
    }
    const next = expectedVersion + 1;
    const result = await this.db
      .prepare(
        `UPDATE tenant_fixture_items
         SET label = ?, resource_version = ?
         WHERE workspace_id = ? AND id = ? AND resource_version = ?`,
      )
      .run(label, next, this.auth.workspaceId, id, expectedVersion);
    return {
      updated: result.changes === 1,
      resourceVersion: result.changes === 1 ? next : current.resource_version,
    };
  }
}

export class BootstrapWorkspaceWriter {
  private constructor(
    private readonly db: SqlDatabase,
    private readonly bootstrap: BootstrapContext,
  ) {}

  static forBootstrap(db: SqlDatabase, bootstrap: BootstrapContext): BootstrapWorkspaceWriter {
    if (bootstrap.kind !== "bootstrap") {
      throw new Error("bootstrap writer requires bootstrap context");
    }
    return new BootstrapWorkspaceWriter(db, bootstrap);
  }

  async createFirstWorkspace(input: {
    id: string;
    slug: string;
    jurisdiction: Jurisdiction;
    createdAt: string;
  }): Promise<WorkspaceRow> {
    assertUtcTimestamp(input.createdAt, "createdAt");
    if (input.jurisdiction !== this.bootstrap.jurisdiction) {
      throw new Error("workspace jurisdiction must match deployment jurisdiction");
    }
    const existing = (await this.db.prepare("SELECT id FROM workspaces LIMIT 1").get()) as
      { id: string } | undefined;
    if (existing) {
      throw new Error("bootstrap cannot mutate or create additional workspaces after first");
    }
    await this.db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(input.id, input.slug, input.jurisdiction, input.createdAt);
    return {
      id: input.id,
      slug: input.slug,
      jurisdiction: input.jurisdiction,
      created_at: input.createdAt,
      resource_version: 1,
    };
  }

  // Bootstrap cannot read existing workspaces.
  getWorkspace(_id: string): never {
    throw new Error("bootstrap context cannot read workspaces");
  }

  updateWorkspace(_id: string): never {
    throw new Error("bootstrap context cannot mutate workspaces");
  }
}

export function optimisticVersionPredicate(
  currentVersion: number,
  expectedVersion: number,
): boolean {
  return currentVersion === expectedVersion;
}
