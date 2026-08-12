// ABOUTME: Exercises BFB migrations through Wrangler's real local D1 implementation.
// ABOUTME: Proves empty and populated previous-head upgrades, constraints, and schema parity.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const wranglerPath = resolve(repoRoot, "apps/control-worker/node_modules/.bin/wrangler");
const controlConfig = "apps/control-worker/wrangler.toml";
const migrationDirectory = resolve(repoRoot, "migrations/d1");
const previousFixturePath = resolve(repoRoot, "packages/db/test/fixtures/previous-schema.json");
const expectedWranglerVersion = "4.120.1";
const f04MigrationFiles = [
  "0001_workspace_registry.sql",
  "0002_command_kernel.sql",
  "0003_auth_and_work.sql",
  "0004_human_credentials.sql",
  "0005_workspace_invariants.sql",
  "0006_reviewer_role.sql",
  "0007_tenant_relationships.sql",
] as const;
const migrationManifest = JSON.parse(
  await readFile(resolve(migrationDirectory, "manifest.json"), "utf8"),
) as {
  migration_head: string;
  migrations: Array<{ id: string; file: string }>;
};
const migrationFiles = migrationManifest.migrations.map((entry) => entry.file);

const workspaceA = "01JBFB0W0RKSPACE0000000000";
const workspaceB = "01JBFB0W0RKSPACEB000000000";
const human = "01JBFB0HVMAN1DX00000000000";
const projectA = "01JBFB0PR0JECTA00000000000";
const projectB = "01JBFB0PR0JECTB00000000000";
const taskA = "01JBFB0TASKA00000000000000";
const delegationA = "01JBFB0DELEGATA00000000000";
const delegationB = "01JBFB0DELEGATB00000000000";
const contextA = "01JBFB0C0NTEXTA00000000000";
const commentA = "01JBFB0C0MMENTA00000000000";
const workspaceC = "01JBFB0W0RKSPACEC000000000";
const workspaceD = "01JBFB0W0RKSPACED000000000";
const workspaceE = "01JBFB0W0RKSPACEE000000000";
const item = "01JBFB01TEM000100000000000";
const child = "01JBFB0CH11D00100000000000";

interface PreviousSchemaFixture {
  head: string;
  migrations: Array<{ file: string; sha256: string }>;
}

interface D1Result {
  results: Array<Record<string, unknown>>;
  success: boolean;
}

async function runWrangler(
  label: string,
  args: string[],
  scratch: string,
  expected: "success" | "failure" = "success",
): Promise<string> {
  const stdoutPath = join(scratch, `${label}.stdout.log`);
  const stderrPath = join(scratch, `${label}.stderr.log`);
  process.stdout.write(`[db] ${label} stdout: ${stdoutPath}\n`);
  process.stdout.write(`[db] ${label} stderr: ${stderrPath}\n`);
  const stdoutLog = createWriteStream(stdoutPath, { flags: "wx" });
  const stderrLog = createWriteStream(stderrPath, { flags: "wx" });
  const stdout: Buffer[] = [];
  const childProcess = spawn(wranglerPath, args, {
    cwd: repoRoot,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  childProcess.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    stdoutLog.write(chunk);
    process.stdout.write(chunk);
  });
  childProcess.stderr.on("data", (chunk: Buffer) => {
    stderrLog.write(chunk);
    process.stderr.write(chunk);
  });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", (code, signal) => resolvePromise({ code, signal }));
    },
  );
  await Promise.all([
    new Promise<void>((resolvePromise) => stdoutLog.end(resolvePromise)),
    new Promise<void>((resolvePromise) => stderrLog.end(resolvePromise)),
  ]);
  if (expected === "success" && exit.code !== 0) {
    throw new Error(`${label} failed with ${exit.code ?? exit.signal}`);
  }
  if (expected === "failure" && exit.code === 0) {
    throw new Error(`${label} unexpectedly succeeded`);
  }
  return Buffer.concat(stdout).toString("utf8");
}

function d1Args(persistPath: string, command: string): string[] {
  return [
    "d1",
    "execute",
    "DB",
    "--local",
    "--persist-to",
    persistPath,
    "--config",
    controlConfig,
    "--command",
    command,
    "--json",
  ];
}

async function query(
  label: string,
  persistPath: string,
  command: string,
  scratch: string,
): Promise<Array<Record<string, unknown>>> {
  const output = await runWrangler(label, d1Args(persistPath, command), scratch);
  const parsed = JSON.parse(output) as D1Result[];
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.success, true);
  return parsed[0]?.results ?? [];
}

async function applyMigrations(
  label: string,
  persistPath: string,
  scratch: string,
  configPath = controlConfig,
  expected: "success" | "failure" = "success",
): Promise<void> {
  await runWrangler(
    label,
    [
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      persistPath,
      "--config",
      configPath,
    ],
    scratch,
    expected,
  );
}

async function buildInterruptedMigrationConfig(
  scratch: string,
): Promise<{ configPath: string; migrationPath: string }> {
  const directory = join(scratch, "interrupted-migrations");
  await mkdir(directory);
  for (const file of migrationFiles) {
    let source = await readFile(join(migrationDirectory, file), "utf8");
    if (file === "0007_tenant_relationships.sql") {
      source += `
CREATE TABLE f04_interruption_probe (id INTEGER PRIMARY KEY);
INSERT INTO f04_interruption_probe (id) VALUES (1);
INSERT INTO f04_missing_table (id) VALUES (1);
`;
    }
    await writeFile(join(directory, file), source, { encoding: "utf8", flag: "wx" });
  }
  const configPath = join(scratch, "wrangler-interrupted.toml");
  await writeFile(
    configPath,
    `name = "bfb-db-interruption"
main = ${JSON.stringify(resolve(repoRoot, "apps/control-worker/src/index.ts"))}
compatibility_date = "2026-08-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "bfb-local"
database_id = "00000000-0000-4000-8000-000000000001"
migrations_dir = ${JSON.stringify(directory)}
`,
    { encoding: "utf8", flag: "wx" },
  );
  return { configPath, migrationPath: join(directory, "0007_tenant_relationships.sql") };
}

async function buildPreviousSchemaFixture(scratch: string): Promise<string> {
  const fixture = JSON.parse(await readFile(previousFixturePath, "utf8")) as PreviousSchemaFixture;
  assert.equal(fixture.head, "0004_human_credentials");
  const migrations: string[] = [];
  for (const entry of fixture.migrations) {
    assert.match(entry.file, /^[0-9]{4}_[a-z0-9_]+\.sql$/);
    const source = await readFile(resolve(migrationDirectory, entry.file), "utf8");
    assert.equal(createHash("sha256").update(source).digest("hex"), entry.sha256);
    migrations.push(source);
  }
  const migrationRows = fixture.migrations
    .map((entry, index) => `(${index + 1}, '${entry.file}')`)
    .join(",\n  ");
  const fixtureSql = `${migrations.join("\n\n")}

CREATE TABLE d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations (id, name) VALUES
  ${migrationRows};

INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version) VALUES
  ('${workspaceA}', 'workspace-a', 'eu', '2026-08-07T12:00:00Z', 1),
  ('${workspaceB}', 'workspace-b', 'eu', '2026-08-07T12:00:01Z', 1);
INSERT INTO humans (id, email, display_name, created_at)
  VALUES ('${human}', 'human@synthetic.test', 'Synthetic Human', '2026-08-07T12:00:00Z');
INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at) VALUES
  ('${workspaceA}', '${human}', 'restricted_member', 1, '2026-08-07T12:00:00Z'),
  ('${workspaceB}', '${human}', 'owner', 1, '2026-08-07T12:00:00Z');
INSERT INTO projects (workspace_id, id, name, slug, tint, resource_version, created_at) VALUES
  ('${workspaceA}', '${projectA}', 'Project A', 'project-a', '#111111', 1, '2026-08-07T12:00:00Z'),
  ('${workspaceB}', '${projectB}', 'Project B', 'project-b', '#222222', 1, '2026-08-07T12:00:00Z');
INSERT INTO project_access (workspace_id, project_id, human_id)
  VALUES ('${workspaceA}', '${projectA}', '${human}');
CREATE TABLE oauth_authorization_codes (
  code TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  human_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  scopes_json TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  step_up_proof_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
INSERT INTO passkey_step_up_proofs
  (proof_id, human_id, action, client_id, resource, boundary_json, scopes_json,
   authorization_epoch, expires_at, created_at)
  VALUES ('01JBFB0PR00F00000000000000', '${human}', 'oauth_delegate', 'client',
          'https://bfb.example.test/mcp', '{"workspaceId":"${workspaceA}"}',
          '["bfb:read"]', 1, '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z');
INSERT INTO oauth_authorization_codes
  (code, client_id, redirect_uri, code_challenge, human_id, workspace_id, project_id,
   scopes_json, authorization_epoch, step_up_proof_id, expires_at)
  VALUES ('historical-code', 'client', 'https://client.example.test/callback', 'challenge',
          '${human}', '${workspaceA}', '${projectA}', '["bfb:read"]', 1,
          '01JBFB0PR00F00000000000000', '2026-08-07T13:00:00Z');
INSERT INTO oauth_delegations
  (workspace_id, id, human_id, client_id, resource, project_id, task_id,
   scopes_json, authorization_epoch, expires_at, created_at)
  VALUES ('${workspaceA}', '${delegationA}', '${human}', 'client',
          'https://bfb.example.test/mcp', '${projectA}', '${taskA}', '["bfb:write"]', 1,
          '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z');
INSERT INTO oauth_access_tokens
  (token_hash, workspace_id, delegation_id, expires_at)
  VALUES ('sha256:historical-token', '${workspaceA}', '${delegationA}',
          '2026-08-07T13:00:00Z');
INSERT INTO tasks
  (workspace_id, id, project_id, title, state, priority, next_owner_type,
   punchline, resource_version, created_by_delegation_id, created_at)
  VALUES ('${workspaceA}', '${taskA}', '${projectA}', 'Task A', 'ready', 'P1',
          'unassigned', 'Ready', 1, '${delegationA}', '2026-08-07T12:00:00Z');
INSERT INTO task_context_items
  (workspace_id, id, task_id, audience, body, version, content_hash, created_at)
  VALUES ('${workspaceA}', '${contextA}', '${taskA}', 'both', 'Historical context', 1,
          'sha256:c2d91a2a5524254b4a9d86d5229a327863abdadce67f2e7e15b94334b467f1fe',
          '2026-08-07T12:00:00Z');
INSERT INTO comments
  (workspace_id, id, task_id, author_delegation_id, body, kind, created_at)
  VALUES ('${workspaceA}', '${commentA}', '${taskA}', '${delegationA}',
          'Historical comment', 'discussion', '2026-08-07T12:00:00Z');
INSERT INTO tenant_fixture_items (workspace_id, id, label, resource_version)
  VALUES ('${workspaceA}', '${item}', 'parent', 1);
INSERT INTO tenant_fixture_children (workspace_id, id, parent_id, label)
  VALUES ('${workspaceA}', '${child}', '${item}', 'child');
`;
  const outputPath = join(scratch, "previous-schema.sql");
  await writeFile(outputPath, fixtureSql, { encoding: "utf8", flag: "wx" });
  return outputPath;
}

async function schemaSnapshot(
  label: string,
  persistPath: string,
  scratch: string,
): Promise<Array<Record<string, unknown>>> {
  return await query(
    label,
    persistPath,
    `SELECT type, name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'
     ORDER BY type, name`,
    scratch,
  );
}

async function main(): Promise<void> {
  await access(wranglerPath);
  const controlPackage = JSON.parse(
    await readFile(resolve(repoRoot, "apps/control-worker/package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  assert.equal(controlPackage.devDependencies?.wrangler, expectedWranglerVersion);

  const scratch = await mkdtemp(join(tmpdir(), "bfb-db-"));
  process.stdout.write(`[db] scratch and complete logs: ${scratch}\n`);
  const emptyPersist = join(scratch, "empty");
  const previousPersist = join(scratch, "previous");
  const invalidPreviousPersist = join(scratch, "invalid-previous");
  const malformedPreviousPersist = join(scratch, "malformed-previous");
  const interruptedPersist = join(scratch, "interrupted");

  await applyMigrations("empty-migrate", emptyPersist, scratch);
  const fixturePath = await buildPreviousSchemaFixture(scratch);
  await runWrangler(
    "previous-fixture",
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      previousPersist,
      "--config",
      controlConfig,
      "--file",
      fixturePath,
    ],
    scratch,
  );
  await applyMigrations("previous-migrate", previousPersist, scratch);

  await runWrangler(
    "invalid-previous-fixture",
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      invalidPreviousPersist,
      "--config",
      controlConfig,
      "--file",
      fixturePath,
    ],
    scratch,
  );
  await query(
    "insert-invalid-legacy-delegation",
    invalidPreviousPersist,
    `INSERT INTO oauth_delegations
     (workspace_id, id, human_id, client_id, resource, project_id, task_id,
      scopes_json, authorization_epoch, expires_at, created_at)
     VALUES ('${workspaceA}', '01JBFB0DELEGATX00000000000', '${human}', 'client',
             'https://bfb.example.test/mcp', '${projectB}', NULL, '[]', 1,
             '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')
     RETURNING id`,
    scratch,
  );
  await applyMigrations(
    "reject-invalid-legacy-upgrade",
    invalidPreviousPersist,
    scratch,
    controlConfig,
    "failure",
  );
  assert.deepEqual(
    (
      await query(
        "invalid-legacy-head",
        invalidPreviousPersist,
        "SELECT name FROM d1_migrations ORDER BY id",
        scratch,
      )
    ).map((row) => row.name),
    f04MigrationFiles.slice(0, -1),
  );
  assert.deepEqual(
    await query(
      "invalid-legacy-row-retained",
      invalidPreviousPersist,
      `SELECT workspace_id, project_id FROM oauth_delegations
       WHERE id = '01JBFB0DELEGATX00000000000'`,
      scratch,
    ),
    [{ workspace_id: workspaceA, project_id: projectB }],
  );
  assert.equal(
    (
      await query(
        "invalid-legacy-schema-retained",
        invalidPreviousPersist,
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name = 'oauth_delegations_new'`,
        scratch,
      )
    )[0]?.count,
    0,
  );
  await query(
    "remove-invalid-legacy-delegation",
    invalidPreviousPersist,
    `DELETE FROM oauth_delegations
     WHERE id = '01JBFB0DELEGATX00000000000'
     RETURNING id`,
    scratch,
  );
  await applyMigrations("recover-invalid-legacy-upgrade", invalidPreviousPersist, scratch);

  await runWrangler(
    "malformed-previous-fixture",
    [
      "d1",
      "execute",
      "DB",
      "--local",
      "--persist-to",
      malformedPreviousPersist,
      "--config",
      controlConfig,
      "--file",
      fixturePath,
    ],
    scratch,
  );
  await query(
    "insert-malformed-legacy-workspace",
    malformedPreviousPersist,
    `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
     VALUES ('!!!!!!!!!!!!!!!!!!!!!!!!!!', 'malformed', 'eu', '2026-08-07T12:00:02Z', 1)
     RETURNING id`,
    scratch,
  );
  await applyMigrations(
    "reject-malformed-legacy-upgrade",
    malformedPreviousPersist,
    scratch,
    controlConfig,
    "failure",
  );
  assert.deepEqual(
    (
      await query(
        "malformed-legacy-head",
        malformedPreviousPersist,
        "SELECT name FROM d1_migrations ORDER BY id",
        scratch,
      )
    ).map((row) => row.name),
    f04MigrationFiles.slice(0, 4),
  );
  assert.deepEqual(
    await query(
      "malformed-legacy-row-retained",
      malformedPreviousPersist,
      "SELECT id FROM workspaces WHERE slug = 'malformed'",
      scratch,
    ),
    [{ id: "!!!!!!!!!!!!!!!!!!!!!!!!!!" }],
  );
  await query(
    "remove-malformed-legacy-workspace",
    malformedPreviousPersist,
    "DELETE FROM workspaces WHERE slug = 'malformed' RETURNING id",
    scratch,
  );
  await applyMigrations("recover-malformed-legacy-upgrade", malformedPreviousPersist, scratch);

  const emptySchema = await schemaSnapshot("empty-schema", emptyPersist, scratch);
  const previousSchema = await schemaSnapshot("previous-schema", previousPersist, scratch);
  assert.deepEqual(previousSchema, emptySchema);
  assert.deepEqual(
    await schemaSnapshot("malformed-recovered-schema", malformedPreviousPersist, scratch),
    emptySchema,
  );
  assert.deepEqual(
    await schemaSnapshot("invalid-legacy-recovered-schema", invalidPreviousPersist, scratch),
    emptySchema,
  );
  assert.deepEqual(
    await query(
      "invalid-legacy-recovered-foreign-key-check",
      invalidPreviousPersist,
      "PRAGMA foreign_key_check",
      scratch,
    ),
    [],
  );

  const migrationNames = await query(
    "migration-head",
    previousPersist,
    "SELECT name FROM d1_migrations ORDER BY id",
    scratch,
  );
  assert.deepEqual(
    migrationNames.map((row) => row.name),
    migrationFiles,
  );
  assert.deepEqual(
    await query(
      "populated-data",
      previousPersist,
      `SELECT role,
              (SELECT COUNT(*) FROM project_access) AS grants,
              (SELECT COUNT(*) FROM tenant_fixture_children) AS children,
              (SELECT COUNT(*) FROM oauth_authorization_codes) AS codes,
              (SELECT COUNT(*) FROM oauth_delegations) AS delegations,
              (SELECT COUNT(*) FROM oauth_access_tokens) AS tokens,
              (SELECT COUNT(*) FROM task_context_items) AS contexts,
              (SELECT COUNT(*) FROM comments) AS comments
       FROM workspace_members WHERE workspace_id = '${workspaceA}'`,
      scratch,
    ),
    [
      {
        role: "reviewer",
        grants: 2,
        children: 1,
        codes: 1,
        delegations: 1,
        tokens: 1,
        contexts: 1,
        comments: 1,
      },
    ],
  );
  assert.deepEqual(
    await query("foreign-key-check", previousPersist, "PRAGMA foreign_key_check", scratch),
    [],
  );
  assert.deepEqual(
    await query(
      "populated-row-values",
      previousPersist,
      `SELECT t.id AS task_id, t.created_by_delegation_id,
              d.project_id, d.task_id AS delegated_task_id,
              a.delegation_id AS token_delegation_id,
              x.body AS context_body,
              c.author_delegation_id AS comment_delegation_id
       FROM tasks t
       JOIN oauth_delegations d
         ON d.workspace_id = t.workspace_id AND d.id = t.created_by_delegation_id
       JOIN oauth_access_tokens a
         ON a.workspace_id = d.workspace_id AND a.delegation_id = d.id
       JOIN task_context_items x
         ON x.workspace_id = t.workspace_id AND x.task_id = t.id
       JOIN comments c
         ON c.workspace_id = t.workspace_id AND c.task_id = t.id
       WHERE t.workspace_id = '${workspaceA}' AND t.id = '${taskA}'`,
      scratch,
    ),
    [
      {
        task_id: taskA,
        created_by_delegation_id: delegationA,
        project_id: projectA,
        delegated_task_id: taskA,
        token_delegation_id: delegationA,
        context_body: "Historical context",
        comment_delegation_id: delegationA,
      },
    ],
  );
  assert.deepEqual(
    (
      await query(
        "workspace-invariant-triggers",
        previousPersist,
        `SELECT name FROM sqlite_master
         WHERE type = 'trigger' AND name IN (
           'workspaces_identity_immutable',
           'workspaces_insert_collision',
           'workspaces_jurisdiction_delete_forbidden',
           'workspaces_jurisdiction_immutable',
           'workspaces_slug_collision'
         )
         ORDER BY name`,
        scratch,
      )
    ).map((row) => row.name),
    [
      "workspaces_identity_immutable",
      "workspaces_insert_collision",
      "workspaces_jurisdiction_delete_forbidden",
      "workspaces_jurisdiction_immutable",
      "workspaces_slug_collision",
    ],
  );

  await runWrangler(
    "reject-jurisdiction-replace",
    d1Args(
      previousPersist,
      `INSERT OR REPLACE INTO workspaces
       (id, slug, jurisdiction, created_at, resource_version)
       VALUES ('${workspaceA}', 'workspace-a', 'us', '2026-08-07T12:00:00Z', 1)`,
    ),
    scratch,
    "failure",
  );
  await runWrangler(
    "reject-cross-tenant-delegation",
    d1Args(
      previousPersist,
      `INSERT INTO oauth_delegations
       (workspace_id, id, human_id, client_id, resource, project_id, task_id,
        scopes_json, authorization_epoch, expires_at, created_at)
       VALUES ('${workspaceA}', '01JBFB0DELEGAT100000000000', '${human}', 'client',
               'https://bfb.example.test/mcp', '${projectB}', NULL, '[]', 1,
               '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')`,
    ),
    scratch,
    "failure",
  );
  await query(
    "insert-delete-probe-workspace",
    previousPersist,
    `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
     VALUES ('${workspaceC}', 'workspace-c', 'eu', '2026-08-07T12:00:02Z', 1),
            ('${workspaceD}', 'workspace-d', 'eu', '2026-08-07T12:00:03Z', 1)
     RETURNING id`,
    scratch,
  );
  await runWrangler(
    "reject-workspace-delete",
    d1Args(previousPersist, `DELETE FROM workspaces WHERE id = '${workspaceC}'`),
    scratch,
    "failure",
  );
  await runWrangler(
    "reject-workspace-identity-update",
    d1Args(
      previousPersist,
      `UPDATE workspaces SET id = '${workspaceE}' WHERE id = '${workspaceC}'`,
    ),
    scratch,
    "failure",
  );
  await runWrangler(
    "reject-workspace-replace-collision",
    d1Args(
      previousPersist,
      `INSERT OR REPLACE INTO workspaces
       (id, slug, jurisdiction, created_at, resource_version)
       VALUES ('${workspaceC}', 'workspace-d', 'eu', '2026-08-07T12:00:04Z', 2)`,
    ),
    scratch,
    "failure",
  );
  await runWrangler(
    "reject-workspace-update-replace-collision",
    d1Args(
      previousPersist,
      `UPDATE OR REPLACE workspaces
       SET slug = 'workspace-d', created_at = '2026-08-07T12:00:04Z', resource_version = 2
       WHERE id = '${workspaceC}'`,
    ),
    scratch,
    "failure",
  );
  assert.deepEqual(
    await query(
      "retained-workspace-jurisdiction",
      previousPersist,
      `SELECT id, slug, jurisdiction, resource_version
       FROM workspaces WHERE id IN ('${workspaceC}', '${workspaceD}', '${workspaceE}')
       ORDER BY id`,
      scratch,
    ),
    [
      { id: workspaceC, slug: "workspace-c", jurisdiction: "eu", resource_version: 1 },
      { id: workspaceD, slug: "workspace-d", jurisdiction: "eu", resource_version: 1 },
    ],
  );
  await runWrangler(
    "reject-cross-project-task-delegation",
    d1Args(
      previousPersist,
      `INSERT INTO oauth_delegations
       (workspace_id, id, human_id, client_id, resource, project_id, task_id,
        scopes_json, authorization_epoch, expires_at, created_at)
       VALUES ('${workspaceA}', '01JBFB0DELEGAT200000000000', '${human}', 'client',
               'https://bfb.example.test/mcp', '${projectB}', '${taskA}', '[]', 1,
               '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')`,
    ),
    scratch,
    "failure",
  );
  await query(
    "insert-workspace-b-delegation",
    previousPersist,
    `INSERT INTO oauth_delegations
     (workspace_id, id, human_id, client_id, resource, project_id, task_id,
      scopes_json, authorization_epoch, expires_at, created_at)
     VALUES ('${workspaceB}', '${delegationB}', '${human}', 'client',
             'https://bfb.example.test/mcp', NULL, NULL, '[]', 1,
             '2026-08-07T13:00:00Z', '2026-08-07T12:00:00Z')
     RETURNING id`,
    scratch,
  );
  await runWrangler(
    "reject-cross-workspace-task-attribution",
    d1Args(
      previousPersist,
      `INSERT INTO tasks
       (workspace_id, id, project_id, title, state, priority, next_owner_type,
        punchline, resource_version, created_by_delegation_id, created_at)
       VALUES ('${workspaceA}', '01JBFB0TASKB00000000000000', '${projectA}', 'Task B',
               'ready', 'P1', 'unassigned', 'Ready', 1, '${delegationB}',
               '2026-08-07T12:00:00Z')`,
    ),
    scratch,
    "failure",
  );
  await runWrangler(
    "reject-cross-workspace-comment-attribution",
    d1Args(
      previousPersist,
      `INSERT INTO comments
       (workspace_id, id, task_id, author_delegation_id, body, kind, created_at)
       VALUES ('${workspaceA}', '01JBFB0C0MMENT100000000000', '${taskA}', '${delegationB}',
               'Comment', 'discussion', '2026-08-07T12:00:00Z')`,
    ),
    scratch,
    "failure",
  );
  assert.equal(
    (
      await query(
        "no-verifier-state",
        previousPersist,
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'verification_%'",
        scratch,
      )
    )[0]?.count,
    0,
  );

  const interrupted = await buildInterruptedMigrationConfig(scratch);
  await applyMigrations(
    "interrupted-migrate",
    interruptedPersist,
    scratch,
    interrupted.configPath,
    "failure",
  );
  assert.deepEqual(
    (
      await query(
        "interrupted-head",
        interruptedPersist,
        "SELECT name FROM d1_migrations ORDER BY id",
        scratch,
      )
    ).map((row) => row.name),
    f04MigrationFiles.slice(0, -1),
  );
  assert.equal(
    (
      await query(
        "interrupted-side-effect",
        interruptedPersist,
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'f04_interruption_probe'",
        scratch,
      )
    )[0]?.count,
    0,
  );
  await writeFile(
    interrupted.migrationPath,
    await readFile(join(migrationDirectory, "0007_tenant_relationships.sql"), "utf8"),
    "utf8",
  );
  await applyMigrations("interrupted-retry", interruptedPersist, scratch, interrupted.configPath);
  assert.deepEqual(
    await schemaSnapshot("interrupted-schema", interruptedPersist, scratch),
    emptySchema,
  );
  assert.deepEqual(
    await query(
      "interrupted-foreign-key-check",
      interruptedPersist,
      "PRAGMA foreign_key_check",
      scratch,
    ),
    [],
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        migrationHead: migrationManifest.migration_head,
        emptyPreviousSchemaEqual: true,
        retainedPopulatedData: true,
        foreignKeys: "clean",
        jurisdictionImmutable: true,
        workspaceIdentityImmutable: true,
        workspaceReplaceCollisionRejected: true,
        workspaceUpdateReplaceCollisionRejected: true,
        workspaceRegistryDeleteRejected: true,
        crossTenantReferenceRejected: true,
        crossProjectTaskBoundaryRejected: true,
        crossWorkspaceAttributionRejected: true,
        interruptedMigrationRolledBackAndRetried: true,
        invalidLegacyRelationshipRejectedAndRecovered: true,
        malformedLegacyIdRejectedAndRecovered: true,
        deploymentAuthority: "wrangler_d1_migrations",
      },
      null,
      2,
    )}\nF04_D1_OK\n`,
  );
}

await main();
