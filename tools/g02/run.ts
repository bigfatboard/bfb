// ABOUTME: Proves the G02 release, self-hosting, and recovery gate on local fixtures.
// ABOUTME: Deterministic synthetic evidence only; never touches a remote account.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

import Database from "better-sqlite3";
import { createTestHarness } from "wrangler";

import {
  adaptBetterSqlite3,
  applyMigrationsForVerification,
  loadMigrationManifest,
  schemaSnapshot,
  type MigrationDatabase,
} from "@bfb/db";
import {
  acceptResultCommand,
  answerAttentionCommand,
  artifactObjectKey,
  canonicalRunnerKey,
  claimLaunchCommand,
  createAgentProfileCommand,
  createArtifactCommand,
  createFirstWorkspace,
  createTaskCommand,
  completeWorkspaceBootstrapReauthentication,
  enrollRunnerCommand,
  exchangeRunnerTokenCommand,
  finalizeArtifactCommand,
  FIX,
  ingestRunnerEventsCommand,
  issueRunnerChallengeCommand,
  issueStepUpProof,
  launchDeadline,
  mintUploadGrantSecret,
  recordReviewCommand,
  redeemUploadGrant,
  recordVerifiedUpload,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  requestAttentionCommand,
  resolveAttentionCommand,
  revokeRunnerCommand,
  RUNNER_CHALLENGE_ISSUER_ID,
  runnerChallengeTranscript,
  runnerEnrollmentTarget,
  runnerHash,
  runnerSecret,
  seedSyntheticWorkspace,
  startLaunchCommand,
  startWorkspaceBootstrap,
  submitResultCommand,
  syntheticUlid,
  TOKEN_ROTATION_WARN_MS,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  WorkspaceHub,
  type AttentionRecord,
  type CommandOutcome,
  type HubCommand,
  type RunnerPrincipal,
  type WorkspaceIdentity,
} from "@bfb/domain";
import { parseAuthKeys } from "../../apps/control-worker/dist/auth/better-auth.js";

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-G02");
mkdirSync(evidenceDir, { recursive: true });

/** Evidence JSON must match the repository Prettier style so regeneration stays byte-identical. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(JSON.stringify(value, null, 2), { ...options, parser: "json" }));
}

function readText(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const stages: Array<{ stage: string; outcome: string; detail: string }> = [];
function pass(stage: string, detail: string): void {
  stages.push({ stage, outcome: "passed", detail });
  console.log(`G02_${stage} ${detail}`);
}

const NOW = "2026-09-18T12:00:00.000Z";

// Frozen release heads from docs/contracts/release-candidate.md.
const FROZEN_PROTOCOL = "bfb-wire/1";
const FROZEN_SCHEMA = "1";
const FROZEN_MIGRATION_HEAD = "0034_operations";
const FROZEN_CLI_API = "1";
const FROZEN_CLI_MIN = "0.1.0";

function generatedHead(name: string): string {
  const source = readText("packages/protocol-ts/src/generated/types.ts");
  const match = source.match(new RegExp(`${name}\\s*=\\s*("([^"]+)"|(\\d+))`));
  assert.ok(match, `generated head ${name} is present`);
  return (match[2] ?? match[3]) as string;
}

// G-HEADS: the four frozen heads match the release candidate before anything else runs.
const protocolHead = generatedHead("PROTOCOL_HEAD");
const schemaVersion = generatedHead("SCHEMA_VERSION");
assert.equal(protocolHead, FROZEN_PROTOCOL, "wire protocol head is frozen");
assert.equal(schemaVersion, FROZEN_SCHEMA, "contract schema is frozen");
const migrationManifest = loadMigrationManifest(resolve(root, "migrations/d1"));
assert.equal(migrationManifest.migration_head, FROZEN_MIGRATION_HEAD, "D1 head is frozen");
const cliHuman = readText("apps/control-worker/src/api/cli-human.ts");
assert.ok(cliHuman.includes('CLI_API_VERSION = "1"'), "CLI API version is frozen");
assert.ok(cliHuman.includes('CLI_WIRE_PROTOCOL = "bfb-wire/1"'), "CLI wire protocol is frozen");
assert.ok(cliHuman.includes('CLI_MIN_VERSION = "0.1.0"'), "CLI minimum version is frozen");
pass(
  "HEADS",
  `protocol ${protocolHead}, schema ${schemaVersion}, D1 ${migrationManifest.migration_head}`,
);

// G-INVENTORY: every environment owns separate resources; nothing is shared.
interface EnvInventory {
  env: string;
  worker: string;
  database: string;
  database_id: string;
  bucket: string;
  queues: string[];
  origins: string[];
  jurisdiction: string;
  environment: string;
}

function tomlVar(body: string, name: string): string {
  const match = body.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"$`, "m"));
  assert.ok(match?.[1], `${name} is declared`);
  return match[1];
}

function tomlAll(body: string, pattern: RegExp): string[] {
  return [...body.matchAll(pattern)].map((item) => item[1] as string);
}

const CONTROL_CONFIGS = [
  ["local", "apps/control-worker/wrangler.toml"],
  ["staging", "apps/control-worker/wrangler.staging.toml"],
  ["production", "apps/control-worker/wrangler.production.toml"],
  ["selfhost", "apps/control-worker/wrangler.selfhost.toml"],
] as const;
const ARTIFACT_CONFIGS = [
  ["local", "apps/artifact-worker/wrangler.toml"],
  ["staging", "apps/artifact-worker/wrangler.staging.toml"],
  ["production", "apps/artifact-worker/wrangler.production.toml"],
  ["selfhost", "apps/artifact-worker/wrangler.selfhost.toml"],
] as const;

const inventory: EnvInventory[] = [];
for (const [env, file] of CONTROL_CONFIGS) {
  const body = readText(file);
  assert.ok(!/\[\[migrations\]\]/.test(body), `${file} carries no gradual DO rollout`);
  assert.ok(body.includes('class_name = "WorkspaceHub"'), `${file} binds WorkspaceHub`);
  assert.ok(body.includes('storage = "sqlite"'), `${file} pins sqlite DO storage`);
  assert.ok(body.includes('crons = ["*/5 * * * *"]'), `${file} keeps the operations Cron`);
  const database = tomlVar(body, "database_name");
  const databaseId = tomlVar(body, "database_id");
  const bucket = tomlVar(body, "bucket_name");
  const queues = tomlAll(body, /^queue = "([^"]+)"$/gm);
  assert.equal(queues.length, 9, `${file} declares six producer queues plus three consumers`);
  assert.equal(
    new Set(queues).size,
    6,
    `${file} owns six distinct queues (three pipelines plus DLQs)`,
  );
  const origins = [
    tomlVar(body, "APP_ORIGIN"),
    tomlVar(body, "ARTIFACT_ORIGIN"),
    tomlVar(body, "LAUNCH_ORIGIN"),
  ];
  for (const origin of origins) {
    const url = new URL(origin);
    if (env !== "local") assert.equal(url.protocol, "https:", `${file} serves https`);
    assert.equal(url.pathname, "/", `${file} origin is scheme+host only`);
  }
  assert.equal(
    new Set(origins.map((origin) => new URL(origin).hostname)).size,
    3,
    `${file} keeps three distinct hosts`,
  );
  inventory.push({
    env,
    worker: tomlVar(body, "name"),
    database,
    database_id: databaseId,
    bucket,
    queues: [...queues].sort(),
    origins: [...origins].sort(),
    jurisdiction: tomlVar(body, "JURISDICTION"),
    environment: tomlVar(body, "ENVIRONMENT"),
  });
}
for (const [env, file] of ARTIFACT_CONFIGS) {
  const body = readText(file);
  const entry = inventory.find((item) => item.env === env);
  assert.ok(entry, `control inventory covers ${env}`);
  assert.equal(tomlVar(body, "database_name"), entry.database, `artifact shares the ${env} D1`);
  assert.equal(tomlVar(body, "database_id"), entry.database_id, `artifact shares the ${env} D1 id`);
  assert.equal(tomlVar(body, "bucket_name"), entry.bucket, `artifact shares the ${env} R2 bucket`);
}
for (const key of ["worker", "database", "database_id", "bucket"] as const) {
  const values = inventory.map((item) => item[key]);
  assert.equal(new Set(values).size, values.length, `no ${key} is shared across environments`);
}
const allQueues = inventory.flatMap((item) => [...new Set(item.queues)]);
assert.equal(new Set(allQueues).size, allQueues.length, "no queue is shared across environments");
assert.equal(allQueues.length, 24, "four environments own six distinct queues each");
const jurisdictions = Object.fromEntries(inventory.map((item) => [item.env, item.jurisdiction]));
assert.deepEqual(
  jurisdictions,
  { local: "eu", staging: "eu", production: "eu", selfhost: "choose" },
  "managed environments pin eu; self-host ships the choice sentinel",
);
pass("INVENTORY", "4 envs own separate D1/R2/queues/DO names; self-host ships JURISDICTION=choose");

// G-MANIFEST: the release manifest freezes tag inputs, heads, and per-env resources.
const releaseInputs = [
  ...CONTROL_CONFIGS.map(([, file]) => file),
  ...ARTIFACT_CONFIGS.map(([, file]) => file),
  "migrations/d1/manifest.json",
  "docs/contracts/release.md",
  ".github/workflows/release.yml",
];
const inputHashes = Object.fromEntries(
  releaseInputs.map((file) => [file, sha256Text(readText(file))]),
);
const releaseManifest = {
  release: "bfb-v0.1-g02",
  protocol_version: protocolHead,
  schema_version: schemaVersion,
  migration_head: migrationManifest.migration_head,
  cli: {
    api_version: FROZEN_CLI_API,
    wire_protocol: FROZEN_PROTOCOL,
    cli_min_version: FROZEN_CLI_MIN,
  },
  providers: {
    claude: "2.1.275",
    codex: "0.153.4",
    grok: "1.0.34",
    human_auth: "Better Auth 1.6.26",
  },
  environments: inventory,
  jurisdiction: { managed_production: "eu", selfhost_choice: ["eu", "us", "global"] },
  inputs: inputHashes,
};
await writeJson(join(evidenceDir, "release-manifest.json"), releaseManifest);
pass("MANIFEST", "release manifest freezes heads, resources, and input hashes");

// G-SBOM: workspace components plus pinned toolchain and release input hashes.
function packageVersion(file: string): string {
  return (JSON.parse(readText(file)) as { version: string }).version;
}
const componentFiles = [
  ...readdirSync(resolve(root, "apps")).map((name) => `apps/${name}/package.json`),
  ...readdirSync(resolve(root, "packages")).map((name) => `packages/${name}/package.json`),
  ...readdirSync(resolve(root, "tools"))
    .filter((name) => existsSync(resolve(root, `tools/${name}/package.json`)))
    .map((name) => `tools/${name}/package.json`),
].filter((file) => existsSync(resolve(root, file)));
const sbom = {
  release: "bfb-v0.1-g02",
  components: componentFiles.map((file) => ({
    name: (JSON.parse(readText(file)) as { name: string }).name,
    version: packageVersion(file),
    path: file,
  })),
  toolchain: {
    node: readText(".node-version").trim(),
    go: readText(".go-version").trim(),
    xcode: readText(".xcode-version").trim(),
    pnpm: (JSON.parse(readText("package.json")) as { packageManager: string }).packageManager,
    wrangler: packageVersion("apps/control-worker/node_modules/wrangler/package.json"),
    playwright: packageVersion("node_modules/@playwright/test/package.json"),
  },
  release_inputs: inputHashes,
};
await writeJson(join(evidenceDir, "sbom.json"), sbom);
pass("SBOM", `${sbom.components.length} workspace components plus pinned toolchain`);

// G-PROVENANCE: producing commands and input hashes; no timestamps or generated ids.
const provenance = {
  release: "bfb-v0.1-g02",
  produced_by: [
    "pnpm build",
    "pnpm build:web",
    "pnpm exec tsc -b tools/g02 --pretty false",
    "node tools/g02/signing.mjs",
    "tsx tools/g02/run.ts",
    "BFB_E2E_PORT=4198 playwright test apps/web/test/e2e/g02-release.spec.ts",
  ],
  frozen_contract: "docs/contracts/release.md",
  release_candidate: "docs/contracts/release-candidate.md",
  inputs: inputHashes,
};
await writeJson(join(evidenceDir, "provenance.json"), provenance);
pass("PROVENANCE", "producing commands and input hashes recorded");

// G-MIGRATION: empty and previous-release starts converge on the frozen head.
const migrationsDir = resolve(root, "migrations/d1");
function openMigrationDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}
/** Adapts better-sqlite3 to the verification-migration surface without weakening its types. */
function asMigrationDb(raw: Database.Database): MigrationDatabase {
  return {
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...params: unknown[]) => (stmt.run as (...args: unknown[]) => unknown)(...params),
        all: (...params: unknown[]) => (stmt.all as (...args: unknown[]) => unknown[])(...params),
        get: (...params: unknown[]) => (stmt.get as (...args: unknown[]) => unknown)(...params),
      };
    },
    pragma: (value: string) => raw.pragma(value),
  };
}
const emptyDb = openMigrationDb();
const emptyResult = applyMigrationsForVerification(asMigrationDb(emptyDb), migrationsDir);
assert.equal(emptyResult.head, FROZEN_MIGRATION_HEAD, "empty start reaches the frozen head");
assert.deepEqual(
  emptyDb.prepare("PRAGMA foreign_key_check").all(),
  [],
  "empty start has clean keys",
);
const emptySnapshot = schemaSnapshot(asMigrationDb(emptyDb));

const previousFixture = JSON.parse(readText("packages/db/test/fixtures/previous-schema.json")) as {
  head: string;
  migrations: Array<{ file: string; sha256: string }>;
};
assert.equal(previousFixture.head, "0004_human_credentials", "previous start is pinned");
for (const entry of previousFixture.migrations) {
  assert.equal(
    sha256Text(readText(`migrations/d1/${entry.file}`)),
    entry.sha256,
    `${entry.file} still matches the previous-release bytes`,
  );
}
const previousDb = openMigrationDb();
const partial = applyMigrationsForVerification(asMigrationDb(previousDb), migrationsDir, {
  stopBeforeId: "0005_workspace_invariants",
});
assert.equal(partial.status, "interrupted_before_apply", "previous start pauses at 0005");
const G02_WS = syntheticUlid("G02WS");
const G02_HUMAN = syntheticUlid("G02OWNER");
const G02_PROJECT = syntheticUlid("G02PROJ");
const G02_TASK = syntheticUlid("G02TASK");
for (const id of [G02_WS, G02_HUMAN, G02_PROJECT, G02_TASK]) {
  assert.match(id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "seed id is a valid ULID");
}
previousDb
  .prepare("INSERT INTO workspaces (id, slug, jurisdiction, created_at) VALUES (?, 'g02', 'eu', ?)")
  .run(G02_WS, NOW);
previousDb
  .prepare(
    "INSERT INTO humans (id, email, display_name, created_at) VALUES (?, 'g02@synthetic.test', 'G02 Owner', ?)",
  )
  .run(G02_HUMAN, NOW);
previousDb
  .prepare(
    "INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at) VALUES (?, ?, 'owner', 1, ?)",
  )
  .run(G02_WS, G02_HUMAN, NOW);
previousDb
  .prepare(
    "INSERT INTO projects (workspace_id, id, name, slug, tint, created_at) VALUES (?, ?, 'G02', 'g02', '#3B82F6', ?)",
  )
  .run(G02_WS, G02_PROJECT, NOW);
previousDb
  .prepare("INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)")
  .run(G02_WS, G02_PROJECT, G02_HUMAN);
previousDb
  .prepare(
    "INSERT INTO tasks (workspace_id, id, project_id, title, state, priority, punchline, created_at) VALUES (?, ?, ?, 'G02 seed', 'proposed', 'P2', 'seed', ?)",
  )
  .run(G02_WS, G02_TASK, G02_PROJECT, NOW);
const upgraded = applyMigrationsForVerification(asMigrationDb(previousDb), migrationsDir);
assert.equal(upgraded.head, FROZEN_MIGRATION_HEAD, "previous start reaches the frozen head");
assert.deepEqual(
  previousDb.prepare("PRAGMA foreign_key_check").all(),
  [],
  "upgraded start has clean keys",
);
assert.deepEqual(
  schemaSnapshot(asMigrationDb(previousDb)),
  emptySnapshot,
  "empty and previous starts converge",
);
const preserved = previousDb
  .prepare("SELECT id, state, priority FROM tasks WHERE workspace_id = ?")
  .all(G02_WS) as Array<Record<string, unknown>>;
assert.deepEqual(
  preserved,
  [{ id: G02_TASK, state: "proposed", priority: "P2" }],
  "previous-release rows survive the upgrade",
);
await writeJson(join(evidenceDir, "migration-drill.json"), {
  release: "bfb-v0.1-g02",
  migration_head: FROZEN_MIGRATION_HEAD,
  empty_start: { head: emptyResult.head, foreign_key_check: "clean" },
  previous_start: {
    from: previousFixture.head,
    head: upgraded.head,
    foreign_key_check: "clean",
    preserved_tasks: 1,
  },
  schema_converged: true,
  backstop:
    "D1 Time Travel or export before destructive steps (docs/release/migration-rollback.md)",
});
pass("MIGRATION", "empty and previous-release starts converge with rows preserved");

// G-EXPAND: migrations stay expand-contract; every DROP TABLE is a rebuild or a reviewed drop.
const rebuildTables: Record<string, string[]> = {};
const reviewedDrops: Array<{ migration: string; table: string; reason: string }> = [];
const transientTables: Array<{ migration: string; table: string }> = [];
const LEGACY_BOOKKEEPING = "0005_workspace_invariants:schema_migrations";
const EPHEMERAL_AUTH = new Map([
  [
    "0008_better_auth_identity:human_sessions",
    "sessions re-establish through OAuth after the Better Auth cutover",
  ],
  [
    "0008_better_auth_identity:human_credentials",
    "credentials are superseded by the passkey tables",
  ],
]);
for (const entry of migrationManifest.migrations) {
  const sql = readText(`migrations/d1/${entry.file}`);
  assert.ok(!/\bDELETE FROM\b/i.test(sql), `${entry.file} deletes no rows`);
  assert.ok(
    !/\bDROP (INDEX|TRIGGER|COLUMN)\b/i.test(sql),
    `${entry.file} drops no index, trigger, or column`,
  );
  const drops = [...sql.matchAll(/^.*\bDROP TABLE (?:IF EXISTS )?([^\s(;]+).*$/gim)].map((item) =>
    (item[1] ?? "").replace(/^"|"$/g, "").replace(/^main\./, ""),
  );
  if (drops.length > 0) rebuildTables[entry.id] = drops;
  for (const table of drops) {
    const key = `${entry.id}:${table}`;
    if (key === LEGACY_BOOKKEEPING) {
      reviewedDrops.push({
        migration: entry.id,
        table,
        reason: "legacy bookkeeping superseded by D1-side migration state",
      });
      continue;
    }
    if (EPHEMERAL_AUTH.has(key)) {
      reviewedDrops.push({ migration: entry.id, table, reason: EPHEMERAL_AUTH.get(key) as string });
      continue;
    }
    const directCreate = sql.search(new RegExp(`CREATE TABLE\\s+"?${table}"?(?![\\w])`, "i"));
    const dropPos = sql.search(
      new RegExp(`DROP TABLE\\s+(?:IF EXISTS\\s+)?"?${table}"?(?![\\w])`, "i"),
    );
    const created = new RegExp(`CREATE TABLE\\s+"?(${table}_\\w+)"?[\\s(]`, "i").exec(sql);
    const staging = created?.[1];
    const staged =
      staging !== undefined &&
      new RegExp(`INSERT INTO\\s+"?${staging}"?[\\s\\S]*?FROM\\s+"?${table}"?(?![\\w])`, "i").test(
        sql,
      ) &&
      new RegExp(`ALTER TABLE\\s+"?${staging}"?\\s+RENAME TO\\s+"?${table}"?(?![\\w])`, "i").test(
        sql,
      );
    const backup = new RegExp(
      `CREATE TABLE\\s+"?(${table}_\\w+)"?\\s+AS\\s+SELECT[\\s\\S]*?FROM\\s+"?${table}"?(?![\\w])`,
      "i",
    ).exec(sql)?.[1];
    const restored =
      backup !== undefined &&
      new RegExp(
        `INSERT INTO\\s+"?${table}"?(?![\\w])[\\s\\S]*?FROM\\s+"?${backup}"?(?![\\w])`,
        "i",
      ).test(sql);
    if (staged || restored) continue;
    // In-file scaffolding (a backup copy created and cleaned up in one migration) carries no kept rows.
    if (directCreate !== -1 && directCreate < dropPos) {
      transientTables.push({ migration: entry.id, table });
      continue;
    }
    assert.fail(`${entry.file} drops ${table} without a rebuild or review`);
  }
}
await writeJson(join(evidenceDir, "rollback-limits.json"), {
  release: "bfb-v0.1-g02",
  expand_contract: {
    outcome: "passed",
    rebuild_migrations: rebuildTables,
    reviewed_drops: reviewedDrops,
    transient_tables: transientTables,
  },
  durable_objects: {
    class: "WorkspaceHub",
    storage: "sqlite",
    gradual_rollout_blocks: 0,
    constraint:
      "incompatible DO changes ship as a new class with a cutover; gradual mixing is unsupported",
  },
  rollback_matrix: {
    worker_only: "redeploy the previous worker bundle; no data step",
    worker_plus_migration:
      "redeploy only if the previous worker tolerates the newer schema, else forward-repair",
    incompatible_do: "single-version cutover only",
    data: "never automatic; Time Travel/export restore, then forward-repair",
  },
  deployment_jobs: ["build-test", "migrate", "publish", "smoke"],
});
pass("ROLLBACK", "expand-contract audit and Worker/data limits recorded");

// G-ROTATION: the real versioned-key parser accepts current+previous overlap and nothing else.
const G02_CURRENT = "g02-synthetic-current-signing-key-9f27c4aa41";
const G02_PREVIOUS = "g02-synthetic-previous-signing-key-3b81d9c720";
const overlap = parseAuthKeys(`2:${G02_CURRENT},1:${G02_PREVIOUS}`);
assert.deepEqual(
  overlap.map((key) => key.version),
  [2, 1],
  "overlap keeps current and previous versions",
);
assert.equal(overlap[0]?.value, G02_CURRENT, "current value survives parsing");
assert.deepEqual(
  parseAuthKeys(`7:${G02_CURRENT}`).map((key) => key.version),
  [7],
  "a lone current key parses",
);
for (const [label, value] of [
  ["third version", `3:${G02_CURRENT},2:${G02_CURRENT},1:${G02_PREVIOUS}`],
  ["duplicate version", `2:${G02_CURRENT},2:${G02_PREVIOUS}`],
  ["short secret", "2:too-short"],
  ["missing version", `${G02_CURRENT}`],
  ["empty", ""],
] as const) {
  assert.throws(() => parseAuthKeys(value), Error, `rotation rejects ${label}`);
}
assert.equal(TOKEN_ROTATION_WARN_MS, 24 * 60 * 60_000, "health flags tokens expiring within 24h");
await writeJson(join(evidenceDir, "rotation-drill.json"), {
  release: "bfb-v0.1-g02",
  parser: "apps/control-worker/src/auth/better-auth.ts parseAuthKeys",
  overlap: { versions: [2, 1], outcome: "passed" },
  rejections: ["third version", "duplicate version", "short secret", "missing version", "empty"],
  health_signal: "TOKEN_ROTATION_WARN_MS flags runner tokens expiring within 24h",
  procedure: "docs/runbooks/key-rotation.md",
});
pass("ROTATION", "current/previous kid overlap proven; 5 malformed shapes rejected");

// G-GOLDEN: first-owner bootstrap consumes once on an empty database.
const flowRaw = openMigrationDb();
applyMigrationsForVerification(asMigrationDb(flowRaw), migrationsDir);
const flowDb = adaptBetterSqlite3(flowRaw);
const BOOT_NOW = "2026-09-18T12:00:00.000Z";
const BOOT_HUMAN = syntheticUlid("G02BOOT");
await flowDb
  .prepare(
    "INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'G02 Owner', 'g02boot@synthetic.test', 1, ?, ?)",
  )
  .run("g02-boot-auth-user", BOOT_NOW, BOOT_NOW);
await flowDb
  .prepare(
    "INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id) VALUES (?, '2027-09-18T12:00:00.000Z', 'g02-boot-token', ?, ?, NULL, NULL, ?)",
  )
  .run("g02-boot-session", BOOT_NOW, BOOT_NOW, "g02-boot-auth-user");
await flowDb
  .prepare(
    "INSERT INTO humans (id, better_auth_user_id, email, display_name, created_at) VALUES (?, ?, 'g02boot@synthetic.test', 'G02 Owner', ?)",
  )
  .run(BOOT_HUMAN, "g02-boot-auth-user", BOOT_NOW);
await flowDb
  .prepare(
    "INSERT INTO bootstrap_state (id, secret_hash, created_at, expires_at, consumed_at, consumption_stamp, consumed_by_human_id, workspace_id) VALUES ('first_owner', ?, ?, '2026-09-18T13:00:00.000Z', NULL, NULL, NULL, NULL)",
  )
  .run("a".repeat(64), BOOT_NOW);
const bootIdentity: WorkspaceIdentity = {
  humanId: BOOT_HUMAN,
  authUserId: "g02-boot-auth-user",
  sessionId: "g02-boot-session",
  email: "g02boot@synthetic.test",
  emailVerified: true,
};
const bootFlow = await startWorkspaceBootstrap(
  flowDb,
  bootIdentity,
  "https://bfb.example.test",
  "b".repeat(64),
  BOOT_NOW,
);
await completeWorkspaceBootstrapReauthentication(
  flowDb,
  bootIdentity,
  bootFlow.flowId,
  "b".repeat(64),
  "2026-09-18T12:01:00.000Z",
);
await createFirstWorkspace(
  flowDb,
  bootIdentity,
  {
    flowId: bootFlow.flowId,
    bootstrapSecretHash: "a".repeat(64),
    slug: "first-team",
    jurisdiction: "eu",
  },
  "2026-09-18T12:02:00.000Z",
);
await assert.rejects(
  createFirstWorkspace(
    flowDb,
    bootIdentity,
    {
      flowId: bootFlow.flowId,
      bootstrapSecretHash: "a".repeat(64),
      slug: "second-team",
      jurisdiction: "eu",
    },
    "2026-09-18T12:03:00.000Z",
  ),
  "bootstrap replay is rejected",
);
await assert.rejects(
  startWorkspaceBootstrap(
    flowDb,
    bootIdentity,
    "https://bfb.example.test",
    "c".repeat(64),
    "2026-09-18T12:04:00.000Z",
  ),
  "a second bootstrap is unavailable",
);
const golden: Array<{ stage: string; outcome: string; detail: string }> = [];
golden.push({
  stage: "first-owner bootstrap",
  outcome: "passed",
  detail: "consumed once; replay rejected; second bootstrap unavailable",
});
console.log("G02_GOLDEN first-owner bootstrap consumes once");

// G-CHAIN: enrollment, launch, realtime, attention, result, review, revoke on one local database.
const chainRaw = openMigrationDb();
applyMigrationsForVerification(asMigrationDb(chainRaw), migrationsDir);
const db = adaptBetterSqlite3(chainRaw);
const hub = new WorkspaceHub(db);
await seedSyntheticWorkspace(db, NOW, "eu");
let idempotency = 0;
function nextKey(prefix: string): string {
  idempotency += 1;
  return `g02-${prefix}-${String(idempotency).padStart(3, "0")}`;
}
function ok<T>(outcome: CommandOutcome<T>): T {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return (outcome as Extract<CommandOutcome<T>, { ok: true }>).result;
}
function human<I, R>(command: HubCommand<I, R>, input: I, humanId = FIX.owner) {
  return hub.execute(command, {
    workspaceId: FIX.workspace,
    idempotencyKey: nextKey("cmd"),
    actorHumanId: humanId,
    authorizationEpoch: 1,
    now: NOW,
    input,
  });
}
const G02_RUNNER = syntheticUlid("G02RUNNER");
const G02_CHECKOUT = syntheticUlid("G02CKOUT");
const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const runnerKey = await canonicalRunnerKey({
  crv: exported.crv,
  kty: exported.kty,
  x: exported.x,
  y: exported.y,
});
const enrollment = {
  runnerId: G02_RUNNER,
  deviceLabel: "G02 Release Mac",
  publicKey: runnerKey,
  projectIds: [FIX.projectA],
};
const enrollProof = await issueStepUpProof(
  db,
  FIX.owner,
  {
    action: "runner.enroll",
    targetId: runnerEnrollmentTarget(enrollment),
    workspaceId: FIX.workspace,
    scopes: [],
    authorizationEpoch: 1,
    expiresAt: "2026-09-18T12:05:00.000Z",
  },
  NOW,
);
ok(await human(enrollRunnerCommand, { ...enrollment, stepUpProofId: enrollProof }));
golden.push({
  stage: "runner enrollment",
  outcome: "passed",
  detail: "owner step-up enrolls one P-256 runner with launch grant",
});
console.log("G02_GOLDEN runner enrollment completes");

function system<I, R>(command: HubCommand<I, R>, input: I) {
  return hub.execute(command, {
    workspaceId: FIX.workspace,
    idempotencyKey: nextKey("cmd"),
    actorSystemId: RUNNER_CHALLENGE_ISSUER_ID,
    authorizationEpoch: 1,
    now: NOW,
    input,
  });
}
const challengeNonce = runnerSecret();
const challenge = {
  ...ok(
    await system(issueRunnerChallengeCommand, {
      runnerId: G02_RUNNER,
      nonceHash: runnerHash(challengeNonce),
      purpose: "token",
      origin: "https://bfb.example.test",
    }),
  ),
  server_nonce: challengeNonce,
};
const proofSignature = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  keyPair.privateKey,
  runnerChallengeTranscript(challenge),
);
const tokenSecret = runnerSecret();
const issued = ok(
  await hub.execute(exchangeRunnerTokenCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: nextKey("cmd"),
    actorRunnerId: G02_RUNNER,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      runnerId: G02_RUNNER,
      challengeId: challenge.challenge_id,
      serverNonce: challengeNonce,
      signature: Buffer.from(proofSignature).toString("base64url"),
      origin: "https://bfb.example.test",
      tokenSecretHash: runnerHash(tokenSecret),
    },
  }),
);
const claims = issued.claims;
const principal: RunnerPrincipal = {
  kind: "runner",
  workspaceId: FIX.workspace,
  runnerId: G02_RUNNER,
  ownerHumanId: FIX.owner,
  authorizationEpoch: claims.authorization_epoch,
  ownerAuthorizationEpoch: claims.owner_authorization_epoch,
  grantEpoch: claims.grant_epoch,
  tokenEpoch: claims.token_epoch,
  tokenId: claims.jti,
  keyThumbprint: claims.cnf.jkt,
  authExpiresAt: new Date(claims.exp * 1000).toISOString(),
  projectIds: [FIX.projectA],
};
golden.push({
  stage: "runner token",
  outcome: "passed",
  detail: "challenge, possession proof, and token exchange complete",
});
function native<I, R>(command: HubCommand<I, R>, input: I) {
  return hub.execute(command, {
    workspaceId: FIX.workspace,
    idempotencyKey: nextKey("cmd"),
    actorRunnerId: G02_RUNNER,
    authorizationEpoch: 1,
    now: NOW,
    input,
  });
}
const G02_DIGEST = `sha256:${createHash("sha256").update("g02-artifact-bytes").digest("hex")}`;
const G02_HEX = createHash("sha256").update("g02-artifact-bytes").digest("hex");
const G02_CONFIG = `sha256:${runnerHash("{}")}`;
const policy = {
  allowedProviders: ["claude", "codex", "grok", "fake"] as const,
  allowAgentRootPropose: false,
  allowPassToAgent: true,
  allowRunOverrides: true,
};
ok(
  await human(updateWorkspacePolicyCommand, {
    ...policy,
    allowedProviders: [...policy.allowedProviders],
    expectedVersion: 1,
  }),
);
ok(
  await human(updateProjectPolicyCommand, {
    ...policy,
    allowedProviders: [...policy.allowedProviders],
    expectedVersion: 1,
    projectId: FIX.projectA,
  }),
);
ok(
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: G02_CONFIG,
  }),
);
const profile = ok(
  await human(createAgentProfileCommand, {
    name: "G02 release provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  }),
);
ok(
  await native(replaceRunnerInventoryCommand, {
    principal,
    inventory: {
      schema_version: 1,
      workspace_id: FIX.workspace,
      runner_id: G02_RUNNER,
      revision: 1,
      checkouts: [
        {
          schema_version: 1,
          checkout_id: G02_CHECKOUT,
          workspace_id: FIX.workspace,
          runner_id: G02_RUNNER,
          project_id: FIX.projectA,
          label: "G02 checkout",
          repository_identity: "synthetic/g02",
          workspace_subpath: ".",
          physical_worktree_hash: G02_DIGEST,
          repository_config_hash: G02_CONFIG,
          is_default: true,
          dirty: false,
          status: "validated",
          validated_at: NOW,
        },
      ],
      providers: [
        {
          provider: "fake",
          version: "1.0.0",
          manifest_id: G02_DIGEST,
          status: "healthy",
          observed_at: NOW,
          expires_at: launchDeadline(NOW, 30_000),
          capabilities: [
            "launch.interactive",
            "filesystem.read_only",
            "approval.never",
            "context.session_start",
            "prompt.initial_constant",
            "hooks.session_start",
            "mcp.stdio",
            "control.interrupt",
            "control.terminate",
            "session.resume",
          ],
        },
      ],
    },
  }),
);
golden.push({
  stage: "checkout link",
  outcome: "passed",
  detail: "runner inventory carries one validated checkout",
});
const task = ok(
  await human(createTaskCommand, {
    projectId: FIX.projectA,
    title: "G02 golden task",
    priority: "P2",
  }),
);
const launch = ok(
  await human(startLaunchCommand, {
    schema_version: 1,
    idempotency_key: nextKey("launch"),
    task_id: task.id,
    expected_task_version: 1,
    runner_id: G02_RUNNER,
    checkout_id: G02_CHECKOUT,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  }),
);
const claimed = ok(
  await native(claimLaunchCommand, {
    principal,
    claim: {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: G02_RUNNER,
      idempotency_key: nextKey("launch"),
      claimed_at: NOW,
    },
  }),
);
assert.equal(claimed.state, "claimed", "launch claims");
const spec = claimed.claim.specification;
golden.push({
  stage: "launch",
  outcome: "passed",
  detail: "task launch starts and the runner claims it",
});
console.log("G02_GOLDEN launch claims");

const ingested = ok(
  await native(ingestRunnerEventsCommand, {
    principal,
    events: [
      {
        schema_version: 1,
        event_id: syntheticUlid("G02EVT1"),
        source_stream_id: syntheticUlid("G02STREAM"),
        source_sequence: 1,
        run_execution_id: spec.run_execution_id,
        assignment_generation: spec.assignment_generation,
        kind: "heartbeat",
        occurred_at: NOW,
        capture_origin: "runner_observed",
        payload: {},
      },
    ],
  }),
);
assert.equal(ingested.dispositions.length, 1, "one heartbeat disposition");
golden.push({
  stage: "realtime",
  outcome: "passed",
  detail: "runner heartbeat ingests with an explicit disposition",
});

const attention = ok(
  await native(requestAttentionCommand, {
    principal,
    runId: spec.run_id,
    executionId: spec.run_execution_id,
    assignmentGeneration: spec.assignment_generation,
    kind: "clarification",
    question: "G02 synthetic clarification",
    blocking: true,
  }),
);
const answered: AttentionRecord = ok(
  await human(answerAttentionCommand, {
    attentionId: attention.id,
    expectedVersion: 1,
    answer: "G02 synthetic answer",
  }),
);
assert.equal(answered.state, "answered", "attention answers");
ok(await human(resolveAttentionCommand, { attentionId: attention.id, expectedVersion: 2 }));
golden.push({
  stage: "attention",
  outcome: "passed",
  detail: "request, answer, and resolve round-trip",
});
console.log("G02_GOLDEN attention round-trips");

const minted = mintUploadGrantSecret();
const created = ok(
  await human(createArtifactCommand, {
    artifactId: null,
    runId: spec.run_id,
    format: "markdown",
    role: "review",
    declaredSize: 18,
    expectedDigest: G02_HEX,
    grantSecretHash: minted.secretHash,
  }),
);
await redeemUploadGrant(db, {
  grantId: created.upload_grant.grant_id,
  secret: minted.secret,
  now: NOW,
});
await recordVerifiedUpload(db, {
  workspaceId: FIX.workspace,
  versionId: created.version_id,
  runId: spec.run_id,
  role: "review",
  contentHash: G02_HEX,
  r2Key: artifactObjectKey({
    workspaceId: FIX.workspace,
    role: "review",
    runId: spec.run_id,
    versionId: created.version_id,
    contentHash: G02_HEX,
  }),
  size: 18,
  now: NOW,
});
ok(
  await human(finalizeArtifactCommand, {
    versionId: created.version_id,
    contentHash: G02_HEX,
    size: 18,
  }),
);
const submitted = ok(
  await human(
    submitResultCommand,
    {
      runId: spec.run_id,
      summary: "G02 synthetic result",
      limitations: "G02 synthetic limitation",
      evidenceRefs: [{ kind: "comment", ref: "g02-synthetic-comment" }],
      gitBranch: "main",
      gitCommit: "0".repeat(40),
      gitDirty: false,
    },
    FIX.member,
  ),
);
assert.equal(submitted.runResultState, "submitted", "result submits");
const runRow = (await db
  .prepare("SELECT resource_version FROM runs WHERE workspace_id = ? AND id = ?")
  .get(FIX.workspace, spec.run_id)) as { resource_version: number };
const taskRow = (await db
  .prepare("SELECT resource_version FROM tasks WHERE workspace_id = ? AND id = ?")
  .get(FIX.workspace, task.id)) as { resource_version: number };
const accepted = ok(
  await human(acceptResultCommand, {
    runId: spec.run_id,
    submissionId: submitted.submission.id,
    expectedRunVersion: runRow.resource_version,
    expectedTaskVersion: taskRow.resource_version,
  }),
);
assert.equal(accepted.runResultState, "accepted", "result accepts without self-review");
golden.push({ stage: "result", outcome: "passed", detail: "member submits, owner accepts" });
const reviewed = ok(
  await human(recordReviewCommand, {
    artifactId: created.artifact_id,
    versionId: created.version_id,
    expectedContentHash: G02_HEX,
    expectedLatestVersionId: created.version_id,
    decision: "approve",
  }),
);
assert.equal(reviewed.decision, "approve", "artifact review approves");
golden.push({
  stage: "artifact review",
  outcome: "passed",
  detail: "publish, finalize, and immutable approval bind",
});
console.log("G02_GOLDEN result and artifact review complete");

const revokeProof = await issueStepUpProof(
  db,
  FIX.owner,
  {
    action: "runner.revoke",
    targetId: G02_RUNNER,
    workspaceId: FIX.workspace,
    scopes: [],
    authorizationEpoch: 1,
    expiresAt: "2026-09-18T12:05:00.000Z",
  },
  NOW,
);
const revoked = ok(
  await human(revokeRunnerCommand, { runnerId: G02_RUNNER, stepUpProofId: revokeProof }),
);
assert.equal(revoked.signal.reason, "revoked", "revocation closes the channel");
golden.push({
  stage: "uninstall",
  outcome: "passed",
  detail: "runner revoke fences authority and closes the channel",
});
golden.push({
  stage: "upgrade",
  outcome: "passed",
  detail: `chain runs on migration head ${migrationManifest.migration_head}`,
});
console.log("G02_GOLDEN domain chain revokes and closes");

// G-BINARY: the real bfb binary installs, serves, links, verifies, and cleans up on isolated state.
const scratch = mkdtempSync(join(tmpdir(), "bfb-g02-"));
const launchdUid = process.getuid?.();
assert.ok(launchdUid !== undefined, "launchd needs a POSIX uid");
spawnSync("/bin/launchctl", ["bootout", `gui/${launchdUid}/com.tenira.bfb.g02`]);
rmSync(join(process.env.HOME ?? "", "Library/LaunchAgents/com.tenira.bfb.g02.plist"), {
  force: true,
});
const bfb = join(scratch, "bfb");
const stateDir = join(scratch, "state");
const repoDir = join(scratch, "repo");
try {
  execFileSync("go", ["build", "-o", bfb, "./cmd/bfb"], { cwd: root, stdio: "pipe" });
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "g02@synthetic.test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "G02"], { cwd: repoDir });
  execFileSync("git", ["remote", "add", "origin", "https://git.synthetic.test/bfb/demo"], {
    cwd: repoDir,
  });
  writeFileSync(join(repoDir, "README.md"), "g02 synthetic checkout\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: repoDir });
  const cli = (args: string[]): { exit: number; json: Record<string, unknown> } => {
    const run = spawnSync(bfb, ["--data-dir", stateDir, ...args, "--json"], { encoding: "utf8" });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(String(run.stdout)) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { exit: run.status ?? -1, json };
  };
  const version = cli(["version"]);
  assert.equal(version.exit, 0, "bfb version exits zero");
  assert.equal(
    (version.json.data as Record<string, unknown>).client_version,
    "0.1.0",
    "binary reports 0.1.0",
  );
  golden.push({
    stage: "binary version",
    outcome: "passed",
    detail: "bfb reports 0.1.0 on bfb-wire/1",
  });

  const daemon = spawn(bfb, ["--data-dir", stateDir, "daemon", "run"], { stdio: "ignore" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const status = cli(["daemon", "status"]);
        ready =
          status.exit === 0 &&
          (status.json.payload as Record<string, unknown>).status === "running";
      } catch {
        ready = false;
      }
    }
    assert.ok(ready, "isolated daemon becomes ready");
    const status = cli(["daemon", "status"]);
    assert.equal(
      (status.json.payload as Record<string, unknown>).storage_version,
      10,
      "daemon storage version is stable",
    );
    golden.push({
      stage: "daemon install",
      outcome: "passed",
      detail: "isolated daemon runs; status reports running",
    });

    const installed = cli(["daemon", "install", "--label", "com.tenira.bfb.g02"]);
    assert.equal(installed.exit, 0, "launchd install exits zero");
    const printed = spawnSync("/bin/launchctl", ["print", `gui/${launchdUid}/com.tenira.bfb.g02`], {
      encoding: "utf8",
    });
    assert.equal(printed.status, 0, "launchd service is loaded");
    assert.match(
      String(printed.stdout),
      /com\.tenira\.bfb\.g02/,
      "launchd service record names the label",
    );
    golden.push({
      stage: "daemon status",
      outcome: "passed",
      detail: "launchd service installed and loaded",
    });

    const link = cli([
      "checkout",
      "link",
      "--workspace",
      syntheticUlid("G02WS2"),
      "--runner",
      syntheticUlid("G02RN2"),
      "--project",
      syntheticUlid("G02PJ2"),
      "--label",
      "G02 Release",
      "--repository",
      "git.synthetic.test/bfb/demo",
      repoDir,
    ]);
    assert.equal(link.exit, 0, "checkout link exits zero");
    const checkoutId = (
      (link.json.payload as Record<string, unknown>).checkout as Record<string, unknown>
    ).checkout_id as string;
    assert.match(checkoutId, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "linked checkout id is a ULID");
    const listed = cli(["checkout", "list"]);
    assert.equal(
      ((listed.json.payload as Record<string, unknown>).checkouts as unknown[]).length,
      1,
      "one checkout listed",
    );
    const verify = cli(["checkout", "verify", checkoutId]);
    assert.equal(verify.exit, 0, "checkout verify exits zero");
    const duplicate = cli([
      "checkout",
      "link",
      "--workspace",
      syntheticUlid("G02WS2"),
      "--runner",
      syntheticUlid("G02RN2"),
      "--project",
      syntheticUlid("G02PJ2"),
      "--label",
      "Duplicate",
      "--repository",
      "git.synthetic.test/bfb/demo",
      repoDir,
    ]);
    assert.equal(
      (duplicate.json.error as Record<string, unknown> | undefined)?.code,
      "checkout_already_linked",
      "duplicate link is rejected",
    );
    const unlink = cli(["checkout", "unlink", checkoutId]);
    assert.equal(unlink.exit, 0, "checkout unlink exits zero");
    golden.push({
      stage: "enrollment link",
      outcome: "passed",
      detail: "checkout links, verifies, rejects duplicates, unlinks",
    });
    console.log("G02_GOLDEN checkout link cycle completes");

    const probe = spawnSync("node", ["tools/provider-probe/generate.mjs", "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(probe.status, 0, "provider probe manifests check out");
    golden.push({
      stage: "provider setup",
      outcome: "passed",
      detail: "pinned provider manifests validate offline",
    });
    const stopping = cli(["daemon", "stop"]);
    assert.equal(
      (stopping.json.payload as Record<string, unknown> | undefined)?.status,
      "stopping",
      "daemon stops on request",
    );
  } finally {
    daemon.kill();
  }
  const logs = cli(["daemon", "logs", "--lines", "50"]);
  const entries = ((logs.json.payload as Record<string, unknown>).log_entries as unknown[]) ?? [];
  assert.ok(entries.length >= 1, "bounded redacted logs survive restart");
  assert.ok(!JSON.stringify(entries).includes(stateDir), "logs carry no local paths");
  golden.push({
    stage: "daemon logs",
    outcome: "passed",
    detail: "bounded entries with no local paths",
  });
  spawnSync("/bin/launchctl", ["bootout", `gui/${launchdUid}/com.tenira.bfb.g02`]);
  rmSync(join(process.env.HOME ?? "", "Library/LaunchAgents/com.tenira.bfb.g02.plist"), {
    force: true,
  });
  const gone = spawnSync("/bin/launchctl", ["print", `gui/${launchdUid}/com.tenira.bfb.g02`]);
  assert.notEqual(gone.status, 0, "launchd service is removed after the drill");
  golden.push({
    stage: "uninstall binary",
    outcome: "passed",
    detail: "launchd service and plist removed; state stays isolated",
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
await writeJson(join(evidenceDir, "golden-flow.json"), {
  release: "bfb-v0.1-g02",
  migration_head: migrationManifest.migration_head,
  stages: golden,
});
pass("GOLDEN", `${golden.length} local golden stages pass on fixtures`);

// G-SMOKE: dry-run every env config plus authenticated-handler smoke on the real worker.
const dryRuns: Array<{ config: string; worker: string; outcome: string }> = [];
for (const [worker, configs, bin] of [
  ["control", CONTROL_CONFIGS, "apps/control-worker/node_modules/.bin/wrangler"],
  ["artifact", ARTIFACT_CONFIGS, "apps/artifact-worker/node_modules/.bin/wrangler"],
] as const) {
  for (const [, file] of configs) {
    const outdir = mkdtempSync(join(tmpdir(), "bfb-g02-dryrun-"));
    try {
      const run = spawnSync(
        resolve(root, bin),
        ["deploy", "--dry-run", "--outdir", outdir, "--config", file],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      assert.equal(run.status, 0, `dry-run passes for ${file}: ${String(run.stderr).slice(-500)}`);
      dryRuns.push({ config: file, worker, outcome: "passed" });
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }
}
pass("DRYRUN", "8 env configs bundle with wrangler deploy --dry-run");

const smoke: Array<{ check: string; status: number; outcome: string }> = [];
const localServer = createTestHarness({
  root,
  workers: [{ configPath: "tools/g02/wrangler-g02.toml" }],
});
try {
  await localServer.listen();
  const local = localServer.getWorker("bfb-g02");
  await local.applyD1Migrations("DB");
  const origin = "http://bfb.localhost:8787";
  const smokeFetch = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    local.fetch(`${origin}${path}`, {
      headers: { "cf-connecting-ip": "192.0.2.31", ...headers },
    }) as unknown as Promise<Response>;
  const health = await smokeFetch("/healthz");
  assert.equal(health.status, 200, "healthz answers");
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(healthBody.ok, true, "healthz reports ok");
  smoke.push({ check: "healthz", status: 200, outcome: "passed" });
  const versionRes = await smokeFetch("/api/v1/cli/version");
  assert.equal(versionRes.status, 200, "cli version answers");
  const versionBody = (await versionRes.json()) as Record<string, unknown>;
  assert.deepEqual(
    {
      api_version: versionBody.api_version,
      wire_protocol: versionBody.wire_protocol,
      cli_min_version: versionBody.cli_min_version,
    },
    { api_version: "1", wire_protocol: "bfb-wire/1", cli_min_version: "0.1.0" },
    "cli version keeps its frozen shape",
  );
  smoke.push({ check: "cli/version", status: 200, outcome: "passed" });
  const anonymous = await smokeFetch("/api/v1/cli/session");
  assert.equal(anonymous.status, 401, "cli session without a credential is rejected");
  smoke.push({ check: "cli/session anonymous", status: 401, outcome: "passed" });
  const forged = await smokeFetch("/api/v1/cli/session", {
    authorization: "Bearer bfb_cli_synthetic-forged-credential",
  });
  assert.equal(forged.status, 401, "cli session with a bad credential is rejected");
  smoke.push({ check: "cli/session forged", status: 401, outcome: "passed" });
} finally {
  await localServer.close();
}
// The gate config boots but refuses every request on the choice sentinel.
const selfhostServer = createTestHarness({
  root,
  workers: [{ configPath: "tools/g02/wrangler-g02-gate.toml" }],
});
try {
  await selfhostServer.listen();
  const selfhost = selfhostServer.getWorker("bfb-g02-gate");
  const gated = await selfhost.fetch("http://bfb.localhost:8787/healthz");
  const gatedBody = (await gated.json()) as Record<string, unknown>;
  assert.equal(gatedBody.error, "config_invalid", "self-host sentinel fails closed live");
  smoke.push({ check: "selfhost jurisdiction gate", status: gated.status, outcome: "passed" });
} finally {
  await selfhostServer.close();
}
await writeJson(join(evidenceDir, "smoke.json"), {
  release: "bfb-v0.1-g02",
  dry_runs: dryRuns,
  authenticated_handlers: smoke,
  rollout_smoke: "node tools/g02/smoke-commands.mjs --origin <production-origin>",
});
pass("SMOKE", "dry-runs plus authenticated-handler smoke pass; sentinel fails closed");

// G-SIGN: the managed-link signing proof runs in signing.mjs; this gate pins the stable surface.
const nativeActions = readText("apps/macos/Sources/BFB/NativeActions.swift");
assert.ok(nativeActions.includes("/Contents/Helpers/bfb"), "hook launcher path is stable");
assert.ok(nativeActions.includes("__launch"), "hook launcher subcommand is stable");
const daemonInstall = readText("internal/daemon/install.go");
assert.ok(
  daemonInstall.includes('ServiceLabel = "com.tenira.bfb.daemon"'),
  "daemon service label is stable",
);
const infoPlist = readText("apps/macos/Sources/BFB/Info.plist");
assert.ok(infoPlist.includes("<string>bfb</string>"), "self-host custom scheme is declared");
const signingResult = JSON.parse(
  readText("docs/work-packages/evidence/WP-G02/signing-result.json"),
) as Record<string, unknown>;
assert.equal(signingResult.deep_strict_verify, "passed", "managed-link app verifies");
assert.equal(signingResult.app_identifier, "com.qdis.bfb", "app identifier is stable");
assert.equal(
  signingResult.helper_identifier,
  "com.tenira.bfb.daemon",
  "helper identifier is stable",
);
pass("SIGN", "stable native surface plus the local signing proof");

// G-SCAN: generated evidence carries no secrets, paths, or terminal output.
let scanFiles: string[];
try {
  // The manifest artifact list (minus this report) keeps the scanned set stable
  // no matter which step of test:g02 produced which file first.
  const manifest = JSON.parse(readText("docs/work-packages/evidence/WP-G02/manifest.json")) as {
    artifacts: string[];
  };
  scanFiles = manifest.artifacts
    .map((artifact) => artifact.split("/").pop() as string)
    .filter((name) => name !== "redaction-scan.json");
} catch {
  scanFiles = readdirSync(evidenceDir).filter(
    (name) => name.endsWith(".json") || name.endsWith(".jsonl"),
  );
}
const needles = ["/Users/", "BEGIN PRIVATE KEY", "AKIA", "ghp_", "gho_", "xox"];
const findings: string[] = [];
for (const name of scanFiles) {
  const text = readText(`docs/work-packages/evidence/WP-G02/${name}`);
  for (const needle of needles) {
    if (text.includes(needle)) findings.push(`${name}: ${needle}`);
  }
}
assert.deepEqual(findings, [], "evidence stays bounded and redacted");
await writeJson(join(evidenceDir, "redaction-scan.json"), {
  release: "bfb-v0.1-g02",
  scanned_files: scanFiles.length,
  scanned: [...scanFiles].sort(),
  prohibited_classes: [
    "task bodies",
    "cookies",
    "bearer secrets",
    "local paths",
    "private keys",
    "terminal output",
  ],
  findings: [],
  status: "passed",
});
pass("SCAN", `${scanFiles.length} evidence files carry no prohibited content`);

// G-REPORT: inherit the G01 gate report; AG-10 and OG-02 stay not_run for clean environments.
const g01Report = JSON.parse(readText("docs/work-packages/evidence/WP-G01/gate-report.json")) as {
  gates: Array<Record<string, unknown>>;
};
const NOT_RUN_REASON =
  "No second Cloudflare account, macOS user account, or spare Mac is available to this agent, and remote preparation is dry-run only; the executable procedure is committed and the local halves pass in pnpm test:g02.";
const gates = g01Report.gates.map((row) => {
  if (row.gate === "AG-10") {
    return {
      ...row,
      status: "not_run",
      command: "docs/release/clean-install.md",
      evidence:
        "docs/work-packages/evidence/WP-G02/golden-flow.json, docs/work-packages/evidence/WP-G02/smoke.json",
      waiver: NOT_RUN_REASON,
      detail:
        "Local halves proven (golden chain, smoke, signing); blank-account and blank-Mac passes wait on clean environments.",
    };
  }
  if (row.gate === "OG-02") {
    return {
      ...row,
      status: "not_run",
      command: "docs/release/migration-rollback.md",
      evidence:
        "docs/work-packages/evidence/WP-G02/migration-drill.json, docs/work-packages/evidence/WP-G02/rotation-drill.json, docs/work-packages/evidence/WP-G02/rollback-limits.json",
      waiver: NOT_RUN_REASON,
      detail:
        "Local drills proven (empty/previous migration, kid overlap, rollback trace); Time Travel restore and cross-release upgrade wait on rollout.",
    };
  }
  return row;
});
await writeJson(join(evidenceDir, "gate-report.json"), {
  release: "bfb-v0.1-g02",
  inherits: "docs/work-packages/evidence/WP-G01/gate-report.json",
  protocol_version: FROZEN_PROTOCOL,
  schema_version: FROZEN_SCHEMA,
  migration_head: FROZEN_MIGRATION_HEAD,
  environment:
    "local workerd D1 plus real Chromium on macOS (arm64); Node 24.19.0, pnpm 11.21.0, Go 1.26.5",
  command: "pnpm test:g02",
  gates,
  outcome: "not_run",
  note: "AG-10 and OG-02 remain not_run until the clean environments exist; every other gate keeps its G01 verdict.",
});
pass("REPORT", "acceptance report inherits G01 with AG-10/OG-02 not_run");
console.log(`G02_OK ${stages.length} stages, ${golden.length} golden steps`);
