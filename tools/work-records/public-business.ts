// ABOUTME: Proves public task-business authority cuts over disposable native D1 and the production Hub.
// ABOUTME: Task/comment fixtures distinguish atomic rollback, historical cache denial and post-Hub reply withholding.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptD1,
  createAuthorizationContext,
  loadMigrationManifest,
  type D1Like,
  type D1StatementLike,
} from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  addCommentCommand,
  createTaskCommand,
  loadPrincipal,
  mcpResource,
  randomUlid,
  reportProgressCommand,
  revokeDelegation,
  seedSyntheticWorkspace,
  withPublicBusinessAuthority,
  type AddCommentInput,
  type CommandOutcome,
  type CommandRequest,
  type HubCommand,
  type PublicBusinessAuthority,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import type { HubClientDeps } from "../../apps/control-worker/dist/hub-client.js";
import { executePublicWorkspaceCommand } from "../../apps/control-worker/dist/public-command-outcome.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.public-business.test";
const canary = "SYNTHETIC-C11-PUBLIC-BUSINESS";
const historicalRequestTime = "2025-01-01T00:00:00.000Z";
const server = createTestHarness({
  root,
  workers: [
    { configPath: "tools/work-records/wrangler-a.toml" },
    { configPath: "tools/work-records/wrangler-hub.toml" },
  ],
});
const checks: string[] = [];
const failures: Array<{ check: string; message: string }> = [];
const seams: Array<Record<string, string | number | boolean>> = [];
const bounds = {
  maximum_bindings: 0,
  maximum_statement_bytes: 0,
  maximum_batch_statements: 0,
  maximum_check_bindings: 0,
};

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, outcome.ok ? undefined : outcome.error.code);
  return outcome.result;
}

async function check(name: string, run: () => Promise<void>) {
  try {
    await run();
    checks.push(name);
    console.log(JSON.stringify({ check: name, outcome: "passed" }));
  } catch (error) {
    const first = error instanceof Error ? error.message.split("\n")[0] : "assertion failed";
    failures.push({
      check: name,
      message: first?.includes(canary)
        ? "synthetic content omitted"
        : (first ?? "assertion failed").slice(0, 160),
    });
    console.log(JSON.stringify({ check: name, outcome: "failed" }));
  }
}

async function execute<T>(name: string, request: CommandRequest<unknown>) {
  const response = await server
    .getWorker("bfb-work-records-a")
    .fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandName: name, request }),
    });
  assert.equal(response.status, 200);
  return (await response.json()) as CommandOutcome<T>;
}

/** Write bind() returns the real native statement; only read first() receives a barrier. */
function checkedDb(
  binding: D1Like,
  hooks: {
    beforeBatch?: () => Promise<void>;
    afterCache?: () => Promise<void>;
    beforeFinal?: () => Promise<void>;
  } = {},
) {
  const state = { batch: false, cached: false, final: false, checkBindings: 0 };
  return {
    state,
    db: adaptD1({
      prepare(sql) {
        const bytes = Buffer.byteLength(sql);
        bounds.maximum_statement_bytes = Math.max(bounds.maximum_statement_bytes, bytes);
        assert(bytes <= 100_000, "public business SQL must fit D1's statement bound");
        const native = binding.prepare(sql);
        const cache = /^\s*SELECT\b/iu.test(sql) && sql.includes("FROM idempotency_records");
        const final = /^\s*SELECT\b/iu.test(sql) && sql.includes("FROM comments AS public_source");
        const statement: D1StatementLike = {
          bind(...parameters) {
            bounds.maximum_bindings = Math.max(bounds.maximum_bindings, parameters.length);
            assert(parameters.length <= 100, "public business SQL must fit D1's parameter bound");
            if (sql.includes("INSERT INTO artifact_mutation_guards")) {
              state.checkBindings = Math.max(state.checkBindings, parameters.length);
              bounds.maximum_check_bindings = Math.max(
                bounds.maximum_check_bindings,
                parameters.length,
              );
            }
            const bound = native.bind(...parameters);
            if (!cache && !final) return bound;
            return {
              bind: (...values) => bound.bind(...values),
              all: () => bound.all(),
              run: () => bound.run(),
              async first(column) {
                if (final) {
                  state.final = true;
                  await hooks.beforeFinal?.();
                }
                const row = await bound.first(column);
                if (cache && row != null && !state.cached) {
                  state.cached = true;
                  await hooks.afterCache?.();
                }
                return row;
              },
            };
          },
          first: (column) => native.first(column),
          all: () => native.all(),
          run: () => native.run(),
        };
        return statement;
      },
      async batch(statements) {
        assert.equal(state.batch, false, "one command flushes one atomic batch");
        state.batch = true;
        bounds.maximum_batch_statements = Math.max(
          bounds.maximum_batch_statements,
          statements.length,
        );
        assert(statements.length <= 32, "public business command retains a bounded batch");
        await hooks.beforeBatch?.();
        return binding.batch(statements);
      },
    }),
  };
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-work-records-hub");
  await worker.applyD1Migrations("DB");
  const binding = ((await worker.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding),
    independent = adaptD1(binding);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  // Both the proxy and public HubClient resolve the same global test DO, not two jurisdictional objects.
  await seedSyntheticWorkspace(db, new Date().toISOString(), "global");
  const tables = (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
    AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
    AND name NOT IN ('d1_migrations','rate_limit_buckets') ORDER BY name`,
    )
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name));
  async function effects() {
    const snapshot: Record<string, unknown[]> = {};
    for (const { name } of tables)
      snapshot[name] = await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all();
    return snapshot;
  }
  type Effects = Awaited<ReturnType<typeof effects>>;
  async function revoke(id: string) {
    await revokeDelegation(independent, FIX.workspace, id, new Date().toISOString());
    const row = (await independent
      .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, id)) as { revoked_at: string | null };
    assert(
      row.revoked_at !== null,
      "independent production revocation really changed the retained credential",
    );
  }
  async function fixture() {
    const owner = await loadPrincipal(db, FIX.workspace, FIX.owner);
    const task = success(
      await execute<TaskRecord>("task.create", {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: owner.authorizationEpoch,
        idempotencyKey: randomUlid(),
        now: historicalRequestTime,
        input: { projectId: FIX.projectA, title: `${canary}-TASK`, priority: "P2" },
      }),
    );
    const sponsor = await loadPrincipal(db, FIX.workspace, FIX.member),
      delegationId = randomUlid();
    const clock = (await db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS created_at,
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS expires_at`,
      )
      .get()) as {
      created_at: string;
      expires_at: string;
    };
    await db
      .prepare(
        `INSERT INTO oauth_delegations
      (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,authorization_epoch,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        delegationId,
        sponsor.humanId,
        FIX.client,
        mcpResource(origin),
        task.project_id,
        task.id,
        JSON.stringify(["bfb:task:write"]),
        sponsor.authorizationEpoch,
        clock.expires_at,
        clock.created_at,
      );
    const authority: PublicBusinessAuthority = {
      ...sponsor,
      projectIds: [...sponsor.projectIds],
      credential: {
        kind: "delegation",
        delegationId,
        clientId: FIX.client,
        projectId: task.project_id,
        taskId: task.id,
        scopes: ["bfb:task:write"],
      },
    };
    function request<I, R>(command: HubCommand<I, R>, input: I): CommandRequest<I> {
      return {
        workspaceId: FIX.workspace,
        actorHumanId: sponsor.humanId,
        actorDelegationId: delegationId,
        authorizationEpoch: sponsor.authorizationEpoch,
        idempotencyKey: randomUlid(),
        now: historicalRequestTime,
        input: withPublicBusinessAuthority(command, input, authority),
      };
    }
    return { task, delegationId, authority, request };
  }
  function denied(outcome: { ok: boolean; error?: { code: string; message: string } }) {
    assert.equal(outcome.ok, false, "lost public authority withholds the business result");
    assert.deepEqual(outcome.error, { code: "not_found", message: "resource not available" });
    assert(!JSON.stringify(outcome).includes(canary));
  }
  async function noGuards() {
    assert.deepEqual(await db.prepare("SELECT * FROM artifact_mutation_guards").all(), []);
  }

  await check(
    "native_d1_both_bound_write_only_child_creation_fits_check_parameter_limit",
    async () => {
      const f = await fixture(),
        checked = checkedDb(binding);
      const child = success(
        await new WorkspaceHub(checked.db).execute(
          createTaskCommand,
          f.request(createTaskCommand, {
            projectId: f.task.project_id,
            parentTaskId: f.task.id,
            title: `${canary}-CHILD`,
            priority: "P2",
          }),
        ),
      );
      assert.equal(child.parent_task_id, f.task.id);
      assert.equal(child.project_id, f.task.project_id);
      assert.equal(child.state, "ready");
      assert(
        checked.state.batch &&
          checked.state.checkBindings > 0 &&
          checked.state.checkBindings <= 100,
      );
      const stored = (await db
        .prepare("SELECT created_by_delegation_id FROM tasks WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, child.id)) as { created_by_delegation_id: string };
      assert.equal(stored.created_by_delegation_id, f.delegationId);
      await noGuards();
      seams.push({
        cut: "healthy_child",
        both_bound: true,
        write_only: true,
        check_bindings: checked.state.checkBindings,
      });
    },
  );

  for (const [command, kind] of [
    [addCommentCommand, "discussion"],
    [reportProgressCommand, "progress"],
  ] as const) {
    await check(
      `native_d1_${kind}_prebatch_actual_delegation_revoke_rolls_back_every_effect`,
      async () => {
        const f = await fixture();
        const input: AddCommentInput = { taskId: f.task.id, body: `${canary}-${kind}`, kind };
        success(await execute<{ id: string }>(command.name, f.request(command, input)));
        let baseline: Effects | undefined;
        const checked = checkedDb(binding, {
          beforeBatch: async () => {
            await revoke(f.delegationId);
            baseline = await effects();
          },
        });
        const outcome = await new WorkspaceHub(checked.db).execute(
          command,
          f.request(command, input),
        );
        assert.equal(outcome.ok, false);
        if (outcome.ok) throw new Error("revoked batch unexpectedly committed");
        assert.equal(outcome.error.code, "command_failed");
        assert(checked.state.batch && checked.state.checkBindings > 0 && baseline);
        assert.deepEqual(await effects(), baseline);
        await noGuards();
        seams.push({
          cut: "prebatch",
          command: command.name,
          healthy_control: true,
          revoked: true,
          full_rollback: true,
        });
      },
    );
  }

  await check(
    "native_d1_comment_cache_revocation_after_real_idempotency_select_has_no_effects",
    async () => {
      const f = await fixture(),
        request = f.request(addCommentCommand, {
          taskId: f.task.id,
          body: `${canary}-CACHED`,
          kind: "discussion",
        });
      const original = await execute<{ id: string }>(addCommentCommand.name, request);
      success(original);
      const unchanged = await effects(),
        healthy = await execute<{ id: string }>(addCommentCommand.name, request);
      assert(healthy.ok && healthy.replayed);
      assert.deepEqual(healthy.result, success(original));
      assert.deepEqual(await effects(), unchanged);
      let baseline: Effects | undefined;
      const checked = checkedDb(binding, {
        afterCache: async () => {
          await revoke(f.delegationId);
          baseline = await effects();
        },
      });
      denied(await new WorkspaceHub(checked.db).execute(addCommentCommand, request));
      assert(checked.state.cached && checked.state.final && !checked.state.batch && baseline);
      assert.deepEqual(await effects(), baseline);
      await noGuards();
      seams.push({
        cut: "idempotency_select",
        historical_result_retained: true,
        final_selected: true,
        new_effects: false,
      });
    },
  );

  const nativeNamespace = (
    (await server.getWorker("bfb-work-records-a").getEnv()) as unknown as {
      WORKSPACE_HUB: NonNullable<HubClientDeps["workspaceHubNs"]>;
    }
  ).WORKSPACE_HUB;
  for (const cached of [false, true]) {
    await check(
      `native_worker_do_${cached ? "cached" : "fresh"}_post_body_revoke_withholds_reply_keeps_committed_history`,
      async () => {
        const f = await fixture(),
          request = f.request(addCommentCommand, {
            taskId: f.task.id,
            body: `${canary}-PUBLIC`,
            kind: "discussion",
          });
        if (cached) success(await execute<{ id: string }>(addCommentCommand.name, request));
        const before = await effects();
        let baseline: Effects | undefined, actual: CommandOutcome<{ id: string }> | undefined;
        const state = { rpc: false, body: false, revoked: false };
        const namespace = {
          idFromName: (name: string) => nativeNamespace.idFromName(name),
          get(id: Parameters<typeof nativeNamespace.get>[0]) {
            const stub = nativeNamespace.get(id);
            return {
              async fetch(...args: Parameters<typeof stub.fetch>) {
                state.rpc = true;
                const response = await stub.fetch(...args);
                assert.equal(response.status, 200);
                // Preserve the actual response; the only interception is after its real body parser resolves.
                return new Proxy(response, {
                  get(target, property) {
                    if (property === "json")
                      return async () => {
                        actual = (await target.json()) as CommandOutcome<{ id: string }>;
                        success(actual);
                        assert(actual.ok);
                        assert.equal(actual.replayed, cached);
                        state.body = true;
                        if (cached) assert.deepEqual(await effects(), before);
                        await revoke(f.delegationId);
                        state.revoked = true;
                        baseline = await effects();
                        return actual;
                      };
                    const value: unknown = Reflect.get(target, property, target);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                });
              },
            };
          },
        } as unknown as NonNullable<HubClientDeps["workspaceHubNs"]>;
        const checked = checkedDb(binding, {
          beforeFinal: async () => {
            assert(state.rpc && state.body && state.revoked && baseline);
          },
        });
        const reply = await executePublicWorkspaceCommand(
          {
            db: checked.db,
            publicAuthority: f.authority,
            workspaceHubNs: namespace,
            authorization: createAuthorizationContext({
              workspaceId: FIX.workspace,
              principalId: f.delegationId,
              authorizationEpoch: f.authority.authorizationEpoch,
              jurisdiction: "global",
            }),
          },
          addCommentCommand,
          request,
        );
        denied(reply);
        assert(
          state.rpc &&
            state.body &&
            state.revoked &&
            checked.state.final &&
            !checked.state.batch &&
            baseline,
        );
        assert.deepEqual(await effects(), baseline);
        assert(actual?.ok);
        const comment = await db
          .prepare("SELECT id FROM comments WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, actual.result.id);
        assert(comment, "genuine fresh/cached committed comment remains after delivery denial");
        const receipt = (await db
          .prepare(
            "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
          )
          .get(FIX.workspace, request.idempotencyKey)) as { result_json: string };
        assert.deepEqual(JSON.parse(receipt.result_json).result, actual.result);
        assert(!receipt.result_json.includes("publicAuthority"));
        await noGuards();
        seams.push({
          cut: "actual_hub_response_json",
          cached,
          committed_history_retained: true,
          final_selected: true,
          reply_withheld: true,
        });
      },
    );
  }
  console.log(
    JSON.stringify({
      schema_version: 1,
      stage: "public_business_native_delivery",
      migration_head: manifest.migration_head,
      checks,
      failures,
      seams,
      ...bounds,
      outcome: failures.length ? "failed" : "passed",
      limits: [
        "disposable native D1; domain FIFO checks and actual production Worker/DO RPC are distinct witnesses",
        "synthetic retained OAuth metadata with database-clock expiry; no real OAuth/cookie/CLI credential ingress",
        "global test jurisdiction resolves one DO; no residency or native deployment proof",
        "no run/execution/runner/provider operation, artifact bytes, destructive retention or private activation",
      ],
    }),
  );
  assert.equal(failures.length, 0, "public business native D1 checks failed");
  console.log("C11_PUBLIC_BUSINESS_D1_OK");
} finally {
  await server.close();
}
