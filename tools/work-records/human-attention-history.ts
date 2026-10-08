// ABOUTME: Proves complete historical attention lineage in human and CLI selections against disposable native D1.
// ABOUTME: Synthetic ended assignments and retained history exercise read-only delivery without provider or runner activity.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like, type D1StatementLike } from "@bfb/db";
import {
  FIX,
  cliHash,
  getAttention,
  getHumanAttentionDetail,
  listAttention,
  listAttentionObservations,
  loadPrincipal,
  randomUlid,
  readCliAttention,
  readCliAttentionDetail,
  seedSyntheticWorkspace,
  type AttentionObservation,
  type AttentionRecord,
  type CommandOutcome,
  type CreateRunResult,
  type PublicBusinessAuthority,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.human-attention-history.test";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-b.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
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
    // Assertion messages may contain retained bodies; report classification only.
    failures.push({
      check: name,
      phase,
      error_name: error instanceof Error ? error.name : "unknown_error",
    });
  }
  console.log(JSON.stringify(checks.at(-1)));
}

/** Normal binds return the real native statement; a read-only seam wraps that bound statement. */
function checkedBinding(binding: D1Like, beforeDetail?: () => Promise<void>): D1Like {
  return {
    prepare(sql) {
      const bytes = Buffer.byteLength(sql);
      bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
      assert(bytes <= 100_000, "attention SQL exceeds the checked statement bound");
      const native = binding.prepare(sql);
      const statement: D1StatementLike = {
        bind(...parameters) {
          bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
          assert(parameters.length <= 100, "attention SQL exceeds the checked binding bound");
          const bound = native.bind(...parameters);
          if (!beforeDetail || !sql.includes("LEFT JOIN attention_observations")) return bound;
          return {
            bind: (...args) => bound.bind(...args),
            first: async (column) => {
              await beforeDetail();
              return bound.first(column);
            },
            all: async () => {
              await beforeDetail();
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

interface HistoricalWork {
  taskId: string;
  projectId: string;
  runId: string;
  executionId: string;
  generation: number;
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
    const principal = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const response = await server
      .getWorker("bfb-work-records-a")
      .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: name,
          request: {
            workspaceId: FIX.workspace,
            actorHumanId: FIX.owner,
            authorizationEpoch: principal.authorizationEpoch,
            idempotencyKey: randomUlid(),
            now: new Date().toISOString(),
            input,
          },
        }),
      });
    assert.equal(response.status, 200);
    const outcome = (await response.json()) as CommandOutcome<T>;
    assert(outcome.ok, "synthetic task/run setup must use a successful production command");
    return outcome.result;
  }

  async function fixture() {
    async function work(label: string) {
      const task = await command<TaskRecord>("task.create", {
        projectId: FIX.projectA,
        title: `Synthetic attention history ${label}`,
        priority: "P2",
      });
      const created = await command<CreateRunResult>("run.create", {
        taskId: task.id,
        expectedTaskVersion: task.resource_version,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      });
      return { task, runId: created.run.id };
    }
    const shared = await work("shared"),
      hidden = await work("private");
    const clock = (await db
      .prepare(
        "SELECT COUNT(*) AS count,MAX(created_at) AS base FROM runs WHERE workspace_id=? AND id IN (?,?)",
      )
      .get(FIX.workspace, shared.runId, hidden.runId)) as { count: number; base: string };
    assert.equal(clock.count, 2);
    const base = Date.parse(clock.base);
    assert(Number.isFinite(base));
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const viewer = await loadPrincipal(db, FIX.workspace, FIX.member),
      sponsor = await loadPrincipal(db, FIX.workspace, FIX.owner),
      runnerId = randomUlid(),
      thumbprint = `synthetic-attention-history-${runnerId}`;
    await db
      .prepare(
        `INSERT INTO runners (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,
       authorization_epoch,grant_epoch,token_epoch,enrolled_at,revoked_at)
       VALUES (?,?,?,'Synthetic dormant historical Mac','{}',?,1,1,1,?,?)`,
      )
      .run(FIX.workspace, runnerId, FIX.owner, thumbprint, at(0), at(240));
    async function ended(source: typeof shared, generation: number): Promise<HistoricalWork> {
      const executionId = randomUlid();
      const startedAt = at(generation === 1 ? 0 : 180),
        endedAt = at(generation === 1 ? 150 : 240);
      // Synthetic historical source only: no launch, lease, runner grant or process.
      await db
        .prepare(
          `INSERT INTO run_executions (workspace_id,id,run_id,state,end_reason,resource_version,created_at,ended_at)
         VALUES (?,?,?,'ended','process_exit',1,?,?)`,
        )
        .run(FIX.workspace, executionId, source.runId, startedAt, endedAt);
      await db
        .prepare(
          `INSERT INTO execution_assignments (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,
         runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,
         runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)`,
        )
        .run(
          FIX.workspace,
          executionId,
          generation,
          source.runId,
          source.task.id,
          source.task.project_id,
          runnerId,
          randomUlid(),
          `sha256:${"c".repeat(64)}`,
          FIX.owner,
          sponsor.authorizationEpoch,
          thumbprint,
          startedAt,
        );
      return {
        taskId: source.task.id,
        projectId: source.task.project_id,
        runId: source.runId,
        executionId,
        generation,
      };
    }
    const readable = await ended(shared, 1),
      privateWork = await ended(hidden, 1);
    await ended(shared, 2);
    await db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, privateWork.taskId, FIX.owner, at(0));
    assert.equal(readable.projectId, privateWork.projectId);
    assert.notEqual(viewer.humanId, FIX.owner);

    const authUserId = randomUlid(),
      bindingId = randomUlid(),
      scopes = ["bfb:read", "bfb:task:write"];
    // A persisted synthetic exchanged binding is checked by the real final CLI SQL; no raw key is minted.
    await db
      .prepare(
        `INSERT INTO better_auth_users (id,name,email,email_verified,image,created_at,updated_at)
       VALUES (?,'Synthetic historical reader',?,1,NULL,?,?)`,
      )
      .run(authUserId, `${authUserId.toLowerCase()}@synthetic.test`, at(0), at(0));
    await db
      .prepare(
        `INSERT INTO api_key_bindings (workspace_id,id,principal_type,human_id,auth_user_id,device_code_hash,
       key_hash,key_prefix,scopes_json,project_ids_json,authorization_epoch,expires_at,exchanged_at,created_at)
       VALUES (?,?,'human',?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),?,?)`,
      )
      .run(
        FIX.workspace,
        bindingId,
        viewer.humanId,
        authUserId,
        cliHash(randomUlid()),
        cliHash(randomUlid()),
        "bfb_h_000000",
        JSON.stringify(scopes),
        JSON.stringify([FIX.projectA]),
        viewer.authorizationEpoch,
        at(0),
        at(0),
      );
    const cli: PublicBusinessAuthority = {
      ...viewer,
      projectIds: [FIX.projectA],
      credential: { kind: "cli", bindingId, scopes },
    };

    async function attention(
      declared: HistoricalWork,
      retained: HistoricalWork,
      options: {
        empty?: boolean;
        open?: boolean;
        blocker?: boolean;
      } = {},
    ) {
      const id = randomUlid(),
        resolved = !options.open,
        requestedAt = at(60),
        answeredAt = resolved ? at(90) : null,
        resolvedAt = resolved ? at(120) : null;
      const record: AttentionRecord = {
        id,
        project_id: declared.projectId,
        task_id: declared.taskId,
        run_id: declared.runId,
        run_execution_id: retained.executionId,
        assignment_generation: retained.generation,
        kind: options.blocker ? "blocker" : "clarification",
        required_role: options.blocker ? "member" : "reviewer",
        reference_kind: null,
        reference_id: null,
        question: "SYNTHETIC-HUMAN-ATTENTION-HISTORY-QUESTION",
        blocking: options.blocker ?? false,
        state: resolved ? "resolved" : "open",
        answer: resolved ? "SYNTHETIC-HUMAN-ATTENTION-HISTORY-ANSWER" : null,
        answered_by_human_id: resolved ? FIX.owner : null,
        requested_at: requestedAt,
        first_response_at: answeredAt,
        answered_at: answeredAt,
        resolved_at: resolvedAt,
        resource_version: resolved ? 3 : 1,
      };
      await db
        .prepare(
          `INSERT INTO attention_requests (workspace_id,id,project_id,task_id,run_id,run_execution_id,assignment_generation,
         kind,required_role,question,blocking,state,answer,answered_by_human_id,requested_at,first_response_at,
         answered_at,resolved_at,resource_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          id,
          record.project_id,
          record.task_id,
          record.run_id,
          record.run_execution_id,
          record.assignment_generation,
          record.kind,
          record.required_role,
          record.question,
          Number(record.blocking),
          record.state,
          record.answer,
          record.answered_by_human_id,
          requestedAt,
          answeredAt,
          answeredAt,
          resolvedAt,
          record.resource_version,
        );
      const observations: AttentionObservation[] = [];
      if (!options.empty) {
        const transitions: Array<{ kind: AttentionObservation["observed_kind"]; at: string }> = [
          { kind: "requested", at: requestedAt },
          ...(answeredAt ? [{ kind: "answered" as const, at: answeredAt }] : []),
          ...(resolvedAt ? [{ kind: "resolved" as const, at: resolvedAt }] : []),
        ];
        for (const transition of transitions) {
          const observation: AttentionObservation = {
            observation_id: randomUlid(),
            attention_id: id,
            observed_kind: transition.kind,
            actor_type: "human",
            actor_id: FIX.owner,
            occurred_at: transition.at,
          };
          await db
            .prepare(
              `INSERT INTO attention_observations (workspace_id,observation_id,attention_id,observed_kind,actor_type,actor_id,occurred_at)
             VALUES (?,?,?,?,?,?,?)`,
            )
            .run(
              FIX.workspace,
              observation.observation_id,
              id,
              observation.observed_kind,
              observation.actor_type,
              observation.actor_id,
              observation.occurred_at,
            );
          observations.push(observation);
        }
      }
      return { record, observations };
    }
    const canonical = await attention(readable, readable),
      empty = await attention(readable, readable, { empty: true });
    const privateAttention = await attention(privateWork, privateWork);
    await foreignKeys();
    return {
      viewer,
      cli,
      bindingId,
      readable,
      privateWork,
      canonical,
      empty,
      privateAttention,
      attention,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function projections(f: Fixture, id: string) {
    let cliDetail;
    try {
      cliDetail = await readCliAttentionDetail(measuredDb, f.cli, id);
    } catch (error) {
      assert(error instanceof Error && "code" in error && error.code === "not_found");
      cliDetail = { error: "not_found" };
    }
    return {
      body: await getAttention(measuredDb, FIX.workspace, [FIX.projectA], id, f.viewer),
      detail: await getHumanAttentionDetail(
        measuredDb,
        FIX.workspace,
        [FIX.projectA],
        id,
        f.viewer,
      ),
      observations: await listAttentionObservations(
        measuredDb,
        FIX.workspace,
        [FIX.projectA],
        id,
        f.viewer,
      ),
      inbox: await listAttention(
        measuredDb,
        FIX.workspace,
        [FIX.projectA],
        { state: "resolved", limit: 100 },
        f.viewer,
      ),
      cliInbox: await readCliAttention(measuredDb, f.cli, { state: "resolved", limit: 100 }),
      cliDetail,
    };
  }
  function assertCanonical(f: Fixture, value: Awaited<ReturnType<typeof projections>>) {
    assert.deepEqual(value.body, f.canonical.record);
    assert.deepEqual(value.detail, {
      attention: f.canonical.record,
      observations: f.canonical.observations,
    });
    assert.deepEqual(value.observations, f.canonical.observations);
    assert.deepEqual(value.cliDetail, {
      attention: f.canonical.record,
      observations: f.canonical.observations,
    });
    assert(value.inbox.some((row) => row.id === f.canonical.record.id));
    assert(value.cliInbox.attention.some((row) => row.id === f.canonical.record.id));
  }

  await check("canonical_ended_earlier_generation_resolved_and_empty_history", async (phase) => {
    const f = await fixture();
    phase("canonical_projection");
    const canonical = await unchanged(() => projections(f, f.canonical.record.id));
    assertCanonical(f, canonical);
    const empty = await unchanged(() => projections(f, f.empty.record.id));
    assert.deepEqual(empty.detail, { attention: f.empty.record, observations: [] });
    assert.deepEqual(empty.cliDetail, { attention: f.empty.record, observations: [] });
    assert.deepEqual(empty.observations, []);
    const hidden = await unchanged(() => projections(f, f.privateAttention.record.id));
    assert.equal(hidden.body, null);
    assert.equal(hidden.detail, null);
    assert.deepEqual(hidden.observations, []);
    assert.deepEqual(hidden.cliDetail, { error: "not_found" });
    witnesses.push({
      check: "canonical_history",
      dimensions: {
        ended_earlier_generation_readable: true,
        resolved_history_readable: true,
        authorized_empty_history_readable: true,
        same_project_private_parent_denied: true,
      },
    });
  });

  await check(
    "shared_declaration_private_assignment_withheld_by_all_six_readers",
    async (phase) => {
      const f = await fixture();
      phase("canonical_baseline");
      const baseline = await unchanged(() => projections(f, f.canonical.record.id));
      assertCanonical(f, baseline);
      phase("malformed_fixture");
      const malformed = await f.attention(f.readable, f.privateWork);
      await foreignKeys();
      phase("malformed_projection");
      const denied = await unchanged(() => projections(f, malformed.record.id));
      assert.equal(denied.body, null);
      assert.equal(denied.detail, null);
      assert.deepEqual(denied.observations, []);
      assert.deepEqual(denied.cliDetail, { error: "not_found" });
      assert.deepEqual(denied.inbox, baseline.inbox);
      assert.deepEqual(denied.cliInbox, baseline.cliInbox);
      assert.deepEqual(await unchanged(() => projections(f, f.canonical.record.id)), baseline);
      witnesses.push({
        check: "all_six_readers",
        dimensions: {
          declared_shared_tuple_coherent: true,
          retained_private_tuple_fk_clean: true,
          body_history_origin_withheld: true,
          complete_inbox_projections_unchanged: true,
        },
      });
    },
  );

  await check("malformed_blocker_filtered_before_both_limit_one_inboxes", async (phase) => {
    const f = await fixture(),
      valid = await f.attention(f.readable, f.readable, { open: true });
    const inboxes = () =>
      Promise.all([
        listAttention(
          measuredDb,
          FIX.workspace,
          [FIX.projectA],
          { state: "open", limit: 1 },
          f.viewer,
        ),
        readCliAttention(measuredDb, f.cli, { state: "open", limit: 1 }),
      ]);
    phase("canonical_limit_control");
    const baseline = await unchanged(inboxes);
    assert.equal(baseline[0][0]?.id, valid.record.id);
    assert.equal(baseline[1].attention[0]?.id, valid.record.id);
    phase("malformed_blocker_fixture");
    await f.attention(f.readable, f.privateWork, { open: true, blocker: true });
    phase("before_limit_selection");
    assert.deepEqual(await unchanged(inboxes), baseline);
  });

  await check("final_detail_lineage_and_current_narrowed_cli_empty_sentinel", async (phase) => {
    const f = await fixture();
    phase("healthy_final_selection_control");
    assertCanonical(f, await unchanged(() => projections(f, f.canonical.record.id)));
    let seamCount = 0;
    for (const transport of ["human", "cli"] as const) {
      const id = transport === "human" ? f.canonical.record.id : f.empty.record.id;
      let observed = false,
        baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
      const finalDb = adaptD1(
        checkedBinding(binding, async () => {
          if (observed) return;
          observed = true;
          // Only this disposable mutable request changes; both immutable assignments stay intact.
          await db
            .prepare(
              "UPDATE attention_requests SET run_execution_id=? WHERE workspace_id=? AND id=?",
            )
            .run(f.privateWork.executionId, FIX.workspace, id);
          await foreignKeys();
          baseline = await snapshot();
        }),
      );
      phase(`native_final_${transport}_detail_selection`);
      if (transport === "human")
        assert.equal(
          await getHumanAttentionDetail(finalDb, FIX.workspace, [FIX.projectA], id, f.viewer),
          null,
        );
      else
        await assert.rejects(readCliAttentionDetail(finalDb, f.cli, id), {
          code: "not_found",
          message: "resource not available",
        });
      assert(observed && baseline);
      assert.deepEqual(await snapshot(), baseline);
      await foreignKeys();
      seamCount += 1;
    }
    phase("authorized_empty_cli_control");
    assert.deepEqual(
      await unchanged(() => readCliAttention(measuredDb, f.cli, { state: "answered", limit: 1 })),
      { attention: [] },
    );
    const boundDetail = await f.attention(f.readable, f.readable, { empty: true });
    assert.deepEqual(
      await unchanged(() => readCliAttentionDetail(measuredDb, f.cli, boundDetail.record.id)),
      { attention: boundDetail.record, observations: [] },
    );
    await db
      .prepare("UPDATE api_key_bindings SET project_ids_json=? WHERE workspace_id=? AND id=?")
      .run(JSON.stringify([FIX.projectB]), FIX.workspace, f.bindingId);
    phase("current_binding_subset_selection");
    await unchanged(async () => {
      await assert.rejects(readCliAttention(measuredDb, f.cli, { state: "answered", limit: 1 }), {
        code: "not_found",
        message: "resource not available",
      });
      await assert.rejects(readCliAttentionDetail(measuredDb, f.cli, boundDetail.record.id), {
        code: "not_found",
        message: "resource not available",
      });
    });
    witnesses.push({
      check: "final_selection",
      dimensions: {
        original_scope_retained: true,
        native_bound_detail_seams_observed: seamCount === 2,
        independent_source_change_retained: true,
        empty_cli_page_requires_current_binding_subset: true,
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
        "Four independently collected groups prove direct human and CLI historical selections against disposable D1",
        "Task/run setup uses production Hub commands; ended executions, assignments, history and exchanged binding rows are fixture-only",
        "No mounted authentication, device exchange, provider, runner, lease, transition, private activation or live operation certificate",
      ],
    }),
  );
  if (failures.length === 0) console.log("C11_HUMAN_ATTENTION_HISTORY_D1_OK");
  else process.exitCode = 1;
} finally {
  await server.close();
}
