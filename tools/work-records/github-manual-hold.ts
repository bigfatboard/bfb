// ABOUTME: Proves uniform manual GitHub linking denial through disposable Workers and the registered Hub.
// ABOUTME: Historical evidence, caches and receipts remain intact while native readers retain shared provenance.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  canonicalLaunchJson,
  getEvidenceVerificationStatus,
  listGitHubEvidence,
  randomUlid,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type GitHubEvidenceRecord,
  type LinkGitHubEvidenceInput,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.github-manual-hold.test";
const historicalNow = "2026-08-15T12:00:00.000Z";
const commandName = "github.evidence.link";
const unavailable = {
  code: "request_rejected",
  message: "manual GitHub evidence linking is unavailable",
};
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
type Client = "a" | "b";
type Snapshot = Record<string, Record<string, unknown>[]>;
interface Attempt {
  input: LinkGitHubEvidenceInput | Record<string, unknown>;
  actor?: string;
  key?: string;
  client?: Client;
}
interface Witness {
  phase: string;
  replies: string[];
  canonical_unchanged: boolean;
  http_budgets_unchanged: boolean;
  foreign_keys_clean: boolean;
  transient_guards_empty: boolean;
}
const checks: Array<{ check: string; outcome: "passed" | "failed"; witness: Witness }> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };

async function execute<T>(
  name: string,
  input: unknown,
  actor = FIX.member,
  key = randomUlid(),
  client: Client = "a",
): Promise<CommandOutcome<T>> {
  const response = await server
    .getWorker(`bfb-work-records-${client}`)
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: name,
        request: {
          workspaceId: FIX.workspace,
          actorHumanId: actor,
          authorizationEpoch: 1,
          idempotencyKey: key,
          now: historicalNow,
          input,
        },
      }),
    });
  assert.equal(response.status, 200, "registered Hub transport must return its command envelope");
  return (await response.json()) as CommandOutcome<T>;
}

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, "synthetic production task setup must succeed");
  return outcome.result;
}

function measuredReaders(binding: D1Like) {
  return adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "native reader SQL must remain bounded");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "native reader bindings must remain bounded");
          // Forward the actual native statement and original parameters without fabricated rows.
          return native.bind(...parameters);
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    batch: (statements) => binding.batch(statements),
  });
}

async function collect(name: string, run: (witness: Witness) => Promise<void>) {
  const witness: Witness = {
    phase: "setup",
    replies: [],
    canonical_unchanged: false,
    http_budgets_unchanged: false,
    foreign_keys_clean: false,
    transient_guards_empty: false,
  };
  try {
    await run(witness);
    checks.push({ check: name, outcome: "passed", witness });
    console.log(JSON.stringify({ check: name, outcome: "passed" }));
  } catch (error) {
    checks.push({ check: name, outcome: "failed", witness });
    failures.push({
      check: name,
      phase: witness.phase,
      error_name: error instanceof Error ? error.name : "unknown_error",
    });
    // Raw errors, request bodies, evidence IDs and cached content never enter the report.
    console.log(JSON.stringify({ check: name, outcome: "failed" }));
  }
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
  const readers = measuredReaders(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, historicalNow, "global");
  const allTables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const engineExclusions = new Set(["sqlite_sequence", "_cf_KV", "_cf_METADATA", "d1_migrations"]);
  const httpBudgetTable = "rate_limit_buckets";
  const tables = allTables.filter(
    ({ name }) => !engineExclusions.has(name) && name !== httpBudgetTable,
  );
  for (const { name } of allTables) assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
  const guardTables = tables.filter(({ name }) => name.endsWith("_guards"));
  assert(guardTables.some(({ name }) => name === "runner_mutation_guards"));

  async function snapshot(): Promise<Snapshot> {
    const rows: Snapshot = {};
    for (const { name } of tables) {
      rows[name] = (await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()) as Record<
        string,
        unknown
      >[];
    }
    return rows;
  }
  async function budgets() {
    return db.prepare(`SELECT * FROM ${httpBudgetTable} ORDER BY rowid`).all();
  }
  async function retainedEffects(before: Snapshot, beforeBudgets: unknown[], witness: Witness) {
    witness.phase = "canonical_effects";
    const after = await snapshot();
    witness.canonical_unchanged = JSON.stringify(after) === JSON.stringify(before);
    witness.http_budgets_unchanged =
      JSON.stringify(await budgets()) === JSON.stringify(beforeBudgets);
    witness.foreign_keys_clean = (await db.prepare("PRAGMA foreign_key_check").all()).length === 0;
    witness.transient_guards_empty = guardTables.every(({ name }) => after[name]?.length === 0);
    assert(witness.canonical_unchanged, "manual attempts must preserve every canonical table");
    assert(witness.http_budgets_unchanged, "internal Hub probes must not consume HTTP budgets");
    assert(witness.foreign_keys_clean, "historical fixtures must retain clean foreign keys");
    assert(witness.transient_guards_empty, "transient assertion guards must leave no rows");
  }
  function input(ref: string, taskId?: string): LinkGitHubEvidenceInput {
    return {
      projectId: FIX.projectA,
      ...(taskId === undefined ? {} : { taskId }),
      repositoryId: "9001",
      kind: "commit",
      ref,
      versionToken: "synthetic-manual-version",
      state: { summary: "SYNTHETIC-MANUAL-GITHUB-STATE" },
      observedBy: "runner",
    };
  }
  async function task() {
    return success(
      await execute<TaskRecord>("task.create", {
        projectId: FIX.projectA,
        title: "Synthetic retained GitHub parent",
        priority: "P2",
      }),
    );
  }
  async function privateTask() {
    const parent = await task();
    // Dormant privacy and named grants are explicit fixtures, not exposed ACL commands.
    await db
      .prepare(
        `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at)
         VALUES (?,?,?,?)`,
      )
      .run(FIX.workspace, parent.id, FIX.member, historicalNow);
    await db
      .prepare(
        `INSERT INTO task_human_grants
         (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at,revoked_at)
         VALUES (?,?,?,?,1,'contribute',?,NULL)`,
      )
      .run(FIX.workspace, randomUlid(), parent.id, FIX.owner, historicalNow);
    return parent;
  }
  async function evidence(
    value: LinkGitHubEvidenceInput,
    observedBy: GitHubEvidenceRecord["observed_by"] = value.observedBy,
    observedAt = historicalNow,
  ): Promise<GitHubEvidenceRecord> {
    const row: GitHubEvidenceRecord = {
      id: randomUlid(),
      workspace_id: FIX.workspace,
      project_id: value.projectId,
      task_id: value.taskId ?? null,
      repository_id: value.repositoryId,
      kind: value.kind,
      ref: value.ref,
      version_token: value.versionToken,
      state: value.state ?? {},
      observed_by: observedBy,
      observed_at: observedAt,
      resource_version: 3,
    };
    // Historical associations are seeded intact; the held manual command is never setup.
    await db
      .prepare(
        `INSERT INTO github_evidence
         (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,
          observed_by,observed_at,resource_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.workspace_id,
        row.id,
        row.project_id,
        row.task_id,
        row.repository_id,
        row.kind,
        row.ref,
        row.version_token,
        JSON.stringify(row.state),
        row.observed_by,
        row.observed_at,
        row.resource_version,
      );
    return row;
  }
  async function historicalCache(value: LinkGitHubEvidenceInput, row: GitHubEvidenceRecord) {
    const key = randomUlid();
    const current = (await db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace)) as { cursor: number } | null;
    const cursor = (current?.cursor ?? 0) + 1;
    const receipt = {
      actor: { humanId: FIX.member, authorizationEpoch: 1 },
      input: {
        projectId: value.projectId,
        taskId: value.taskId,
        repositoryId: value.repositoryId,
        kind: value.kind,
      },
      result: {
        id: row.id,
        project_id: row.project_id,
        task_id: row.task_id,
        repository_id: row.repository_id,
        kind: row.kind,
        observed_by: row.observed_by,
        resource_version: row.resource_version,
      },
    };
    const payload = JSON.stringify(receipt);
    const stored = JSON.stringify({
      result: row,
      cursor,
      authorizationEpoch: 1,
      actorHumanId: FIX.member,
      inputFingerprint: createHash("sha256")
        .update(canonicalLaunchJson(JSON.parse(JSON.stringify(value))))
        .digest("hex"),
    });
    await db.withTransaction(async (tx) => {
      await tx
        .prepare(
          `INSERT INTO workspace_cursors (workspace_id,cursor) VALUES (?,?)
           ON CONFLICT(workspace_id) DO UPDATE SET cursor=excluded.cursor`,
        )
        .run(FIX.workspace, cursor);
      await tx
        .prepare(
          `INSERT INTO semantic_events
           (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(FIX.workspace, randomUlid(), cursor, commandName, payload, historicalNow);
      await tx
        .prepare(
          `INSERT INTO audit_events
           (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run(FIX.workspace, randomUlid(), FIX.member, commandName, payload, historicalNow);
      await tx
        .prepare(
          `INSERT INTO outbox_records
           (workspace_id,outbox_id,kind,payload_json,created_at,delivered_at) VALUES (?,?,?,?,?,NULL)`,
        )
        .run(FIX.workspace, randomUlid(), commandName, payload, historicalNow);
      await tx
        .prepare(
          `INSERT INTO idempotency_records
           (workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,?,?,?,?)`,
        )
        .run(FIX.workspace, key, commandName, stored, historicalNow);
    });
    return key;
  }
  async function held(attempts: Attempt[], witness: Witness) {
    const before = await snapshot();
    const beforeBudgets = await budgets();
    const outcomes: CommandOutcome<unknown>[] = [];
    witness.phase = "registered_hub_dispatch";
    for (const attempt of attempts) {
      const outcome = await execute(
        commandName,
        attempt.input,
        attempt.actor ?? FIX.member,
        attempt.key ?? randomUlid(),
        attempt.client ?? "a",
      );
      outcomes.push(outcome);
      witness.replies.push(outcome.ok ? "success" : outcome.error.code);
    }
    await retainedEffects(before, beforeBudgets, witness);
    witness.phase = "uniform_hold";
    for (const outcome of outcomes) {
      assert.deepEqual(outcome, { ok: false, error: unavailable });
    }
    witness.phase = "complete";
  }

  await collect("absent_manual_keys_and_two_worker_retries_are_uniformly_held", async (witness) => {
    const first = { ...input("synthetic-absent-owner"), observedBy: "human" as const };
    const second = input("synthetic-absent-member");
    const firstKey = randomUlid();
    const secondKey = randomUlid();
    await held(
      [
        { input: first, actor: FIX.owner, key: firstKey, client: "a" },
        { input: first, actor: FIX.owner, key: firstKey, client: "b" },
        { input: second, key: secondKey, client: "b" },
        { input: { ...second, versionToken: "changed-synthetic-version" }, client: "a" },
      ],
      witness,
    );
  });

  await collect("visible_manual_key_retains_its_association_and_history", async (witness) => {
    const parent = await task();
    const value = input("synthetic-visible-key", parent.id);
    await evidence(value);
    await held(
      [
        { input: input(value.ref), client: "a" },
        { input: value, actor: FIX.owner, client: "b" },
      ],
      witness,
    );
  });

  await collect("hidden_manual_key_is_held_for_creator_and_named_grantee", async (witness) => {
    const parent = await privateTask();
    const value = input("SYNTHETIC-PRIVATE-GITHUB-KEY", parent.id);
    await evidence(value);
    await held(
      [
        { input: input(value.ref), actor: FIX.member, client: "a" },
        { input: input(value.ref), actor: FIX.owner, client: "b" },
      ],
      witness,
    );
  });

  await collect(
    "historical_shared_private_and_changed_input_caches_are_held_before_replay",
    async (witness) => {
      const parent = await task();
      const privateParent = await privateTask();
      const shared = input("synthetic-cache-shared", parent.id);
      const hidden = input("SYNTHETIC-PRIVATE-GITHUB-CACHED", privateParent.id);
      const sharedKey = await historicalCache(shared, await evidence(shared));
      const privateKey = await historicalCache(hidden, await evidence(hidden));
      await held(
        [
          { input: shared, key: sharedKey, client: "a" },
          { input: shared, key: sharedKey, client: "b" },
          { input: hidden, key: privateKey, client: "b" },
          { input: { ...shared, versionToken: "changed-synthetic-version" }, key: sharedKey },
        ],
        witness,
      );
    },
  );

  await collect(
    "shared_private_missing_and_omitted_requested_tasks_share_the_hold",
    async (witness) => {
      const parent = await task();
      const privateParent = await privateTask();
      await held(
        [
          { input: input("synthetic-requested-shared", parent.id), client: "a" },
          { input: input("synthetic-requested-private", privateParent.id), client: "b" },
          { input: input("synthetic-requested-missing", randomUlid()), client: "a" },
          { input: input("synthetic-requested-omitted"), client: "b" },
        ],
        witness,
      );
    },
  );

  await collect(
    "reviewer_and_malformed_admission_controls_remain_distinct_without_effects",
    async (witness) => {
      const value = input("synthetic-admission-control");
      const before = await snapshot();
      const beforeBudgets = await budgets();
      const controls = [
        { value, actor: FIX.reviewer, code: "forbidden" },
        { value: { ...value, audience: "private" }, actor: FIX.owner, code: "invalid_argument" },
        {
          value: { ...value, repositoryId: "not-numeric" },
          actor: FIX.owner,
          code: "invalid_argument",
        },
        { value: { ...value, observedBy: "github" }, actor: FIX.owner, code: "invalid_argument" },
      ];
      const outcomes: CommandOutcome<unknown>[] = [];
      witness.phase = "registered_hub_dispatch";
      for (const [index, control] of controls.entries()) {
        const outcome = await execute(
          commandName,
          control.value,
          control.actor,
          randomUlid(),
          index % 2 === 0 ? "a" : "b",
        );
        outcomes.push(outcome);
        witness.replies.push(outcome.ok ? "success" : outcome.error.code);
      }
      await retainedEffects(before, beforeBudgets, witness);
      witness.phase = "admission_controls";
      for (const [index, outcome] of outcomes.entries()) {
        assert(!outcome.ok, "admission controls must fail");
        assert.equal(outcome.error.code, controls[index]?.code);
        assert.notDeepEqual(outcome.error, unavailable);
      }
      witness.phase = "complete";
    },
  );

  await collect(
    "native_history_and_provenance_preserve_public_observations_without_hidden_rows",
    async (witness) => {
      const parent = await privateTask();
      const shared = { ...input("synthetic-history-public"), repositoryId: "9007" };
      const hidden = { ...input("SYNTHETIC-PRIVATE-HISTORY", parent.id), repositoryId: "9007" };
      const independent = { ...input("synthetic-independent-observation"), repositoryId: "9007" };
      const publicRow = await evidence(shared, "human", "2026-08-20T12:00:00.000Z");
      await evidence(hidden, "runner", "2026-09-20T12:00:00.000Z");
      await evidence({ ...independent, taskId: parent.id }, "runner");
      await evidence(independent, "github");
      const access = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };
      const before = await snapshot();
      const beforeBudgets = await budgets();
      witness.phase = "native_readers";
      const page = await listGitHubEvidence(
        readers,
        FIX.workspace,
        { projectId: FIX.projectA, repositoryId: "9007", limit: 1 },
        access,
      );
      const statuses = await getEvidenceVerificationStatus(
        readers,
        FIX.workspace,
        [
          { kind: "github", ref: `github:9007:commit:${hidden.ref}` },
          { kind: "github", ref: "github:9007:commit:synthetic-history-unknown" },
          {
            kind: "github",
            ref: `github:9007:commit:${independent.ref}`,
            version: independent.versionToken,
          },
        ],
        { projectId: FIX.projectA },
        access,
      );
      await retainedEffects(before, beforeBudgets, witness);
      witness.phase = "history_projection";
      assert.deepEqual(page, [publicRow]);
      assert.deepEqual(
        statuses.map((status) => status.provenance),
        ["unverified", "unverified", "github_verified"],
      );
      assert(!JSON.stringify(page).includes("SYNTHETIC-PRIVATE"));
      assert(bounds.maximum_bindings > 0 && bounds.maximum_statement_bytes > 0);
      witness.phase = "complete";
    },
  );

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "github_manual_link_hold",
      migration_head: manifest.migration_head,
      group_count: checks.length,
      checks,
      failures,
      ...bounds,
      bounds_scope:
        "direct native domain history/provenance selectors only; Worker/DO-internal SQL is not instrumented",
      snapshot_exclusions: {
        engine_and_migrations: allTables
          .filter(({ name }) => engineExclusions.has(name))
          .map(({ name }) => name),
        http_abuse: [httpBudgetTable],
        http_abuse_compared_separately: true,
      },
      outcome: failures.length === 0 ? "passed" : "failed",
      limits: [
        "two disposable Worker clients dispatch original inputs to the registered production Hub; no browser credential/CSRF ingress proof",
        "historical evidence/cache/receipts and dormant privacy/grants are explicit synthetic retained fixtures, not manual-command setup",
        "shared history/provenance readers only; webhook reconciliation retains its separate exact X04 proof",
        "no scoped-key migration, reconciliation bypass repair, provider operation, deployment or private activation claim",
      ],
    }),
  );
  assert.equal(failures.length, 0, "manual GitHub hold D1 groups failed");
  console.log("C11_GITHUB_MANUAL_HOLD_D1_OK");
} finally {
  await server.close();
}
