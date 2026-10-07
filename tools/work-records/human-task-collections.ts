// ABOUTME: Proves human task child collections and parent-denial sentinels against disposable native D1.
// ABOUTME: Production Hub setup and explicit dormant privacy fixtures isolate final read authority without live execution.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  loadPrincipal,
  randomUlid,
  readHumanTaskCollection,
  seedSyntheticWorkspace,
  type CommandOutcome,
  type CreateRunResult,
  type HumanTaskCollection,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.human-task-collections.test";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const families: HumanTaskCollection[] = [
  "comments",
  "context",
  "agent_context",
  "dependencies",
  "links",
  "runs",
];
const source: Record<HumanTaskCollection, string> = {
  comments: "FROM comments AS comment",
  context: "FROM task_context_items AS item",
  agent_context: "FROM task_context_items AS item",
  dependencies: "FROM task_dependencies AS dependency",
  links: "FROM task_links AS link",
  runs: "FROM runs AS run",
};
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };
const checks: Array<{ check: string; outcome: "passed" | "failed" }> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const witnesses: Array<{ check: string; dimensions: Record<string, boolean> }> = [];

async function check(name: string, run: (phase: (value: string) => void) => Promise<void>) {
  let phase = "fixture";
  try {
    await run((value) => {
      phase = value;
    });
    checks.push({ check: name, outcome: "passed" });
  } catch (error) {
    checks.push({ check: name, outcome: "failed" });
    // Assertion messages can contain synthetic retained bodies; report classification only.
    failures.push({
      check: name,
      phase,
      error_name: error instanceof Error ? error.name : "unknown_error",
    });
  }
}

/** Ordinary binds return the real native statement; only the actual final read has a seam. */
function checkedBinding(
  binding: D1Like,
  seam?: { family: HumanTaskCollection; before: () => Promise<void> },
): D1Like {
  return {
    prepare(sql) {
      bounds.maximum_statement_bytes = Math.max(
        bounds.maximum_statement_bytes,
        Buffer.byteLength(sql),
      );
      assert(Buffer.byteLength(sql) <= 100_000, "collection SQL exceeds the checked byte bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "collection SQL exceeds the checked binding bound");
          const bound = native.bind(...parameters);
          if (
            !seam ||
            !sql.includes("WITH readable_parent AS MATERIALIZED") ||
            !sql.includes("AS parent_authorized") ||
            !sql.includes(source[seam.family])
          )
            return bound;
          return {
            bind: (...args) => bound.bind(...args),
            first: async (column) => {
              await seam.before();
              return bound.first(column);
            },
            all: async () => {
              await seam.before();
              return bound.all();
            },
            run: () => bound.run(),
          };
        },
        first: (column) => native.first(column),
        all: () => native.all(),
        run: () => native.run(),
      };
      return statement;
    },
    batch: (statements) => binding.batch(statements),
  };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    measuredDb = adaptD1(checkedBinding(binding));
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  await seedSyntheticWorkspace(db, new Date().toISOString(), "global");
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
     AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
     AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
  async function snapshot() {
    const rows: Record<string, unknown[]> = {};
    for (const { name } of tables)
      rows[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    return rows;
  }
  async function foreignKeys() {
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  }
  async function unchanged<T>(read: () => Promise<T>) {
    await foreignKeys();
    const before = await snapshot(),
      result = await read();
    assert.deepEqual(await snapshot(), before);
    await foreignKeys();
    return result;
  }
  async function command<T>(name: string, input: unknown) {
    const principal = await loadPrincipal(db, FIX.workspace, FIX.member);
    const response = await server
      .getWorker("bfb-work-records-a")
      .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: name,
          request: {
            workspaceId: FIX.workspace,
            actorHumanId: FIX.member,
            authorizationEpoch: principal.authorizationEpoch,
            idempotencyKey: randomUlid(),
            now: new Date().toISOString(),
            input,
          },
        }),
      });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as CommandOutcome<T>;
    assert(outcome.ok, "synthetic child setup must use a successful production command");
    return outcome.result;
  }
  async function fixture(options: { empty?: boolean; movable?: boolean } = {}) {
    // Fresh named Reviewers keep each independent revocation from contaminating later fixtures.
    const now = new Date().toISOString(),
      reviewerId = randomUlid();
    await db
      .prepare("INSERT INTO humans (id,email,display_name,created_at) VALUES (?,?,?,?)")
      .run(
        reviewerId,
        `${reviewerId}@task-collections.synthetic.test`,
        "Synthetic collection Reviewer",
        now,
      );
    await db
      .prepare(
        "INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'reviewer',1,?)",
      )
      .run(FIX.workspace, reviewerId, now);
    await db
      .prepare(
        "INSERT INTO workspace_authorization_epochs (workspace_id,human_id,authorization_epoch,revoked_at,updated_at) VALUES (?,?,1,NULL,?)",
      )
      .run(FIX.workspace, reviewerId, now);
    await db
      .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectA, reviewerId);
    const task = await command<TaskRecord>("task.create", {
      projectId: FIX.projectA,
      title: "Synthetic collection parent",
      priority: "P2",
    });
    const comments: Array<{ id: string; body: string; kind: string }> = [];
    const contexts: Array<{
      id: string;
      body: string;
      kind: string;
      audience: string;
      version: number;
      contentHash: string;
    }> = [];
    const links: Array<{ id: string; url: string; label: string }> = [];
    const dependencies: TaskRecord[] = [];
    let runId: string | undefined;
    if (!options.empty) {
      for (const kind of ["discussion", "progress"] as const) {
        const body = `Synthetic collection ${kind}`;
        comments.push({
          ...(await command<{ id: string }>("comment.add", { taskId: task.id, body, kind })),
          body,
          kind,
        });
      }
      for (const [audience, kind] of [
        ["human", "note"],
        ["agent", "constraint"],
        ["both", "acceptance"],
      ] as const) {
        const body = `Synthetic collection ${audience} context`;
        contexts.push({
          ...(await command<{ id: string; version: number; contentHash: string }>("context.add", {
            taskId: task.id,
            audience,
            kind,
            body,
          })),
          audience,
          kind,
          body,
        });
      }
      for (let index = 0; index < 2; index++) {
        const url = `https://synthetic.invalid/collection-${index}`,
          label = `Synthetic collection link ${index}`;
        links.push({
          ...(await command<{ id: string }>("task.link.add", {
            taskId: task.id,
            kind: "external",
            url,
            label,
          })),
          url,
          label,
        });
      }
      if (!options.movable) {
        for (const priority of ["P1", "P3"]) {
          const target = await command<TaskRecord>("task.create", {
            projectId: FIX.projectA,
            title: "Synthetic collection dependency",
            priority,
          });
          dependencies.push(target);
          await command("task.dependency.add", { taskId: task.id, dependsOnTaskId: target.id });
        }
        const created = await command<CreateRunResult>("run.create", {
          taskId: task.id,
          expectedTaskVersion: task.resource_version,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        });
        runId = created.run.id;
      }
    }
    // Explicit dormant policy/grant rows do not enable private creation or sharing.
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, now);
    const grantId = randomUlid();
    await db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
      )
      .run(FIX.workspace, grantId, task.id, reviewerId, now);
    const viewer = await loadPrincipal(db, FIX.workspace, reviewerId),
      creator = await loadPrincipal(db, FIX.workspace, FIX.member);
    assert.deepEqual(viewer.projectIds, [FIX.projectA]);
    await foreignKeys();
    return {
      task,
      reviewerId,
      grantId,
      viewer,
      creator,
      comments,
      contexts,
      links,
      dependencies,
      runId,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function lateDenial(f: Fixture, family: HumanTaskCollection, change: () => Promise<void>) {
    let fired = false,
      baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
    const finalDb = adaptD1(
      checkedBinding(binding, {
        family,
        before: async () => {
          assert(!fired, "only the exact final family selection may fire the seam");
          fired = true;
          await change();
          await foreignKeys();
          baseline = await snapshot();
        },
      }),
    );
    const result = await readHumanTaskCollection(finalDb, f.viewer, f.task.id, family, {
      limit: 1,
    });
    assert(
      fired && baseline,
      "the real bound final parent-and-child statement must observe the cut",
    );
    assert.deepEqual(await snapshot(), baseline);
    await foreignKeys();
    assert.equal(
      result,
      null,
      "late parent denial must not masquerade as an authorized empty page",
    );
  }

  await check("canonical_collections", async (phase) => {
    const f = await fixture();
    phase("creator_reviewer_fields_and_audience");
    await unchanged(async () => {
      const pages = new Map<HumanTaskCollection, Record<string, unknown>[]>();
      for (const family of families) {
        const rows = await readHumanTaskCollection(measuredDb, f.viewer, f.task.id, family);
        assert(rows);
        assert.deepEqual(
          await readHumanTaskCollection(measuredDb, f.creator, f.task.id, family),
          rows,
        );
        pages.set(family, rows);
      }
      const comments = pages.get("comments")!;
      assert.deepEqual(
        comments.map((row) => row.id),
        f.comments.map((row) => row.id).sort(),
      );
      for (const expected of f.comments) {
        const row = comments.find((item) => item.id === expected.id)!;
        assert.equal(row.body, expected.body);
        assert.equal(row.kind, expected.kind);
        assert.equal(row.author_human_id, FIX.member);
        assert.equal(row.author_kind, "human");
        for (const key of [
          "author_delegation_id",
          "author_run_id",
          "author_execution_id",
          "author_provider_session_id",
          "percent",
          "confidence",
        ])
          assert.equal(row[key], null);
        assert.equal(typeof row.created_at, "string");
      }
      assert.deepEqual(
        pages.get("context")!.map((row) => row.version),
        [1, 2, 3],
      );
      assert.deepEqual(
        pages.get("agent_context")!.map((row) => row.audience),
        ["agent", "both"],
      );
      for (const expected of f.contexts) {
        const row = pages.get("context")!.find((item) => item.id === expected.id)!;
        assert.equal(row.body, expected.body);
        assert.equal(row.kind, expected.kind);
        assert.equal(row.audience, expected.audience);
        assert.equal(row.content_hash, expected.contentHash);
      }
      for (const expected of f.links) {
        const row = pages.get("links")!.find((item) => item.id === expected.id)!;
        assert.equal(row.url, expected.url);
        assert.equal(row.label, expected.label);
        assert.equal(row.kind, "external");
      }
      for (const expected of f.dependencies) {
        const row = pages
          .get("dependencies")!
          .find((item) => item.depends_on_task_id === expected.id)!;
        assert.equal(row.title, expected.title);
        assert.equal(row.state, expected.state);
        assert.equal(row.priority, expected.priority);
      }
      const runs = pages.get("runs")!;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.id, f.runId);
      assert.equal(runs[0]!.task_id, f.task.id);
      assert.equal(runs[0]!.project_id, FIX.projectA);
      assert.equal(runs[0]!.requested_by_human_id, FIX.member);
      assert.equal(runs[0]!.agent_profile_id, FIX.profileCodex);
      assert.equal(runs[0]!.result_state, "open");
      assert.equal(runs[0]!.activity, "unknown");
      assert.equal(runs[0]!.resource_version, 1);
      assert.equal(typeof runs[0]!.created_at, "string");
      for (const family of ["comments", "dependencies", "links", "runs"] as const) {
        const full = pages.get(family)!,
          identity = family === "dependencies" ? "depends_on_task_id" : "id";
        const lookahead = await readHumanTaskCollection(measuredDb, f.viewer, f.task.id, family, {
          limit: 1,
        });
        assert.deepEqual(lookahead, full.slice(0, 2));
        assert.deepEqual(
          await readHumanTaskCollection(measuredDb, f.viewer, f.task.id, family, {
            limit: 1,
            cursor: full.at(-1)![identity] as string,
          }),
          [],
        );
      }
    });
    const empty = await fixture({ empty: true });
    phase("authorized_empty_sentinels");
    await unchanged(async () => {
      for (const family of families)
        assert.deepEqual(
          await readHumanTaskCollection(measuredDb, empty.viewer, empty.task.id, family),
          [],
        );
    });
    const hidden = [...f.dependencies].sort((a, b) => a.id.localeCompare(b.id))[0]!;
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, hidden.id, FIX.member, new Date().toISOString());
    phase("dependency_acl_before_limit_plus_one");
    await unchanged(async () => {
      const rows = await readHumanTaskCollection(measuredDb, f.viewer, f.task.id, "dependencies", {
        limit: 1,
      });
      assert(rows);
      assert.equal(rows.length, 1);
      assert.equal(
        rows[0]!.depends_on_task_id,
        f.dependencies.find((item) => item.id !== hidden.id)!.id,
      );
    });
    witnesses.push({
      check: "canonical_collections",
      dimensions: {
        creator_and_named_reviewer_read: true,
        fields_attribution_audience_and_order: true,
        empty_and_terminal_authorized: true,
        lookahead_and_target_acl_before_limit: true,
        complete_canonical_rows_and_foreign_keys_unchanged: true,
      },
    });
  });

  await check("six_late_grant_losses", async (phase) => {
    for (const family of families) {
      const f = await fixture();
      phase(`healthy_${family}`);
      const rows = await unchanged(() =>
        readHumanTaskCollection(measuredDb, f.viewer, f.task.id, family),
      );
      assert(rows && rows.length > 0);
      phase(`final_${family}`);
      await lateDenial(f, family, async () => {
        const now = new Date().toISOString();
        await db
          .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
          .run(now, FIX.workspace, f.grantId);
        assert.deepEqual(
          await db
            .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
            .get(FIX.workspace, f.grantId),
          { revoked_at: now },
        );
      });
    }
    witnesses.push({
      check: "six_late_grant_losses",
      dimensions: {
        all_six_native_final_family_seams_observed: true,
        independent_grant_revocation_retained: true,
        denied_parent_not_authorized_empty: true,
        complete_canonical_rows_and_foreign_keys_unchanged: true,
      },
    });
  });

  await check("current_epoch_project_membership", async (phase) => {
    for (const kind of ["epoch", "project", "membership"] as const) {
      if (kind === "membership")
        await db
          .prepare("UPDATE projects SET access_mode='workspace' WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, FIX.projectA);
      const f = await fixture({ empty: true });
      if (kind === "membership")
        await db
          .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
          .run(FIX.workspace, f.reviewerId);
      assert.deepEqual(
        await unchanged(() => readHumanTaskCollection(measuredDb, f.viewer, f.task.id, "links")),
        [],
      );
      phase(`final_${kind}_empty_page`);
      await lateDenial(f, "links", async () => {
        if (kind === "epoch") {
          await db
            .prepare(
              "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, f.reviewerId);
          await db
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch=2,updated_at=? WHERE workspace_id=? AND human_id=?",
            )
            .run(new Date().toISOString(), FIX.workspace, f.reviewerId);
          assert.equal(
            (await loadPrincipal(db, FIX.workspace, f.reviewerId)).authorizationEpoch,
            2,
          );
          assert.equal(f.viewer.authorizationEpoch, 1);
        } else if (kind === "project") {
          await db
            .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
            .run(FIX.workspace, f.reviewerId);
          assert.deepEqual((await loadPrincipal(db, FIX.workspace, f.reviewerId)).projectIds, []);
        } else {
          await db
            .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
            .run(FIX.workspace, f.reviewerId);
          assert.equal(
            await db
              .prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND human_id=?")
              .get(FIX.workspace, f.reviewerId),
            null,
          );
          assert.deepEqual(
            await db
              .prepare("SELECT access_mode FROM projects WHERE workspace_id=? AND id=?")
              .get(FIX.workspace, FIX.projectA),
            { access_mode: "workspace" },
          );
        }
      });
    }
    witnesses.push({
      check: "current_epoch_project_membership",
      dimensions: {
        genuine_load_principal_captured_before_each_cut: true,
        current_epoch_project_and_membership_loss: true,
        empty_page_sentinel_denies: true,
        complete_canonical_rows_and_foreign_keys_unchanged: true,
      },
    });
  });

  await check("captured_project_ceiling", async (phase) => {
    const f = await fixture({ movable: true });
    const healthy = await unchanged(() =>
      readHumanTaskCollection(measuredDb, f.viewer, f.task.id, "comments"),
    );
    assert(healthy && healthy.length === 2);
    phase("final_move_and_new_project_grant");
    await lateDenial(f, "comments", async () => {
      // No run/dependency composite FK exists on this movable fixture; history is retained.
      await db
        .prepare("UPDATE tasks SET project_id=? WHERE workspace_id=? AND id=?")
        .run(FIX.projectB, FIX.workspace, f.task.id);
      await db
        .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, FIX.projectB, f.reviewerId);
      assert.deepEqual(
        await db
          .prepare("SELECT project_id FROM tasks WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.task.id),
        { project_id: FIX.projectB },
      );
      assert(
        (await loadPrincipal(db, FIX.workspace, f.reviewerId)).projectIds.includes(FIX.projectB),
      );
      assert.deepEqual(f.viewer.projectIds, [FIX.projectA]);
    });
    phase("fresh_current_scope_positive_control");
    const current = await loadPrincipal(db, FIX.workspace, f.reviewerId);
    assert.deepEqual(
      await unchanged(() => readHumanTaskCollection(measuredDb, current, f.task.id, "comments")),
      healthy,
    );
    witnesses.push({
      check: "captured_project_ceiling",
      dimensions: {
        foreign_key_clean_parent_move_and_new_project_grant: true,
        original_project_vector_not_widened: true,
        genuinely_new_current_principal_reads_retained_rows: true,
        complete_canonical_rows_and_foreign_keys_unchanged: true,
      },
    });
  });

  console.log(
    JSON.stringify({
      schema_version: 1,
      migration_head: manifest.migrations.at(-1)?.id ?? "unknown",
      checks,
      failures,
      witnesses,
      bounds,
      outcome: failures.length === 0 ? "passed" : "failed",
      limits: [
        "Four independently collected groups prove final domain parent-and-child selection against disposable native D1",
        "Task, child and work-run setup uses production Hub commands; named Reviewer and dormant privacy/grant rows are explicit fixtures",
        "No browser/CLI authentication, provider, runner, execution, clock, lease, cleanup, private activation or live safety certificate",
      ],
    }),
  );
  if (failures.length === 0 && checks.length === 4) console.log("C11_HUMAN_TASK_COLLECTION_D1_OK");
  else process.exitCode = 1;
} finally {
  await server.close();
}
