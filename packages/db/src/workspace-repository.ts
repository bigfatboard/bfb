// ABOUTME: Implements the F04 workspace registry repository with mandatory auth contexts.
// ABOUTME: Bootstrap may insert the first workspace only; no unscoped getById exists.

import type { AuthorizationContext, BootstrapContext, Jurisdiction } from "./auth-context.js";

export interface WorkspaceRow {
  id: string;
  slug: string;
  jurisdiction: Jurisdiction;
  created_at: string;
  resource_version: number;
}

/** Promise-only SQL surface shared by D1 (async) and better-sqlite3 (promisified). */
export interface SqlDatabase {
  prepare(sql: string): {
    run: (...params: unknown[]) => Promise<{ changes: number }>;
    get: (...params: unknown[]) => Promise<unknown>;
    all: (...params: unknown[]) => Promise<unknown[]>;
  };
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
