// ABOUTME: Proves delegated MCP extension effects through real independent Workers, Hub, D1 and R2.
// ABOUTME: Synthetic granted tokens exercise exact retries, revocation and private-data boundaries without a provider.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import { FIX, randomUlid, seedSyntheticWorkspace, type CommandOutcome } from "@bfb/domain";
import { syntheticGrant } from "./grant.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.x03.test";
const artOrigin = "https://artifacts.bfb.x03.test";
const d1 = {
  binding: "DB",
  database_name: "bfb-x03-proof",
  database_id: "00000000-0000-4000-8000-000000000303",
  migrations_dir: resolve(root, "migrations/d1"),
};
const base = {
  compatibility_date: "2026-08-08",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [d1],
};
const controls = ["bfb-x03-a", "bfb-x03-b"] as const;
const server = createTestHarness({
  root,
  workers: [
    ...controls.map((name) => ({
      config: {
        ...base,
        name,
        main: resolve(root, "tools/remote-mcp/control.ts"),
        vars: {
          ENVIRONMENT: "local",
          JURISDICTION: "global",
          APP_ORIGIN: origin,
          ARTIFACT_ORIGIN: artOrigin,
          LAUNCH_ORIGIN: "https://launch.bfb.x03.test",
          BETTER_AUTH_SECRETS:
            "2:x03-synthetic-current-signing-key,1:x03-synthetic-previous-signing-key",
          GITHUB_CLIENT_ID: "x03-synthetic",
          GITHUB_CLIENT_SECRET: "x03-synthetic",
          AUTH_ABUSE_SECRET: "x03-synthetic-abuse-key-81174a9dff00-long",
        },
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-x03-artifacts" }],
        assets: { directory: resolve(root, "tools/remote-mcp/assets"), binding: "ASSETS" },
        queues: {
          producers: [
            { binding: "JOBS", queue: "bfb-x03-jobs" },
            { binding: "JOBS_DLQ", queue: "bfb-x03-jobs-dlq" },
          ],
        },
        durable_objects: {
          bindings: [
            { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-x03-hub" },
          ],
        },
      },
    })),
    {
      config: {
        ...base,
        name: "bfb-x03-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
    {
      config: {
        ...base,
        name: "bfb-x03-artifact",
        main: resolve(root, "apps/artifact-worker/src/index.ts"),
        vars: {
          ENVIRONMENT: "local",
          APP_ORIGIN: origin,
          ARTIFACT_ORIGIN: artOrigin,
          UPLOAD_ABUSE_SECRET: "x03-synthetic-artifact-abuse-key-long",
        },
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-x03-artifacts" }],
        queues: { producers: [{ binding: "JOBS", queue: "bfb-x03-jobs" }] },
      },
    },
  ],
});

const checked: string[] = [];
function check(name: string) {
  checked.push(name);
}
type Control = (typeof controls)[number];
async function dispatch<T>(
  worker: Control,
  commandName: string,
  input: unknown,
  key = randomUlid(),
  delegationId?: string,
  now?: string,
) {
  const response = await server.getWorker(worker).fetch(`${origin}/__x03/hub`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandName,
      request: {
        workspaceId: FIX.workspace,
        idempotencyKey: key,
        actorHumanId: FIX.owner,
        ...(delegationId ? { actorDelegationId: delegationId } : {}),
        authorizationEpoch: 1,
        ...(now ? { now } : {}),
        input,
      },
    }),
  });
  assert.equal(response.status, 200, "Direct synthetic Hub dispatch failed.");
  return (await response.json()) as CommandOutcome<T>;
}
function ok<T>(outcome: CommandOutcome<T>): T {
  if (!outcome.ok) throw new Error(`Synthetic command failed: ${outcome.error.code}`);
  return outcome.result;
}
async function rpc(
  worker: Control,
  token: string,
  method: string,
  tool?: string,
  args: Record<string, unknown> = {},
) {
  return server.getWorker(worker).fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      host: new URL(origin).hostname,
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(tool ? { "mcp-name": tool } : {}),
      "cf-connecting-ip": "192.0.2.203",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUlid(),
      method,
      params: {
        ...(tool ? { name: tool, arguments: args } : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "synthetic-x03", version: "1" },
        },
      },
    }),
  });
}
async function call<T>(
  worker: Control,
  token: string,
  tool: string,
  args: Record<string, unknown>,
) {
  const response = await rpc(worker, token, "tools/call", tool, args);
  assert.equal(response.status, 200, "Synthetic MCP call must reach the handler.");
  const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
  const value = JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  if (typeof value.ok === "boolean") {
    assert.deepEqual(
      Object.keys(value).sort(),
      value.ok ? ["ok", "replayed", "result"] : ["error", "ok"],
    );
  }
  return value as T;
}

try {
  await server.listen();
  const app = server.getWorker(controls[0]);
  await app.applyD1Migrations("DB");
  const env = (await app.getEnv()) as unknown as { DB: D1Like };
  const db = adaptD1(env.DB);
  const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
  const applied = (await db.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all()) as Array<{
    name: string;
  }>;
  assert.deepEqual(
    applied.map((row) => row.name),
    manifest.migrations.map((row) => row.file),
  );
  check("ordered_d1_migrations_applied");
  const now = new Date().toISOString();
  await seedSyntheticWorkspace(db, now, "global");
  const alpha = await syntheticGrant(db, origin);
  const beta = await syntheticGrant(db, origin);
  const readOnly = await syntheticGrant(db, origin, ["bfb:read", "offline_access"]);
  const toolResponse = await rpc(controls[0], alpha.accessToken, "tools/list");
  assert.equal(toolResponse.status, 200, await toolResponse.clone().text());
  const listed = (await toolResponse.json()) as { result: { tools: Array<{ name: string }> } };
  assert.equal(listed.result.tools.length, 14);
  check("fourteen_stateless_tools");
  const task = ok(
    await dispatch<{ id: string }>(controls[0], "task.create", {
      projectId: FIX.projectA,
      title: "Synthetic MCP runtime task",
      priority: "P1",
    }),
  );
  const run = ok(
    await dispatch<{ run: { id: string } }>(controls[1], "run.create", {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    }),
  );
  const runId = run.run.id;
  const execution = ok(await dispatch<{ id: string }>(controls[0], "execution.create", { runId }));
  const runnerId = randomUlid();
  await db
    .prepare(
      `INSERT INTO runners (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,authorization_epoch,grant_epoch,token_epoch,enrolled_at,revoked_at) VALUES (?,?,?,'Synthetic unused runner','{}',?,1,1,1,?,NULL)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, "x03-synthetic-unused-key", now);
  await db
    .prepare(
      `INSERT INTO execution_assignments (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,1,1,1,?,?)`,
    )
    .run(
      FIX.workspace,
      execution.id,
      runId,
      task.id,
      FIX.projectA,
      runnerId,
      randomUlid(),
      `sha256:${"c".repeat(64)}`,
      FIX.owner,
      "x03-synthetic-unused-key",
      now,
    );
  // Only execution metadata is seeded; no enrolled Mac or provider process exists.
  const question = "synthetic-x03-private-question-canary";
  const attentionArgs = {
    run_id: runId,
    kind: "clarification",
    question,
    blocking: false,
    request_id: "x03-question-once",
  };
  const requests = await Promise.all(
    controls.map((worker) =>
      call<CommandOutcome<{ id: string }>>(
        worker,
        alpha.accessToken,
        "bfb_request_human",
        attentionArgs,
      ),
    ),
  );
  assert.equal(ok(requests[0]!).id, ok(requests[1]!).id);
  assert.equal(requests.filter((row) => row.ok && !row.replayed).length, 1);
  assert.deepEqual(
    await call(controls[1], alpha.accessToken, "bfb_request_human", {
      ...attentionArgs,
      question: "synthetic-changed",
    }),
    {
      ok: false,
      error: {
        code: "request_rejected",
        message: "operation input differs from its original request",
      },
    },
  );
  check("attention_concurrent_exact_retry_and_changed_input");
  const summary = "synthetic-x03-private-result-canary";
  const resultArgs = {
    run_id: runId,
    summary,
    limitations: `${summary}-limits`,
    request_id: "x03-result-once",
  };
  const submissions = await Promise.all(
    controls.map((worker) =>
      call<
        CommandOutcome<{
          submission: { id: string; submitted_by_kind: string; submitted_by_id: string };
        }>
      >(worker, alpha.accessToken, "bfb_submit_result", resultArgs),
    ),
  );
  const submitted = ok(submissions[0]!);
  assert.equal(submitted.submission.id, ok(submissions[1]!).submission.id);
  assert.equal(submissions.filter((row) => row.ok && !row.replayed).length, 1);
  assert.equal(submitted.submission.submitted_by_kind, "human");
  assert.equal(submitted.submission.submitted_by_id, FIX.owner);
  const changed = await call<CommandOutcome<unknown>>(
    controls[0],
    alpha.accessToken,
    "bfb_submit_result",
    { ...resultArgs, summary: "synthetic-changed" },
  );
  assert.equal(changed.ok, false);
  check("result_concurrent_exact_retry_human_attribution");
  ok(
    await call<CommandOutcome<unknown>>(controls[1], alpha.accessToken, "bfb_request_human", {
      ...attentionArgs,
      kind: "review",
      request_id: "x03-review-question",
    }),
  );
  check("submitted_run_attention_is_nonterminal");
  const isolated = await call<CommandOutcome<unknown>>(
    controls[0],
    beta.accessToken,
    "bfb_submit_result",
    resultArgs,
  );
  assert.equal(isolated.ok, false);
  if (!isolated.ok) assert.equal(isolated.error.code, "idempotency_authority_mismatch");
  check("cross_delegation_key_isolation");
  const denied = await rpc(controls[0], readOnly.accessToken, "tools/call", "bfb_request_human", {
    ...attentionArgs,
    request_id: "x03-readonly",
  });
  assert.equal(((await denied.json()) as { result: { isError: boolean } }).result.isError, true);
  const bytes = new TextEncoder().encode("# Synthetic MCP publication\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const publishArgs = {
    run_id: runId,
    format: "markdown",
    role: "review",
    declared_size: bytes.length,
    expected_digest: digest,
    request_id: "x03-publish-once",
  };
  const published = ok(
    await call<
      CommandOutcome<{ version_id: string; upload_grant: { grant_id: string; secret: string } }>
    >(controls[0], alpha.accessToken, "bfb_publish_artifact", publishArgs),
  );
  const replayed = await call<CommandOutcome<unknown>>(
    controls[1],
    alpha.accessToken,
    "bfb_publish_artifact",
    publishArgs,
  );
  assert.equal(replayed.ok, false);
  const finalizeArgs = {
    version_id: published.version_id,
    content_hash: digest,
    size: bytes.length,
    request_id: "x03-finalize-before-upload",
  };
  assert.equal(
    (
      await call<CommandOutcome<unknown>>(
        controls[0],
        alpha.accessToken,
        "bfb_finalize_artifact",
        finalizeArgs,
      )
    ).ok,
    false,
  );
  const upload = await server
    .getWorker("bfb-x03-artifact")
    .fetch(`${artOrigin}/upload/${published.upload_grant.grant_id}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${published.upload_grant.secret}`,
        "cf-connecting-ip": "192.0.2.203",
      },
      body: bytes as unknown as never,
    });
  assert.equal(upload.status, 200);
  const finalized = ok(
    await call<CommandOutcome<{ state: string; content_hash: string }>>(
      controls[1],
      alpha.accessToken,
      "bfb_finalize_artifact",
      { ...finalizeArgs, request_id: "x03-finalize-after-upload" },
    ),
  );
  assert.equal(finalized.state, "available");
  assert.equal(finalized.content_hash, digest);
  check("real_artifact_upload_and_verified_finalization");
  for (const table of [
    "semantic_events",
    "audit_events",
    "outbox_records",
    "artifact_audit_outbox",
  ]) {
    const payloads = JSON.stringify(await db.prepare(`SELECT payload_json FROM ${table}`).all());
    assert.equal(
      payloads.includes(question) || payloads.includes(summary),
      false,
      "Private content leaked to a projection.",
    );
  }
  for (const row of (await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    )
    .all()) as Array<{ name: string }>) {
    assert.match(row.name, /^[A-Za-z0-9_]+$/);
    const data = JSON.stringify(await db.prepare(`SELECT * FROM "${row.name}"`).all());
    assert.equal(
      [
        alpha.accessToken,
        beta.accessToken,
        readOnly.accessToken,
        published.upload_grant.secret,
      ].some((secret) => data.includes(secret)),
      false,
      "Plaintext credential leaked to D1.",
    );
  }
  check("metadata_only_receipts_and_no_plaintext_credentials");
  for (const tool of [
    "bfb_answer_attention",
    "bfb_accept_result",
    "bfb_approve_artifact",
    "bfb_start_run",
  ]) {
    const response = await rpc(controls[0], alpha.accessToken, "tools/call", tool);
    const body = (await response.json()) as { error?: unknown; result?: { isError?: boolean } };
    assert.equal(Boolean(body.error || body.result?.isError), true);
  }
  check("no_privileged_or_launch_tools");
  await db
    .prepare(`UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?`)
    .run(FIX.workspace, FIX.projectA);
  await db
    .prepare(`DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?`)
    .run(FIX.workspace, FIX.projectA, FIX.owner);
  const projectDenied = await call<CommandOutcome<unknown>>(
    controls[1],
    alpha.accessToken,
    "bfb_submit_result",
    resultArgs,
  );
  assert.equal(projectDenied.ok, false);
  assert.equal(JSON.stringify(projectDenied).includes(summary), false);
  await db
    .prepare(`INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)`)
    .run(FIX.workspace, FIX.projectA, FIX.owner);
  check("current_project_access_fences_mcp_cache");
  await db
    .prepare(`UPDATE oauth_delegations SET revoked_at=? WHERE workspace_id=? AND id=?`)
    .run(new Date().toISOString(), FIX.workspace, alpha.delegationId);
  assert.equal(
    (await rpc(controls[1], alpha.accessToken, "tools/call", "bfb_submit_result", resultArgs))
      .status,
    401,
  );
  const hubDenied = await dispatch(
    controls[0],
    "result.submit.delegation",
    { runId, summary, limitations: `${summary}-limits` },
    "x03-result-once",
    alpha.delegationId,
    now,
  );
  assert.equal(hubDenied.ok, false);
  assert.equal(JSON.stringify(hubDenied).includes(summary), false);
  check("revocation_fences_outer_handler_and_direct_hub_cache");
  console.log(
    JSON.stringify({
      package: "X03",
      checks: checked,
      count: checked.length,
      migrations_applied: applied.length,
      migration_head: manifest.migration_head,
      provider_started: false,
      persistent_pilot_changed: false,
      synthetic_token_protocol: true,
    }),
  );
  console.log("X03_D1_OK");
} finally {
  await server.close();
}
