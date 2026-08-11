// ABOUTME: Enforces tenant repository shape and composite foreign-key conventions.
// ABOUTME: Scans real repository syntax and the fully migrated SQLite schema.

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { applyMigrationsForVerification } from "../src/migrations.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.resolve(packageRoot, "../../migrations/d1");

interface ForeignKeyRow {
  id: number;
  table: string;
  from: string;
  to: string;
}

function foreignKeyColumns(db: Database.Database, table: string, parent: string): string[][] {
  const rows = db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as ForeignKeyRow[];
  return [...Map.groupBy(rows, (row) => row.id).values()]
    .filter((group) => group[0]?.table === parent)
    .map((group) => group.map((row) => `${row.from}:${row.to}`).sort())
    .sort((left, right) => left.join("|").localeCompare(right.join("|")));
}

function migratedDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrationsForVerification(db, migrationsDir);
  return db;
}

describe("tenant persistence structure", () => {
  it("requires every repository class to retain an AuthorizationContext", () => {
    const repositoryFiles = readdirSync(path.join(packageRoot, "src"))
      .filter((name) => name.endsWith("repository.ts"))
      .sort();
    expect(repositoryFiles.length).toBeGreaterThan(0);
    for (const name of repositoryFiles) {
      const source = readFileSync(path.join(packageRoot, "src", name), "utf8");
      const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
      for (const statement of parsed.statements) {
        if (!ts.isClassDeclaration(statement) || !statement.name?.text.endsWith("Repository")) {
          continue;
        }
        const constructor = statement.members.find(ts.isConstructorDeclaration);
        expect(constructor, `${statement.name.text} must have a constructor`).toBeDefined();
        expect(
          constructor?.parameters.some(
            (parameter) => parameter.type?.getText(parsed) === "AuthorizationContext",
          ),
          `${statement.name.text} must retain AuthorizationContext`,
        ).toBe(true);
        const instanceMethods = statement.members.filter(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) &&
            !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
        );
        for (const method of instanceMethods) {
          expect(method.name.getText(parsed)).not.toMatch(/^(get|find|load)ById$/);
          expect(
            method.parameters.map((parameter) => parameter.name.getText(parsed)),
          ).not.toContain("workspaceId");
        }
      }
    }
  });

  it("uses workspace identity in every tenant primary key and tenant-parent foreign key", () => {
    const db = migratedDatabase();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const tenantTables = new Set(
      tables.filter((table) => {
        const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
          name: string;
        }>;
        return columns.some((column) => column.name === "workspace_id");
      }),
    );
    const globalCredentialLocators = new Set([
      "human_sessions",
      "oauth_access_tokens",
      "oauth_authorization_codes",
    ]);

    for (const table of tenantTables) {
      if (!globalCredentialLocators.has(table)) {
        const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
          name: string;
          pk: number;
        }>;
        expect(
          columns.some((column) => column.name === "workspace_id" && column.pk > 0),
          `${table} primary identity must include workspace_id`,
        ).toBe(true);
      }

      const foreignKeys = db
        .prepare(`PRAGMA foreign_key_list('${table}')`)
        .all() as ForeignKeyRow[];
      const grouped = Map.groupBy(foreignKeys, (foreignKey) => foreignKey.id);
      for (const group of grouped.values()) {
        const parent = group[0]?.table;
        if (!parent || parent === "workspaces" || !tenantTables.has(parent)) {
          continue;
        }
        expect(
          group.some(
            (foreignKey) => foreignKey.from === "workspace_id" && foreignKey.to === "workspace_id",
          ),
          `${table} has a bare tenant foreign key to ${parent}`,
        ).toBe(true);
      }
    }

    expect(foreignKeyColumns(db, "oauth_delegations", "tasks")).toContainEqual([
      "project_id:project_id",
      "task_id:id",
      "workspace_id:workspace_id",
    ]);
    expect(foreignKeyColumns(db, "tasks", "oauth_delegations")).toContainEqual([
      "created_by_delegation_id:id",
      "workspace_id:workspace_id",
    ]);
    expect(foreignKeyColumns(db, "comments", "oauth_delegations")).toContainEqual([
      "author_delegation_id:id",
      "workspace_id:workspace_id",
    ]);
  });

  it("rejects a tenant delegation that references another workspace's project", () => {
    const db = migratedDatabase();
    const workspaceA = "01JBFB0W0RKSPACE0000000000";
    const workspaceB = "01JBFB0W0RKSPACEB000000000";
    const human = "01JBFB0HVMAN1DX00000000000";
    const projectB = "01JBFB0PR0JECTB00000000000";
    db.prepare(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
       VALUES (?, 'a', 'eu', '2026-08-07T12:00:00Z', 1),
              (?, 'b', 'eu', '2026-08-07T12:00:01Z', 1)`,
    ).run(workspaceA, workspaceB);
    db.prepare(
      `INSERT INTO humans (id, email, display_name, created_at)
       VALUES (?, 'human@synthetic.test', 'Human', '2026-08-07T12:00:00Z')`,
    ).run(human);
    db.prepare(
      `INSERT INTO projects (workspace_id, id, name, slug, tint, resource_version, created_at)
       VALUES (?, ?, 'Project B', 'project-b', '#222222', 1, '2026-08-07T12:00:00Z')`,
    ).run(workspaceB, projectB);

    expect(() =>
      db
        .prepare(
          `INSERT INTO oauth_delegations
           (workspace_id, id, human_id, client_id, resource, project_id, task_id,
            scopes_json, authorization_epoch, expires_at, created_at)
           VALUES (?, '01JBFB0DELEGAT100000000000', ?, 'client',
                   'https://bfb.example.test/mcp', ?, NULL, '[]', 1,
                   '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')`,
        )
        .run(workspaceA, human, projectB),
    ).toThrow(/FOREIGN KEY/);
  });

  it("binds a task-scoped delegation to its selected project", () => {
    const db = migratedDatabase();
    const workspace = "01JBFB0W0RKSPACE0000000000";
    const human = "01JBFB0HVMAN1DX00000000000";
    const projectA = "01JBFB0PR0JECTA00000000000";
    const projectB = "01JBFB0PR0JECTB00000000000";
    const taskA = "01JBFB0TASKA00000000000000";
    db.prepare(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
       VALUES (?, 'workspace', 'eu', '2026-08-07T12:00:00Z', 1)`,
    ).run(workspace);
    db.prepare(
      `INSERT INTO humans (id, email, display_name, created_at)
       VALUES (?, 'human@synthetic.test', 'Human', '2026-08-07T12:00:00Z')`,
    ).run(human);
    db.prepare(
      `INSERT INTO projects (workspace_id, id, name, slug, tint, resource_version, created_at)
       VALUES (?, ?, 'Project A', 'project-a', '#111111', 1, '2026-08-07T12:00:00Z'),
              (?, ?, 'Project B', 'project-b', '#222222', 1, '2026-08-07T12:00:00Z')`,
    ).run(workspace, projectA, workspace, projectB);
    db.prepare(
      `INSERT INTO tasks
       (workspace_id, id, project_id, title, state, priority, next_owner_type,
        punchline, resource_version, created_at)
       VALUES (?, ?, ?, 'Task A', 'ready', 'P1', 'unassigned', 'Ready', 1,
               '2026-08-07T12:00:00Z')`,
    ).run(workspace, taskA, projectA);

    expect(() =>
      db
        .prepare(
          `INSERT INTO oauth_delegations
           (workspace_id, id, human_id, client_id, resource, project_id, task_id,
            scopes_json, authorization_epoch, expires_at, created_at)
           VALUES (?, '01JBFB0DELEGAT200000000000', ?, 'client',
                   'https://bfb.example.test/mcp', ?, ?, '[]', 1,
                   '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')`,
        )
        .run(workspace, human, projectB, taskA),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects cross-workspace task and comment attribution", () => {
    const db = migratedDatabase();
    const workspaceA = "01JBFB0W0RKSPACE0000000000";
    const workspaceB = "01JBFB0W0RKSPACEB000000000";
    const human = "01JBFB0HVMAN1DX00000000000";
    const projectA = "01JBFB0PR0JECTA00000000000";
    const delegationB = "01JBFB0DELEGATB00000000000";
    const taskA = "01JBFB0TASKA00000000000000";
    db.prepare(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
       VALUES (?, 'a', 'eu', '2026-08-07T12:00:00Z', 1),
              (?, 'b', 'eu', '2026-08-07T12:00:01Z', 1)`,
    ).run(workspaceA, workspaceB);
    db.prepare(
      `INSERT INTO humans (id, email, display_name, created_at)
       VALUES (?, 'human@synthetic.test', 'Human', '2026-08-07T12:00:00Z')`,
    ).run(human);
    db.prepare(
      `INSERT INTO projects (workspace_id, id, name, slug, tint, resource_version, created_at)
       VALUES (?, ?, 'Project A', 'project-a', '#111111', 1, '2026-08-07T12:00:00Z')`,
    ).run(workspaceA, projectA);
    db.prepare(
      `INSERT INTO oauth_delegations
       (workspace_id, id, human_id, client_id, resource, project_id, task_id,
        scopes_json, authorization_epoch, expires_at, created_at)
       VALUES (?, ?, ?, 'client', 'https://bfb.example.test/mcp', NULL, NULL,
               '[]', 1, '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')`,
    ).run(workspaceB, delegationB, human);

    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks
           (workspace_id, id, project_id, title, state, priority, next_owner_type,
            punchline, resource_version, created_by_delegation_id, created_at)
           VALUES (?, ?, ?, 'Task A', 'ready', 'P1', 'unassigned', 'Ready', 1, ?,
                   '2026-08-07T12:00:00Z')`,
        )
        .run(workspaceA, taskA, projectA, delegationB),
    ).toThrow(/FOREIGN KEY/);

    db.prepare(
      `INSERT INTO tasks
       (workspace_id, id, project_id, title, state, priority, next_owner_type,
        punchline, resource_version, created_at)
       VALUES (?, ?, ?, 'Task A', 'ready', 'P1', 'unassigned', 'Ready', 1,
               '2026-08-07T12:00:00Z')`,
    ).run(workspaceA, taskA, projectA);
    expect(() =>
      db
        .prepare(
          `INSERT INTO comments
           (workspace_id, id, task_id, author_delegation_id, body, kind, created_at)
           VALUES (?, '01JBFB0C0MMENT100000000000', ?, ?, 'Comment', 'discussion',
                   '2026-08-07T12:00:00Z')`,
        )
        .run(workspaceA, taskA, delegationB),
    ).toThrow(/FOREIGN KEY/);
  });
});
