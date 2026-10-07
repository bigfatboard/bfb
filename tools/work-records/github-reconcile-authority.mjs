// ABOUTME: Proves repository reconciliation commits only under live installation and repository authority.
// ABOUTME: Forwards native bound statements and measures complete rollback after independent production-helper revocation.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "tools/work-records/package.json"));
const { createTestHarness } = require("wrangler");
const { adaptD1, loadMigrationManifest } = await import(resolve(root, "packages/db/dist/index.js"));
const {
  FIX,
  WorkspaceHub,
  GITHUB_QUEUE_SYSTEM_ID,
  GITHUB_WEBHOOK_SYSTEM_ID,
  issueStepUpProof,
  markGitHubInstallationRevoked,
  randomUlid,
  reconcileGitHubCommand,
  seedSyntheticWorkspace,
} = await import(resolve(root, "packages/domain/dist/index.js"));

assert.equal(process.version, "v24.19.0");

const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const checks = [];
const failures = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };
const now = new Date().toISOString();
const origin = "https://bfb.github-independent-revoke.test";
let fixtureNumber = 0;
let db;
let independent;
let binding;
let tables;
let engineExclusions;
let guards;
let cutFixture;
let cutRequest;
let cutOutcome;

function expect(value, label, failed) {
  if (!value) failed.push(label);
}
async function collect(check, run) {
  const witness = { phase: "setup", expected_failures: [] };
  try {
    await run(witness);
  } catch (error) {
    witness.unexpected_error_name = error instanceof Error ? error.name : "unknown_error";
    witness.expected_failures.push("probe_or_fixture_error");
  }
  const outcome = witness.expected_failures.length ? "failed" : "passed";
  const record = { check, outcome, witness };
  checks.push(record);
  if (outcome === "failed") failures.push({ check, failures: witness.expected_failures });
  console.log(JSON.stringify(record));
}
async function snapshot() {
  const result = {};
  for (const { name } of tables) {
    result[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return result;
}
const budgets = () => db.prepare("SELECT * FROM rate_limit_buckets ORDER BY rowid").all();
async function invariantWitness(before, beforeBudgets, witness) {
  const after = await snapshot();
  const changed = tables
    .map(({ name }) => name)
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
  witness.changed_canonical_tables = changed;
  witness.full_canonical_unchanged = changed.length === 0;
  witness.http_budgets_unchanged =
    JSON.stringify(beforeBudgets) === JSON.stringify(await budgets());
  witness.foreign_keys_clean = (await db.prepare("PRAGMA foreign_key_check").all()).length === 0;
  witness.transient_guards_empty = guards.every(({ name }) => after[name].length === 0);
  return after;
}
async function external(name, input, actor, key = randomUlid()) {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandName: name,
        request: {
          workspaceId: FIX.workspace,
          authorizationEpoch: 1,
          ...(actor === "human" ? { actorHumanId: FIX.owner } : { actorSystemId: actor }),
          idempotencyKey: key,
          now,
          input,
        },
      }),
    });
  assert.equal(response.status, 200, "registered external Hub must return a command envelope");
  const outcome = await response.json();
  assert(outcome.ok, "registered synthetic setup must succeed");
  return outcome.result;
}
async function proof(action, targetId) {
  return issueStepUpProof(
    db,
    FIX.owner,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(),
    },
    now,
  );
}
async function fixture() {
  fixtureNumber++;
  const installationId = String(4_000_000 + fixtureNumber);
  const repositoryId = String(5_000_000 + fixtureNumber);
  await external(
    "github.install",
    {
      installationId,
      appId: "6000001",
      appSlug: "synthetic-revoke-app",
      accountId: "6000002",
      accountLogin: "synthetic-revoke-account",
      accountType: "Organization",
      permissions: { metadata: "read" },
      events: ["push", "installation"],
      stepUpProofId: await proof("github.install", `github-installation:${installationId}`),
    },
    "human",
  );
  const lifecycleId = randomUlid();
  const lifecycle = await external(
    "github.webhook.receive",
    {
      deliveryId: lifecycleId,
      event: "installation",
      supported: true,
      effect: {
        event: "installation",
        action: "created",
        installationId,
        repositoryId: null,
        occurredAt: now,
        ref: null,
        version: null,
        detail: {},
      },
    },
    GITHUB_WEBHOOK_SYSTEM_ID,
  );
  await external(
    "github.reconcile",
    {
      deliveryId: lifecycleId,
      outboxId: lifecycle.outbox_id,
    },
    GITHUB_QUEUE_SYSTEM_ID,
    `github-reconcile.${lifecycle.outbox_id}`,
  );
  const project = await external(
    "project.create",
    {
      name: "Synthetic independent revoke project",
      slug: `independent-revoke-${fixtureNumber}`,
      tint: "#10B981",
      accessMode: "workspace",
      repositoryHost: "github.com",
      hostedRepositoryId: repositoryId,
      repositorySubpath: ".",
    },
    "human",
  );
  const link = await external(
    "github.repository.map",
    {
      installationId,
      repositoryId,
      projectId: project.id,
      fullName: "synthetic-org/synthetic-revoke-repo",
      defaultBranch: "main",
      stepUpProofId: await proof("github.repository.map", `github-link:${repositoryId}`),
    },
    "human",
  );
  const deliveryId = randomUlid();
  const delivery = await external(
    "github.webhook.receive",
    {
      deliveryId,
      event: "push",
      supported: true,
      effect: {
        event: "push",
        action: null,
        installationId,
        repositoryId,
        occurredAt: now,
        ref: "main",
        version: "a".repeat(40),
        detail: {},
      },
    },
    GITHUB_WEBHOOK_SYSTEM_ID,
  );
  assert(delivery.outbox_id);
  const input = {
    outboxId: delivery.outbox_id,
    deliveryId,
    observed: {
      repositoryFullName: "synthetic-org/synthetic-revoke-repo",
      defaultBranch: "main",
      fetchedAt: now,
    },
  };
  const request = {
    workspaceId: FIX.workspace,
    actorSystemId: GITHUB_QUEUE_SYSTEM_ID,
    authorizationEpoch: 1,
    idempotencyKey: `github-reconcile.${delivery.outbox_id}`,
    now,
    input,
  };
  return {
    installationId,
    repositoryId,
    projectId: project.id,
    linkId: link.link_id,
    deliveryId,
    outboxId: delivery.outbox_id,
    request,
  };
}
function measuredHub(witness, beforeBatch, expectedProject) {
  const original = new WeakMap();
  const metadata = new WeakMap();
  let flushed = false;
  function wrapped(native, sql) {
    const statement = {
      bind(...parameters) {
        bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
        assert(parameters.length <= 100, "direct Hub bindings must remain bounded");
        const bound = native.bind(...parameters);
        metadata.set(bound, sql);
        // Queued writes are the actual native bound object. Read wrappers only
        // observe genuinely returned rows and never substitute an outcome.
        return /^SELECT\b/i.test(sql.trimStart()) ? wrapped(bound, sql) : bound;
      },
      async first(column) {
        const row = await native.first(column);
        if (/SELECT workspace_id, status FROM github_app_installations/u.test(sql)) {
          witness.installation_captured_active =
            row?.workspace_id === FIX.workspace && row?.status === "active";
        }
        if (/SELECT project_id, default_branch FROM github_repository_links/u.test(sql)) {
          witness.active_link_captured = Boolean(row);
          witness.captured_project_matches = row?.project_id === expectedProject;
        }
        return row;
      },
      all: () => native.all(),
      run: () => native.run(),
    };
    original.set(statement, native);
    metadata.set(native, sql);
    metadata.set(statement, sql);
    return statement;
  }
  return new WorkspaceHub(
    adaptD1({
      prepare(sql) {
        bounds.maximum_statement_bytes = Math.max(
          bounds.maximum_statement_bytes,
          Buffer.byteLength(sql),
        );
        assert(Buffer.byteLength(sql) <= 100_000, "direct Hub SQL must remain bounded");
        return wrapped(binding.prepare(sql), sql);
      },
      async batch(statements) {
        assert.equal(flushed, false, "one fresh command must flush one batch");
        flushed = true;
        bounds.maximum_batch_statements = Math.max(
          bounds.maximum_batch_statements,
          statements.length,
        );
        witness.native_batch_prepared = true;
        witness.batch_statement_count = statements.length;
        const nativeStatements = statements.map(
          (statement) => original.get(statement) ?? statement,
        );
        assert(
          nativeStatements.every((statement) => metadata.has(statement)),
          "every actual bound statement must be accounted for",
        );
        witness.all_original_native_statements_forwarded = true;
        if (beforeBatch) await beforeBatch();
        witness.native_batch_executed = true;
        const result = await binding.batch(nativeStatements);
        witness.native_batch_committed = true;
        return result;
      },
    }),
  );
}
async function subjectState(f) {
  const cursor = await db
    .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
    .get(FIX.workspace);
  const outbox = await db
    .prepare("SELECT state FROM github_integration_outbox WHERE workspace_id=? AND outbox_id=?")
    .get(FIX.workspace, f.outboxId);
  const delivery = await db
    .prepare("SELECT state FROM github_webhook_deliveries WHERE workspace_id=? AND delivery_id=?")
    .get(FIX.workspace, f.deliveryId);
  const cached = await db
    .prepare(
      "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
    )
    .get(FIX.workspace, f.request.idempotencyKey);
  const parsed = cached ? JSON.parse(cached.result_json) : undefined;
  const evidence = await db
    .prepare(
      "SELECT project_id,task_id,kind,version_token FROM github_evidence WHERE workspace_id=? AND repository_id=? ORDER BY kind",
    )
    .all(FIX.workspace, f.repositoryId);
  return {
    cursor: cursor?.cursor ?? 0,
    outbox: outbox?.state,
    delivery: delivery?.state,
    cache_present: Boolean(cached),
    cache_effect: parsed?.result?.effect,
    evidence_count: evidence.length,
    evidence_canonical: evidence.every(
      (row) =>
        row.project_id === f.projectId &&
        row.task_id === null &&
        row.version_token === "a".repeat(40),
    ),
  };
}
function reply(outcome) {
  return outcome.ok
    ? { ok: true, effect: outcome.result.effect, replayed: outcome.replayed }
    : { ok: false, code: outcome.error.code };
}
function state(witness, before, after) {
  witness.cursor_delta = after.cursor - before.cursor;
  witness.outbox_after = after.outbox;
  witness.delivery_after = after.delivery;
  witness.cache_present_after = after.cache_present;
  witness.cache_effect_after = after.cache_effect ?? null;
  witness.evidence_count_after = after.evidence_count;
  witness.evidence_tuple_canonical = after.evidence_canonical;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  binding = (await worker.getEnv()).DB;
  // A second independent client to the same native database, not a competing Hub.
  const independentBinding = (await worker.getEnv()).DB;
  db = adaptD1(binding);
  independent = adaptD1(independentBinding);
  await seedSyntheticWorkspace(db, now, "global");
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  const allTables = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  const engineNames = new Set(["sqlite_sequence", "_cf_KV", "_cf_METADATA", "d1_migrations"]);
  for (const { name } of allTables) {
    assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
    if ((name.startsWith("sqlite_") || name.startsWith("_cf_")) && !engineNames.has(name)) {
      throw new Error("unexpected engine table exclusion");
    }
  }
  engineExclusions = allTables.filter(({ name }) => engineNames.has(name)).map(({ name }) => name);
  assert(allTables.some(({ name }) => name === "rate_limit_buckets"));
  tables = allTables.filter(({ name }) => !engineNames.has(name) && name !== "rate_limit_buckets");
  guards = tables.filter(({ name }) => name.endsWith("_guards"));
  assert(guards.some(({ name }) => name === "runner_mutation_guards"));

  await collect("healthy_native_production_hub_reconcile", async (witness) => {
    const f = await fixture();
    const before = await snapshot(),
      beforeBudgets = await budgets(),
      subjectBefore = await subjectState(f);
    witness.phase = "native_reconcile";
    const outcome = await measuredHub(witness, undefined, f.projectId).execute(
      reconcileGitHubCommand,
      f.request,
    );
    witness.reply = reply(outcome);
    await invariantWitness(before, beforeBudgets, witness);
    state(witness, subjectBefore, await subjectState(f));
    witness.phase = "healthy_expectations";
    expect(
      outcome.ok && outcome.result.effect === "applied" && !outcome.replayed,
      "healthy_reconcile_applies",
      witness.expected_failures,
    );
    expect(
      witness.installation_captured_active &&
        witness.active_link_captured &&
        witness.captured_project_matches,
      "genuine_source_captures",
      witness.expected_failures,
    );
    expect(
      witness.cursor_delta === 1 &&
        witness.outbox_after === "done" &&
        witness.delivery_after === "applied",
      "healthy_ledger_commit",
      witness.expected_failures,
    );
    expect(
      witness.cache_present_after &&
        witness.evidence_count_after === 2 &&
        witness.evidence_tuple_canonical,
      "healthy_evidence_and_cache",
      witness.expected_failures,
    );
    expect(
      witness.http_budgets_unchanged &&
        witness.foreign_keys_clean &&
        witness.transient_guards_empty,
      "healthy_storage_invariants",
      witness.expected_failures,
    );
  });

  await collect("independent_completed_revoke_before_bound_batch_rolls_back", async (witness) => {
    const f = await fixture();
    cutFixture = f;
    cutRequest = f.request;
    let baseline, baselineBudgets, subjectBefore;
    const hub = measuredHub(
      witness,
      async () => {
        witness.phase = "independent_revocation";
        assert(
          witness.installation_captured_active &&
            witness.active_link_captured &&
            witness.captured_project_matches,
        );
        const cursorBefore = (await subjectState(f)).cursor;
        const helperResult = await markGitHubInstallationRevoked(
          independent,
          f.installationId,
          now,
        );
        const installation = await independent
          .prepare("SELECT status FROM github_app_installations WHERE installation_id=?")
          .get(f.installationId);
        const link = await independent
          .prepare("SELECT link_state FROM github_repository_links WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.linkId);
        witness.real_helper_returned_revoked = helperResult === true;
        witness.completed_cut_revoked_source_and_closed_link =
          installation?.status === "revoked" && link?.link_state === "closed";
        witness.independent_cut_cursor_unchanged = (await subjectState(f)).cursor === cursorBefore;
        assert(
          witness.real_helper_returned_revoked &&
            witness.completed_cut_revoked_source_and_closed_link &&
            witness.independent_cut_cursor_unchanged,
        );
        baseline = await snapshot();
        baselineBudgets = await budgets();
        subjectBefore = await subjectState(f);
        witness.baseline_taken_after_completed_revoke = true;
        witness.phase = "native_batch_after_revoke";
      },
      f.projectId,
    );
    cutOutcome = await hub.execute(reconcileGitHubCommand, f.request);
    witness.reply = reply(cutOutcome);
    assert(
      baseline && baselineBudgets && subjectBefore,
      "the genuine before-batch cut must complete",
    );
    await invariantWitness(baseline, baselineBudgets, witness);
    state(witness, subjectBefore, await subjectState(f));
    witness.phase = "rollback_expectations";
    expect(
      !cutOutcome.ok && cutOutcome.error.code === "command_failed",
      "revoked_source_reconcile_must_reject",
      witness.expected_failures,
    );
    expect(witness.full_canonical_unchanged, "whole_canonical_rollback", witness.expected_failures);
    expect(witness.cursor_delta === 0, "cursor_rollback", witness.expected_failures);
    expect(
      witness.outbox_after === "pending" && witness.delivery_after === "received",
      "outbox_delivery_rollback",
      witness.expected_failures,
    );
    expect(
      !witness.cache_present_after && witness.evidence_count_after === 0,
      "cache_and_evidence_rollback",
      witness.expected_failures,
    );
    expect(
      witness.http_budgets_unchanged &&
        witness.foreign_keys_clean &&
        witness.transient_guards_empty,
      "post_cut_storage_invariants",
      witness.expected_failures,
    );
  });

  await collect("same_business_key_retry_uses_current_revoked_to_ignored_path", async (witness) => {
    assert(cutFixture && cutRequest && cutOutcome);
    const before = await snapshot(),
      beforeBudgets = await budgets(),
      subjectBefore = await subjectState(cutFixture);
    witness.phase = "same_business_key_retry";
    const outcome = await measuredHub(witness).execute(reconcileGitHubCommand, cutRequest);
    witness.reply = reply(outcome);
    witness.derivative_of_previous_cut_not_independent_security_case = true;
    await invariantWitness(before, beforeBudgets, witness);
    state(witness, subjectBefore, await subjectState(cutFixture));
    witness.phase = "retry_expectations";
    expect(
      outcome.ok && outcome.result.effect === "ignored" && !outcome.replayed,
      "retry_must_reach_current_revoked_path",
      witness.expected_failures,
    );
    expect(
      witness.cursor_delta === 1 &&
        witness.outbox_after === "done" &&
        witness.delivery_after === "ignored",
      "retry_records_ignored_terminal_state",
      witness.expected_failures,
    );
    expect(
      witness.evidence_count_after === 0 && witness.cache_effect_after === "ignored",
      "retry_retains_no_evidence_and_current_cache",
      witness.expected_failures,
    );
    expect(
      witness.http_budgets_unchanged &&
        witness.foreign_keys_clean &&
        witness.transient_guards_empty,
      "retry_storage_invariants",
      witness.expected_failures,
    );
  });

  await collect("already_revoked_fresh_key_retains_existing_ignored_control", async (witness) => {
    const f = await fixture();
    assert.equal(await markGitHubInstallationRevoked(independent, f.installationId, now), true);
    const before = await snapshot(),
      beforeBudgets = await budgets(),
      subjectBefore = await subjectState(f);
    const request = { ...f.request, input: { outboxId: f.outboxId, deliveryId: f.deliveryId } };
    witness.phase = "current_revoked_path";
    const outcome = await measuredHub(witness).execute(reconcileGitHubCommand, request);
    witness.reply = reply(outcome);
    await invariantWitness(before, beforeBudgets, witness);
    state(witness, subjectBefore, await subjectState(f));
    witness.phase = "ignored_control_expectations";
    expect(
      outcome.ok && outcome.result.effect === "ignored" && !outcome.replayed,
      "existing_ignored_path_works",
      witness.expected_failures,
    );
    expect(
      witness.cursor_delta === 1 &&
        witness.outbox_after === "done" &&
        witness.delivery_after === "ignored",
      "ignored_ledger_commit",
      witness.expected_failures,
    );
    expect(
      witness.evidence_count_after === 0 && witness.cache_effect_after === "ignored",
      "ignored_without_evidence",
      witness.expected_failures,
    );
    expect(
      witness.http_budgets_unchanged &&
        witness.foreign_keys_clean &&
        witness.transient_guards_empty,
      "ignored_storage_invariants",
      witness.expected_failures,
    );
  });

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "github_repository_reconcile_authority",
      node: process.version,
      migration_head: manifest.migration_head,
      groups: checks.length,
      checks,
      failures,
      bounds,
      canonical_table_count: tables.length,
      excluded_engine_tables_actually_present: engineExclusions,
      separately_compared_http_budget_tables: ["rate_limit_buckets"],
      measured_scope:
        "direct production domain Hub reconcile statements and batches only; external setup, independent revoke, snapshots and Worker/DO internals excluded",
      limitations: [
        "Actual native disposable D1 plus imported production Hub command; not a deployed Queue or live GitHub ingress.",
        "Setup uses registered external Worker/Hub commands and synthetic workspace/proofs, not fabricated reconcile records.",
        "Same-key follow-on is derivative of the primary revoke cut; not a second independent race.",
        "Repository remap policy, dormant private task-bound history, natural expiry, providers, runners, deployment and private activation are excluded.",
      ],
      outcome: failures.length ? "failed" : "passed",
    }),
  );
  assert.equal(failures.length, 0, "collecting independent-revocation expectations failed");
  console.log("C11_GITHUB_RECONCILE_AUTHORITY_D1_OK");
} finally {
  await server.close();
}
