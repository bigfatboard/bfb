// ABOUTME: Proves recipient-bound browser child positions against disposable native D1 and the production Hub.
// ABOUTME: Synthetic private fixtures isolate capture, authority and atomic issuance without provider or pilot operation.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  createHumanTaskCollectionPosition,
  hashHumanTaskCollectionPosition,
  issueHumanTaskCollectionPositionCommand,
  loadPrincipal,
  randomUlid,
  readHumanTaskCollectionPage,
  seedSyntheticWorkspace,
  WorkspaceHub,
  type AuthzPrincipal,
  type CommandOutcome,
  type IssueHumanTaskCollectionPositionInput,
  type PagedHumanTaskCollection,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const families: PagedHumanTaskCollection[] = ["comments", "dependencies", "links", "runs"];
const checks: Array<{ check: string; outcome: "passed" | "failed" }> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0 };
const unknown = { code: "invalid_argument", message: "unknown task collection cursor" };

async function check(name: string, run: (phase: (value: string) => void) => Promise<void>) {
  let phase = "fixture";
  try {
    await run((value) => {
      phase = value;
    });
    checks.push({ check: name, outcome: "passed" });
  } catch (error) {
    checks.push({ check: name, outcome: "failed" });
    failures.push({
      check: name,
      phase,
      error_name: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Observe real statements; reads and batches retain the native adapter's behavior. */
function observe(source: SqlDatabase): SqlDatabase {
  return {
    prepare(sql) {
      bounds.maximum_statement_bytes = Math.max(
        bounds.maximum_statement_bytes,
        Buffer.byteLength(sql),
      );
      assert(Buffer.byteLength(sql) <= 100_000);
      const statement = source.prepare(sql);
      const parameters = (values: unknown[]) => {
        bounds.maximum_bindings = Math.max(bounds.maximum_bindings, values.length);
        assert(values.length <= 100);
      };
      return {
        get: (...values) => {
          parameters(values);
          return statement.get(...values);
        },
        all: (...values) => {
          parameters(values);
          return statement.all(...values);
        },
        run: (...values) => {
          parameters(values);
          return statement.run(...values);
        },
      };
    },
    withTransaction: (run) => source.withTransaction((tx) => run(observe(tx))),
  };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    measured = observe(db);
  await seedSyntheticWorkspace(db, new Date().toISOString(), "global");
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const { name } of tables)
      result[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
    return result;
  }
  async function unchanged<T>(run: () => Promise<T>) {
    const before = await snapshot(),
      result = await run();
    assert.deepEqual(await snapshot(), before);
    return result;
  }
  async function command<T>(
    name: string,
    input: unknown,
    humanId = FIX.member,
    lane = "a",
    retainedEpoch?: number,
  ) {
    const epoch =
      retainedEpoch ?? (await loadPrincipal(db, FIX.workspace, humanId)).authorizationEpoch;
    const response = await server
      .getWorker(`bfb-work-records-${lane}`)
      .fetch(`https://bfb.task-positions.test/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: name,
          request: {
            workspaceId: FIX.workspace,
            actorHumanId: humanId,
            authorizationEpoch: epoch,
            idempotencyKey: randomUlid(),
            input,
          },
        }),
      });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as CommandOutcome<T>;
    assert(outcome.ok, "native fixture command must succeed");
    return outcome.result;
  }
  const issue =
    (principal: AuthzPrincipal, lane = "a") =>
    async (input: IssueHumanTaskCollectionPositionInput) => {
      await command(
        issueHumanTaskCollectionPositionCommand.name,
        input,
        principal.humanId,
        lane,
        principal.authorizationEpoch,
      );
    };
  async function fixture(options: { private?: boolean } = {}) {
    const now = new Date().toISOString(),
      reviewerId = randomUlid();
    await db
      .prepare("INSERT INTO humans(id,email,display_name,created_at) VALUES (?,?,?,?)")
      .run(
        reviewerId,
        `${reviewerId}@task-position.synthetic.test`,
        "Synthetic position Reviewer",
        now,
      );
    await db
      .prepare(
        "INSERT INTO workspace_members(workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'reviewer',1,?)",
      )
      .run(FIX.workspace, reviewerId, now);
    await db
      .prepare(
        "INSERT INTO workspace_authorization_epochs(workspace_id,human_id,authorization_epoch,revoked_at,updated_at) VALUES (?,?,1,NULL,?)",
      )
      .run(FIX.workspace, reviewerId, now);
    await db
      .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectA, reviewerId);
    const task = await command<TaskRecord>("task.create", {
      projectId: FIX.projectA,
      title: "Synthetic position parent",
      priority: "P2",
    });
    const targets: TaskRecord[] = [];
    for (let index = 0; index < 5; index++)
      targets.push(
        await command<TaskRecord>("task.create", {
          projectId: FIX.projectA,
          title: "Synthetic position dependency",
          priority: "P2",
        }),
      );
    targets.sort((a, b) => a.id.localeCompare(b.id));
    const unusedTarget = targets.splice(2, 1)[0]!;
    for (let index = 0; index < 4; index++) {
      await command("comment.add", {
        taskId: task.id,
        body: "Synthetic position comment",
        kind: "discussion",
      });
      await command("task.link.add", {
        taskId: task.id,
        kind: "external",
        label: "Synthetic link",
        url: `https://synthetic.invalid/position-${index}`,
      });
      await command("task.dependency.add", {
        taskId: task.id,
        dependsOnTaskId: targets[index]!.id,
      });
      // Explicit historical work-run fixtures are not executions or launch acceptance.
      await db
        .prepare(
          `INSERT INTO runs(workspace_id,id,project_id,task_id,requested_by_human_id,
        agent_profile_id,purpose,result_state,activity,resource_version,created_at)
        VALUES (?,?,?,?,?,?,'work','failed','unknown',1,?)`,
        )
        .run(FIX.workspace, randomUlid(), FIX.projectA, task.id, FIX.member, FIX.profileCodex, now);
    }
    const grantId = randomUlid();
    if (options.private !== false) {
      await db
        .prepare(
          "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, task.id, FIX.member, now);
      await db
        .prepare(
          "INSERT INTO task_human_grants(workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
        )
        .run(FIX.workspace, grantId, task.id, reviewerId, now);
    }
    return {
      task,
      targets,
      unusedTarget,
      grantId,
      viewer: await loadPrincipal(db, FIX.workspace, reviewerId),
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const page = (f: Fixture, family: PagedHumanTaskCollection, cursor?: string, limit = 2) =>
    readHumanTaskCollectionPage(
      measured,
      f.viewer,
      f.task.id,
      family,
      { limit, ...(cursor === undefined ? {} : { cursor }) },
      issue(f.viewer),
    );
  const identity = (family: PagedHumanTaskCollection, row: Record<string, unknown>) =>
    row[family === "dependencies" ? "depends_on_task_id" : "id"];
  async function revoke(f: Fixture) {
    await db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(new Date().toISOString(), FIX.workspace, f.grantId);
  }

  await check("four_collections_reviewer_capture_reuse_and_hash_only_storage", async (phase) => {
    const f = await fixture();
    for (const family of families) {
      phase(`${family}_root`);
      const before = await snapshot(),
        first = await page(f, family);
      assert(first && first.has_more && first.next_cursor && first.rows.length === 2);
      assert.match(first.next_cursor, /^[A-Za-z0-9_-]{43}$/);
      const after = await snapshot();
      for (const table of tables
        .map((entry) => entry.name)
        .filter(
          (name) =>
            ![
              "task_collection_positions",
              "task_collection_position_guards",
              "workspace_cursors",
              "semantic_events",
              "audit_events",
              "outbox_records",
              "idempotency_records",
            ].includes(name),
        ))
        assert.deepEqual(after[table], before[table]);
      assert(
        !JSON.stringify(after).includes(first.next_cursor),
        "plaintext position cannot be persisted",
      );
      const stored = (await db
        .prepare("SELECT * FROM task_collection_positions WHERE position_hash=?")
        .get(hashHumanTaskCollectionPosition(first.next_cursor))) as Record<string, unknown>;
      assert.equal(stored.human_id, f.viewer.humanId);
      assert.equal(stored.anchor_id, identity(family, first.rows.at(-1)!));
      phase(`${family}_terminal_and_reuse`);
      const next = await unchanged(() => page(f, family, first.next_cursor!));
      assert(next && !next.has_more && next.next_cursor === null && next.rows.length === 2);
      assert.deepEqual(await unchanged(() => page(f, family, first.next_cursor!)), next);
      phase(`${family}_descendant_inherits_fixed_capture_and_expiry`);
      const narrowRoot = await page(f, family, undefined, 1);
      assert(narrowRoot?.next_cursor);
      const rootPosition = await db
        .prepare(
          "SELECT capture_ceiling,expires_at FROM task_collection_positions WHERE position_hash=?",
        )
        .get(hashHumanTaskCollectionPosition(narrowRoot.next_cursor));
      const descendant = await page(f, family, narrowRoot.next_cursor, 1);
      assert(descendant?.next_cursor && descendant.has_more);
      assert.deepEqual(
        await db
          .prepare(
            "SELECT capture_ceiling,expires_at FROM task_collection_positions WHERE position_hash=?",
          )
          .get(hashHumanTaskCollectionPosition(descendant.next_cursor)),
        rootPosition,
      );
    }
  });

  await check("raw_foreign_and_drifted_audiences_reject_without_effects", async (phase) => {
    const f = await fixture(),
      other = await fixture();
    const first = await page(f, "comments");
    assert(first?.next_cursor);
    for (const cursor of [
      String(first.rows[0]!.id),
      "",
      "a".repeat(42),
      "a".repeat(44),
      createHumanTaskCollectionPosition(),
    ]) {
      phase("invalid_handle");
      await unchanged(() => assert.rejects(() => page(f, "comments", cursor), unknown));
    }
    phase("human_task_collection_and_limit_binding");
    await unchanged(() =>
      assert.rejects(() => page(other, "comments", first.next_cursor!), unknown),
    );
    await unchanged(() => assert.rejects(() => page(f, "links", first.next_cursor!), unknown));
    await unchanged(() =>
      assert.rejects(() => page(f, "comments", first.next_cursor!, 1), unknown),
    );
    phase("same_epoch_project_expansion_parent_still_readable");
    await db
      .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectB, f.viewer.humanId);
    await unchanged(() => assert.rejects(() => page(f, "comments", first.next_cursor!), unknown));
  });

  await check("dependency_insertion_ceiling_and_current_target_acl", async (phase) => {
    const f = await fixture({ private: false }),
      first = await page(f, "dependencies");
    assert(first?.next_cursor);
    phase("new_association_to_older_task_excluded");
    await command("task.dependency.add", { taskId: f.task.id, dependsOnTaskId: f.unusedTarget.id });
    const next = await unchanged(() => page(f, "dependencies", first.next_cursor!));
    assert(
      next &&
        next.rows.length === 2 &&
        !next.rows.some((row) => row.depends_on_task_id === f.unusedTarget.id),
    );
    phase("new_root_sees_new_association");
    const fresh = await page(f, "dependencies", undefined, 100);
    assert(fresh?.rows.some((row) => row.depends_on_task_id === f.unusedTarget.id));
    phase("hidden_target_before_lookahead");
    await db
      .prepare(
        "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.targets[3]!.id, FIX.member, new Date().toISOString());
    const visible = await unchanged(() => page(f, "dependencies", first.next_cursor!));
    assert(
      visible && visible.rows.length === 1 && !visible.has_more && visible.next_cursor === null,
    );
  });

  await check("native_batch_whole_selection_guard_rolls_back_issuance", async (phase) => {
    for (const index of [0, 2]) {
      const f = await fixture();
      let fired = false,
        afterMutation: Awaited<ReturnType<typeof snapshot>> | undefined;
      const cutBinding: D1Like = {
        prepare: (sql) => binding.prepare(sql),
        batch: async (statements) => {
          if (!fired) {
            fired = true;
            phase(index === 0 ? "nonanchor_delivered_target_lost" : "lookahead_target_lost");
            await db
              .prepare(
                "INSERT INTO task_privacy(workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
              )
              .run(FIX.workspace, f.targets[index]!.id, FIX.member, new Date().toISOString());
            afterMutation = await snapshot();
          }
          return binding.batch(statements);
        },
      };
      const localNativeHub = new WorkspaceHub(observe(adaptD1(cutBinding)));
      const outcome = await localNativeHub.execute(issueHumanTaskCollectionPositionCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: f.viewer.humanId,
        authorizationEpoch: f.viewer.authorizationEpoch,
        idempotencyKey: randomUlid(),
        input: {
          taskId: f.task.id,
          collection: "dependencies",
          limit: 2,
          capturedProjectIds: [...f.viewer.projectIds],
          afterHash: null,
          positionHash: hashHumanTaskCollectionPosition(createHumanTaskCollectionPosition()),
        },
      });
      assert(fired && afterMutation);
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      assert.deepEqual(await snapshot(), afterMutation);
    }
  });

  await check("four_actual_hub_reply_losses_retain_committed_positions", async (phase) => {
    for (const family of families) {
      const f = await fixture();
      let fired = false,
        retained: Awaited<ReturnType<typeof snapshot>> | undefined;
      phase(`${family}_after_actual_response_body`);
      const result = await readHumanTaskCollectionPage(
        measured,
        f.viewer,
        f.task.id,
        family,
        { limit: 2 },
        async (input) => {
          await issue(f.viewer, "b")(input);
          assert(
            await db
              .prepare("SELECT position_hash FROM task_collection_positions WHERE position_hash=?")
              .get(input.positionHash),
          );
          await revoke(f);
          fired = true;
          retained = await snapshot();
        },
      );
      assert(fired && retained);
      assert.equal(result, null);
      assert.deepEqual(await snapshot(), retained);
      assert.equal(await unchanged(() => page(f, family, "raw-invalid-position")), null);
    }
  });

  await check(
    "expired_anchor_and_epoch_loss_are_current_not_capability_authority",
    async (phase) => {
      const f = await fixture(),
        first = await page(f, "comments");
      assert(first?.next_cursor);
      phase("canonical_expired_position_fixture");
      const old = (await db
        .prepare("SELECT * FROM task_collection_positions WHERE position_hash=?")
        .get(hashHumanTaskCollectionPosition(first.next_cursor))) as Record<string, unknown>;
      const expired = createHumanTaskCollectionPosition();
      const row = {
        ...old,
        position_hash: hashHumanTaskCollectionPosition(expired),
        expires_at: "2026-01-01T00:00:00.000Z",
      };
      const keys = Object.keys(row);
      await db
        .prepare(
          `INSERT INTO task_collection_positions(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        )
        .run(...Object.values(row));
      await unchanged(() => assert.rejects(() => page(f, "comments", expired), unknown));
      phase("anchor_deletion_invalidates_without_history_rewrite");
      await db
        .prepare("DELETE FROM comments WHERE workspace_id=? AND id=?")
        .run(FIX.workspace, old.anchor_id);
      await unchanged(() => assert.rejects(() => page(f, "comments", first.next_cursor!), unknown));
      phase("membership_epoch_loss_denies_parent_first");
      await db
        .prepare(
          "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
        )
        .run(FIX.workspace, f.viewer.humanId);
      assert.equal(await unchanged(() => page(f, "comments", first.next_cursor!)), null);
    },
  );

  console.log(
    JSON.stringify({
      schema_version: 1,
      migration_head: loadMigrationManifest(resolve(root, "migrations/d1")).migration_head,
      checks,
      failures,
      bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "Disposable native D1 and registered production Hub; browser authentication is proved separately",
        "Historical work-run and private policy/grant rows are explicit synthetic fixtures, not launch or activation",
        "Guard races use the production domain Hub with real D1 batches; reply races traverse independent Worker/DO responses",
        "No provider, runner, cleanup, live pilot or deployment proof",
      ],
    }),
  );
  if (failures.length) process.exitCode = 1;
  else console.log("C11_TASK_COLLECTION_POSITIONS_D1_OK");
} finally {
  await server.close();
}
