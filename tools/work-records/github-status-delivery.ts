// ABOUTME: Proves retained GitHub status authority and coherent projections on disposable native D1.
// ABOUTME: Independent synthetic scope and source changes preserve complete canonical state outside the cut.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adaptD1,
  loadMigrationManifest,
  type D1Like,
  type D1StatementLike,
  type SqlDatabase,
} from "@bfb/db";
import {
  DomainError,
  bumpMemberEpoch,
  getGitHubStatus,
  loadPrincipal,
  randomUlid,
  type GitHubStatusView,
  type TaskAccessContext,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const observedAt = "2026-08-15T12:00:00.000Z";
const unavailable = { code: "forbidden", message: "github status is unavailable" };
const server = createTestHarness({
  root,
  workers: [{ configPath: "tools/work-records/wrangler-hub.toml" }],
});

// A typed extra argument is ignored by OLD's two-argument implementation. No
// fixed-only export or fabricated outcome is needed for the original-source probe.
const readStatus: (
  db: SqlDatabase,
  workspaceId: string,
  access?: TaskAccessContext,
) => Promise<GitHubStatusView> = getGitHubStatus;

type Snapshot = Record<string, Record<string, unknown>[]>;
interface Fixture {
  workspaceId: string;
  owner: string;
  member: string;
  reviewer: string;
  projectA: string;
  projectB: string;
  expected: GitHubStatusView;
}
interface Witness {
  phase: string;
  first_workspace_capture: boolean;
  independent_cut_applied: boolean;
  legacy_installations_selected: boolean;
  legacy_links_selected: boolean;
  fused_selection_started: boolean;
  native_reader_statements: number;
  replies: string[];
  canonical_unchanged_after_cut: boolean;
  http_budgets_unchanged: boolean;
  foreign_keys_clean: boolean;
  transient_guards_empty: boolean;
}
interface Cut {
  when: "before_status_selection" | "after_legacy_installations";
  apply(): Promise<void>;
}
const checks: Array<{ check: string; outcome: "passed" | "failed"; witness: Witness }> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };
let fixtureSequence = 0;

function instrumentedReader(binding: D1Like, witness: Witness, cut?: Cut): SqlDatabase {
  let changed = false;
  const isStatus = (sql: string) => /\bgithub_(?:app_installations|repository_links)\b/u.test(sql);
  const isFused = (sql: string) =>
    /\bgithub_app_installations\b/u.test(sql) && /\bgithub_repository_links\b/u.test(sql);
  async function applyCut() {
    assert(witness.first_workspace_capture, "the cut must follow actual workspace capture");
    witness.phase = "independent_cut";
    await cut!.apply();
    changed = true;
    witness.independent_cut_applied = true;
    witness.phase = "native_status_selection";
  }
  async function before(sql: string) {
    witness.native_reader_statements += 1;
    if (isFused(sql)) witness.fused_selection_started = true;
    if (
      cut &&
      !changed &&
      isStatus(sql) &&
      (cut.when === "before_status_selection" || isFused(sql))
    ) {
      await applyCut();
    }
  }
  async function after(sql: string) {
    if (isFused(sql)) return;
    if (/\bgithub_app_installations\b/u.test(sql)) {
      witness.legacy_installations_selected = true;
      // OLD really executes its installation selection before this independent
      // change. A fused reader receives the same change before native execution.
      if (cut?.when === "after_legacy_installations" && !changed) await applyCut();
    }
    if (/\bgithub_repository_links\b/u.test(sql)) witness.legacy_links_selected = true;
  }
  function wrap(native: D1StatementLike, sql: string): D1StatementLike {
    return {
      bind(...parameters) {
        bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
        assert(parameters.length <= 100, "instrumented reader bindings must remain bounded");
        // The original native object and exact argument order reach actual D1.
        return wrap(native.bind(...parameters), sql);
      },
      async first(column) {
        await before(sql);
        const result = await native.first(column);
        await after(sql);
        return result;
      },
      async all() {
        await before(sql);
        const result = await native.all();
        await after(sql);
        return result;
      },
      async run() {
        await before(sql);
        const result = await native.run();
        await after(sql);
        return result;
      },
    };
  }
  return adaptD1({
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "instrumented reader SQL must remain bounded");
      return wrap(binding.prepare(sql), sql);
    },
    batch: (statements) => binding.batch(statements),
  });
}

async function collect(check: string, run: (witness: Witness) => Promise<void>) {
  const witness: Witness = {
    phase: "setup",
    first_workspace_capture: false,
    independent_cut_applied: false,
    legacy_installations_selected: false,
    legacy_links_selected: false,
    fused_selection_started: false,
    native_reader_statements: 0,
    replies: [],
    canonical_unchanged_after_cut: false,
    http_budgets_unchanged: false,
    foreign_keys_clean: false,
    transient_guards_empty: false,
  };
  try {
    await run(witness);
    checks.push({ check, outcome: "passed", witness });
    console.log(JSON.stringify({ check, outcome: "passed" }));
  } catch (error) {
    checks.push({ check, outcome: "failed", witness });
    failures.push({
      check,
      phase: witness.phase,
      error_name: error instanceof Error ? error.name : "unknown_error",
    });
    // Error bodies, installation/link identifiers and private canaries stay out
    // of the collecting report even when an OLD equality assertion fails.
    console.log(JSON.stringify({ check, outcome: "failed" }));
  }
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  const allTables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of allTables) assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
  const engineNames = new Set(["sqlite_sequence", "_cf_KV", "_cf_METADATA", "d1_migrations"]);
  const engineExclusions = allTables
    .filter(({ name }) => engineNames.has(name))
    .map(({ name }) => name);
  const httpBudgetTable = "rate_limit_buckets";
  assert(allTables.some(({ name }) => name === httpBudgetTable));
  const tables = allTables.filter(({ name }) => !engineNames.has(name) && name !== httpBudgetTable);
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
  async function checkEffects(before: Snapshot, beforeBudgets: unknown[], witness: Witness) {
    witness.phase = "canonical_effects";
    const after = await snapshot();
    witness.canonical_unchanged_after_cut = JSON.stringify(after) === JSON.stringify(before);
    witness.http_budgets_unchanged =
      JSON.stringify(await budgets()) === JSON.stringify(beforeBudgets);
    witness.foreign_keys_clean = (await db.prepare("PRAGMA foreign_key_check").all()).length === 0;
    witness.transient_guards_empty = guardTables.every(({ name }) => after[name]?.length === 0);
    assert(
      witness.canonical_unchanged_after_cut,
      "status must preserve all canonical state after the cut",
    );
    assert(witness.http_budgets_unchanged, "direct status reads must not charge HTTP budgets");
    assert(witness.foreign_keys_clean, "independent fixtures must preserve foreign keys");
    assert(witness.transient_guards_empty, "reads must not retain transient guards");
  }

  async function fixture(empty = false): Promise<Fixture> {
    fixtureSequence += 1;
    const workspaceId = randomUlid();
    const owner = randomUlid();
    const member = randomUlid();
    const reviewer = randomUlid();
    const projectA = randomUlid();
    const projectB = randomUlid();
    await db
      .prepare(
        "INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version) VALUES (?,?,'global',?,1)",
      )
      .run(workspaceId, `synthetic-github-status-${fixtureSequence}`, observedAt);
    for (const [humanId, role] of [
      [owner, "owner"],
      [member, "member"],
      [reviewer, "reviewer"],
    ] as const) {
      await db
        .prepare("INSERT INTO humans (id,email,display_name,created_at) VALUES (?,?,?,?)")
        .run(
          humanId,
          `${humanId.toLowerCase()}@synthetic.test`,
          `Synthetic status ${role}`,
          observedAt,
        );
      await db
        .prepare(
          "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,?,1,?)",
        )
        .run(workspaceId, humanId, role, observedAt);
      await db
        .prepare(
          "INSERT INTO workspace_authorization_epochs (workspace_id,human_id,authorization_epoch,revoked_at,updated_at) VALUES (?,?,1,NULL,?)",
        )
        .run(workspaceId, humanId, observedAt);
    }
    for (const [projectId, slug] of [
      [projectA, "alpha"],
      [projectB, "beta"],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO projects
           (workspace_id,id,name,slug,tint,access_mode,resource_version,created_at)
           VALUES (?,?,?,?,?,'restricted',1,?)`,
        )
        .run(workspaceId, projectId, `Synthetic status ${slug}`, slug, "#10B981", observedAt);
      await db
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(workspaceId, projectId, owner);
    }
    for (const humanId of [member, reviewer]) {
      await db
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(workspaceId, projectA, humanId);
    }
    const expected: GitHubStatusView = { installations: [], links: [] };
    if (!empty) {
      // Explicit retained integration fixtures: no live App, credential, webhook
      // or now-held manual-link command is used to set up this read-only proof.
      for (const [index, projectId] of [projectA, projectB].entries()) {
        const installationId = String(900_000 + fixtureSequence * 10 + index);
        const repositoryId = String(800_000 + fixtureSequence * 10 + index);
        const linkId = randomUlid();
        const fullName = `synthetic/status-${index}`;
        const permissions = { metadata: "read", issues: "read" };
        const events = ["installation", "issues"];
        await db
          .prepare(
            `INSERT INTO github_app_installations
             (workspace_id,installation_id,app_id,app_slug,account_id,account_login,
              account_type,status,permissions_json,events_json,installed_by_human_id,
              created_at,updated_at,revoked_at,resource_version)
             VALUES (?,?,?,'synthetic-status-app',?,'SYNTHETIC_STATUS_ACCOUNT','Organization',
                     'active',?,?,?,?,?,NULL,3)`,
          )
          .run(
            workspaceId,
            installationId,
            "700001",
            "700002",
            JSON.stringify(permissions),
            JSON.stringify(events),
            owner,
            observedAt,
            observedAt,
          );
        await db
          .prepare(
            `INSERT INTO github_repository_links
             (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,
              link_state,created_at,closed_at,resource_version)
             VALUES (?,?,?,?,?,?,'main','active',?,NULL,2)`,
          )
          .run(workspaceId, linkId, repositoryId, installationId, projectId, fullName, observedAt);
        expected.installations.push({
          installation_id: installationId,
          app_slug: "synthetic-status-app",
          account_login: "SYNTHETIC_STATUS_ACCOUNT",
          status: "active",
          permissions,
          events,
          resource_version: 3,
        });
        expected.links.push({
          link_id: linkId,
          workspace_id: workspaceId,
          repository_id: repositoryId,
          installation_id: installationId,
          project_id: projectId,
          full_name: fullName,
          default_branch: "main",
          link_state: "active",
          resource_version: 2,
        });
        const closedId = randomUlid();
        await db
          .prepare(
            `INSERT INTO github_repository_links
             (workspace_id,id,repository_id,installation_id,project_id,full_name,default_branch,
              link_state,created_at,closed_at,resource_version)
             VALUES (?,?,?,?,?,?,'old-main','closed',?,?,1)`,
          )
          .run(
            workspaceId,
            closedId,
            repositoryId,
            installationId,
            projectId,
            fullName,
            observedAt,
            observedAt,
          );
      }
    }
    return { workspaceId, owner, member, reviewer, projectA, projectB, expected };
  }
  async function capture(f: Fixture, humanId: string, witness: Witness) {
    const principal = await loadPrincipal(db, f.workspaceId, humanId);
    witness.first_workspace_capture = true;
    assert.equal(
      principal.authorizationEpoch,
      1,
      "each collecting group starts with its own epoch",
    );
    return principal;
  }
  async function outcome(
    reader: SqlDatabase,
    f: Fixture,
    access: TaskAccessContext,
    witness: Witness,
  ) {
    witness.phase = "native_status_selection";
    try {
      const value = await readStatus(reader, f.workspaceId, access);
      witness.replies.push("success");
      return { ok: true as const, value };
    } catch (error) {
      witness.replies.push(error instanceof DomainError ? error.code : "reader_error");
      return { ok: false as const, error };
    }
  }
  function expectUnavailable(result: Awaited<ReturnType<typeof outcome>>, witness: Witness) {
    witness.phase = "expect_current_scope_denial";
    assert(!result.ok, "lost status authority must not deliver either array");
    assert(result.error instanceof DomainError, "scope denial must use the domain envelope");
    assert.equal(result.error.code, unavailable.code);
    assert.equal(result.error.message, unavailable.message);
  }

  await collect("owner_retains_exact_status_and_internal_fixture_reader", async (witness) => {
    const f = await fixture();
    const principal = await capture(f, f.owner, witness);
    const before = await snapshot();
    const beforeBudgets = await budgets();
    const reader = instrumentedReader(binding, witness);
    const result = await outcome(reader, f, principal, witness);
    const internal = await readStatus(reader, f.workspaceId);
    await checkEffects(before, beforeBudgets, witness);
    witness.phase = "expect_healthy_status";
    assert(result.ok);
    assert.deepEqual(result.value, f.expected);
    assert.deepEqual(internal, f.expected);
  });

  await collect("member_retains_workspace_wide_status_for_restricted_projects", async (witness) => {
    const f = await fixture();
    const principal = await capture(f, f.member, witness);
    assert(principal.projectIds.includes(f.projectA));
    assert(!principal.projectIds.includes(f.projectB));
    const before = await snapshot();
    const beforeBudgets = await budgets();
    const result = await outcome(instrumentedReader(binding, witness), f, principal, witness);
    await checkEffects(before, beforeBudgets, witness);
    witness.phase = "expect_healthy_status";
    assert(result.ok);
    assert.deepEqual(result.value, f.expected);
  });

  await collect("authorized_owner_and_member_empty_status_remains_useful", async (witness) => {
    const f = await fixture(true);
    const before = await snapshot();
    const beforeBudgets = await budgets();
    for (const humanId of [f.owner, f.member]) {
      const principal = await capture(f, humanId, witness);
      const result = await outcome(instrumentedReader(binding, witness), f, principal, witness);
      assert(result.ok);
      assert.deepEqual(result.value, { installations: [], links: [] });
    }
    await checkEffects(before, beforeBudgets, witness);
  });

  await collect("reviewer_status_denied_without_read_effects", async (witness) => {
    // This tests the retained domain selector directly. The browser's existing
    // admission gate already rejects Reviewer, so it is not a new ingress proof.
    const f = await fixture();
    const principal = await capture(f, f.reviewer, witness);
    const before = await snapshot();
    const beforeBudgets = await budgets();
    const result = await outcome(instrumentedReader(binding, witness), f, principal, witness);
    await checkEffects(before, beforeBudgets, witness);
    expectUnavailable(result, witness);
  });

  for (const loss of [
    "epoch",
    "removal",
    "demotion",
    "empty_epoch",
    "revoked_reinstatement",
  ] as const) {
    await collect(`late_${loss}_withholds_both_status_arrays`, async (witness) => {
      const f = await fixture(loss === "empty_epoch");
      const principal = await capture(f, f.member, witness);
      let afterCut: Snapshot | undefined;
      let afterBudgets: unknown[] | undefined;
      const reader = instrumentedReader(binding, witness, {
        when: "before_status_selection",
        async apply() {
          if (loss === "epoch" || loss === "empty_epoch") {
            assert.equal(await bumpMemberEpoch(db, f.workspaceId, f.member), 2);
          } else if (loss === "removal") {
            // The membership FK requires its mutable project grant to be removed
            // first. Neither retained integration history nor identity is erased.
            assert.equal(
              (
                await db
                  .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
                  .run(f.workspaceId, f.member)
              ).changes,
              1,
            );
            assert.equal(
              (
                await db
                  .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
                  .run(f.workspaceId, f.member)
              ).changes,
              1,
            );
            assert.equal(
              await db
                .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND human_id=?")
                .get(f.workspaceId, f.member),
              null,
            );
          } else if (loss === "demotion") {
            // Role-only isolation is an explicit synthetic cut, not a claim
            // that the service's role-change command leaves its epoch unchanged.
            assert.equal(
              (
                await db
                  .prepare(
                    "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
                  )
                  .run(f.workspaceId, f.member)
              ).changes,
              1,
            );
            assert.deepEqual(
              await db
                .prepare(
                  "SELECT role,authorization_epoch FROM workspace_members WHERE workspace_id=? AND human_id=?",
                )
                .get(f.workspaceId, f.member),
              { role: "reviewer", authorization_epoch: 1 },
            );
          } else {
            // Synthetic same-epoch reinstatement cannot un-revoke the retained
            // epoch. This is not a bypass of the real membership service.
            assert.equal(
              (
                await db
                  .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
                  .run(f.workspaceId, f.member)
              ).changes,
              1,
            );
            assert.equal(
              (
                await db
                  .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
                  .run(f.workspaceId, f.member)
              ).changes,
              1,
            );
            assert.equal(
              (
                await db
                  .prepare(
                    "UPDATE workspace_authorization_epochs SET revoked_at=?,updated_at=? WHERE workspace_id=? AND human_id=? AND authorization_epoch=1",
                  )
                  .run(observedAt, observedAt, f.workspaceId, f.member)
              ).changes,
              1,
            );
            await db
              .prepare(
                "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'member',1,?)",
              )
              .run(f.workspaceId, f.member, observedAt);
            await db
              .prepare(
                "INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)",
              )
              .run(f.workspaceId, f.projectA, f.member);
            assert.deepEqual(
              await db
                .prepare(
                  `SELECT member.role,member.authorization_epoch,epoch.revoked_at
               FROM workspace_members AS member JOIN workspace_authorization_epochs AS epoch
                 ON epoch.workspace_id=member.workspace_id AND epoch.human_id=member.human_id
               WHERE member.workspace_id=? AND member.human_id=?`,
                )
                .get(f.workspaceId, f.member),
              { role: "member", authorization_epoch: 1, revoked_at: observedAt },
            );
          }
          afterCut = await snapshot();
          afterBudgets = await budgets();
        },
      });
      const result = await outcome(reader, f, principal, witness);
      assert(witness.independent_cut_applied, "the real native reader must reach the cut");
      assert(afterCut && afterBudgets);
      await checkEffects(afterCut, afterBudgets, witness);
      expectUnavailable(result, witness);
    });
  }

  await collect("installation_and_active_links_are_one_current_projection", async (witness) => {
    const f = await fixture();
    const principal = await capture(f, f.member, witness);
    const retained = f.expected.installations[0]!;
    const link = f.expected.links[0]!;
    let afterCut: Snapshot | undefined;
    let afterBudgets: unknown[] | undefined;
    const reader = instrumentedReader(binding, witness, {
      when: "after_legacy_installations",
      async apply() {
        // Canonical mutable source rows change independently; their retained
        // history is not deleted and no webhook/reconcile policy is altered.
        assert.equal(
          (
            await db
              .prepare(
                `UPDATE github_app_installations SET status='revoked',account_login='SYNTHETIC_CURRENT_ACCOUNT',
             resource_version=resource_version+1,revoked_at=?,updated_at=?
           WHERE workspace_id=? AND installation_id=?`,
              )
              .run(observedAt, observedAt, f.workspaceId, retained.installation_id)
          ).changes,
          1,
        );
        assert.equal(
          (
            await db
              .prepare(
                `UPDATE github_repository_links SET link_state='closed',closed_at=?,resource_version=resource_version+1
           WHERE workspace_id=? AND id=? AND link_state='active'`,
              )
              .run(observedAt, f.workspaceId, link.link_id)
          ).changes,
          1,
        );
        assert.deepEqual(
          await db
            .prepare(
              "SELECT status,account_login,resource_version FROM github_app_installations WHERE workspace_id=? AND installation_id=?",
            )
            .get(f.workspaceId, retained.installation_id),
          { status: "revoked", account_login: "SYNTHETIC_CURRENT_ACCOUNT", resource_version: 4 },
        );
        assert.deepEqual(
          await db
            .prepare(
              "SELECT link_state,resource_version FROM github_repository_links WHERE workspace_id=? AND id=?",
            )
            .get(f.workspaceId, link.link_id),
          { link_state: "closed", resource_version: 3 },
        );
        afterCut = await snapshot();
        afterBudgets = await budgets();
      },
    });
    const result = await outcome(reader, f, principal, witness);
    assert(witness.independent_cut_applied, "a native source-selection seam must be reached");
    assert(afterCut && afterBudgets);
    await checkEffects(afterCut, afterBudgets, witness);
    witness.phase = "expect_coherent_current_projection";
    assert(result.ok);
    assert.deepEqual(result.value, {
      installations: [
        {
          ...retained,
          status: "revoked",
          account_login: "SYNTHETIC_CURRENT_ACCOUNT",
          resource_version: 4,
        },
        f.expected.installations[1],
      ],
      links: [f.expected.links[1]],
    });
  });

  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "github_status_delivery",
      migration_head: manifest.migration_head,
      checks,
      failures,
      bounds,
      canonical_table_count: tables.length,
      excluded_snapshot_tables: engineExclusions,
      http_budget_tables: [httpBudgetTable],
      measured_scope:
        "direct native domain status statements only; setup, captures, cuts and snapshots excluded",
      limitations: [
        "Retained domain authority is captured directly, not browser cookie/CLI/OAuth ingress.",
        "Integration history, role isolation and membership reinstatement are explicitly synthetic fixtures.",
        "Worker/DO-internal SQL, webhook/reconcile/remap policy and natural browser-session expiry are not measured or certified.",
        "Private activation, provider/runner operation, live GitHub and deployment are excluded.",
      ],
      outcome: failures.length === 0 ? "passed" : "failed",
    }),
  );
  assert.equal(failures.length, 0, "native GitHub status delivery groups must pass");
  console.log("C11_GITHUB_STATUS_DELIVERY_D1_OK");
} finally {
  await server.close();
}
