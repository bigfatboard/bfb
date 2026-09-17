// ABOUTME: Drives the five X03 extension tools through the real stateless MCP handler.
// ABOUTME: Parity outcomes, boundaries, idempotency, revocation, and the privilege attack matrix fail closed.

import { describe, expect, it } from "vitest";

import {
  markArtifactFailedCommand,
  recordVerifiedUpload,
} from "../../../packages/domain/src/artifacts.js";
import {
  answerAttentionCommand,
  resolveAttentionCommand,
} from "../../../packages/domain/src/attention.js";
import {
  acceptResultCommand,
  cancelRunCommand,
  failRunCommand,
  requestChangesCommand,
} from "../../../packages/domain/src/results.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { revokeDelegation } from "../../../packages/domain/src/oauth.js";
import {
  createTaskCommand,
  updateTaskCommand,
} from "../../../packages/domain/src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
} from "../../../packages/domain/src/work-records.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const NOW = "2026-08-07T12:00:00.000Z";
const COMMIT = "a".repeat(40);
const TREE_HASH = `sha256:${"c".repeat(64)}`;
const DIGEST = "d".repeat(64);

const handlerEnv = {
  allowedHostnames: ["bfb.example.test"],
  appOrigin: "https://bfb.example.test",
  abuseSecret: "x03-mcp-abuse-secret-81174a9dff00",
  jurisdiction: "eu" as const,
  now: "2026-08-07T12:01:00.000Z",
};

const TOOL_NAMES = [
  "bfb_list_projects",
  "bfb_list_tasks",
  "bfb_get_task",
  "bfb_get_context",
  "bfb_add_comment",
  "bfb_report_progress",
  "bfb_propose_task",
  "bfb_request_human",
  "bfb_get_attention",
  "bfb_submit_result",
  "bfb_publish_artifact",
  "bfb_finalize_artifact",
];

async function seedRun(
  db: import("@bfb/db").SqlDatabase,
  key: string,
  projectId = FIX.projectA,
): Promise<{ taskId: string; runId: string; executionId: string }> {
  const hub = new WorkspaceHub(db);
  async function run<T>(command: Parameters<typeof hub.execute>[0], input: unknown): Promise<T> {
    const outcome = await hub.execute(command as never, {
      workspaceId: FIX.workspace,
      idempotencyKey: `${key}-${randomUlid()}`,
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: NOW,
      input: input as never,
    });
    if (!outcome.ok) {
      throw new Error(`seed failed: ${outcome.error.code} ${outcome.error.message}`);
    }
    return outcome.result as T;
  }
  const task = await run<{ id: string }>(createTaskCommand, {
    projectId,
    title: `Synthetic remote parity task ${key}`,
    priority: "P2",
  });
  const created = await run<{ run: { id: string } }>(createRunCommand, {
    taskId: task.id,
    expectedTaskVersion: 1,
    agentProfileId: FIX.profileCodex,
    workspacePolicyVersion: 1,
    projectPolicyVersion: 1,
    repositoryConfigVersion: 1,
    agentProfileVersion: 1,
  });
  const runnerId = randomUlid();
  await db
    .prepare(
      `INSERT INTO runners
       (workspace_id, id, owner_human_id, device_label, public_key_json,
        key_thumbprint, authorization_epoch, grant_epoch, token_epoch, enrolled_at, revoked_at)
       VALUES (?, ?, ?, 'Synthetic remote Mac', '{}', ?, 1, 1, 1, ?, NULL)`,
    )
    .run(FIX.workspace, runnerId, FIX.owner, `synthetic-remote-key-${key}`, NOW);
  await db
    .prepare(
      `INSERT INTO runner_project_grants (workspace_id, runner_id, project_id) VALUES (?, ?, ?)`,
    )
    .run(FIX.workspace, runnerId, projectId);
  const execution = await run<{ id: string }>(createExecutionCommand, { runId: created.run.id });
  await db
    .prepare(
      `INSERT INTO execution_assignments
       (workspace_id, execution_id, assignment_generation, run_id, task_id, project_id,
        runner_id, checkout_id, physical_worktree_hash, requesting_human_id,
        requesting_human_epoch, runner_authorization_epoch, runner_grant_epoch,
        runner_key_thumbprint, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      execution.id,
      created.run.id,
      task.id,
      projectId,
      runnerId,
      randomUlid(),
      TREE_HASH,
      FIX.owner,
      `synthetic-remote-key-${key}`,
      NOW,
    );
  return { taskId: task.id, runId: created.run.id, executionId: execution.id };
}

describe("remote mcp parity extensions", () => {
  it("lists exactly twelve tools for an active delegation", async () => {
    const db = await openDomainDb();
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const response = await request(db, "tools/list", undefined, {}, accessToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it("runs the delegated attention loop and keeps retries idempotent", async () => {
    const db = await openDomainDb();
    const { runId } = await seedRun(db, "attention-loop");
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const requested = (await call(db, accessToken, "bfb_request_human", {
      run_id: runId,
      kind: "clarification",
      question: "Synthetic delegated question",
      blocking: true,
      request_id: "attention-request-1",
    })) as { ok: boolean; result: { id: string; state: string; required_role: string } };
    expect(requested).toMatchObject({
      ok: true,
      result: { state: "open", required_role: "reviewer" },
    });
    const attentionId = requested.result.id;
    const retry = (await call(db, accessToken, "bfb_request_human", {
      run_id: runId,
      kind: "clarification",
      question: "Synthetic changed retry",
      blocking: true,
      request_id: "attention-request-1",
    })) as { result: { id: string } };
    expect(retry.result.id).toBe(attentionId);
    const read = (await call(db, accessToken, "bfb_get_attention", {
      attention_id: attentionId,
    })) as { attention: { id: string; state: string; question: string } };
    expect(read.attention).toMatchObject({
      id: attentionId,
      state: "open",
      question: "Synthetic delegated question",
    });
    const missing = await request(
      db,
      "tools/call",
      "bfb_get_attention",
      { attention_id: randomUlid() },
      accessToken,
    );
    expect(((await missing.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
  });

  it("submits a delegated result attributed to the authorizing human", async () => {
    const db = await openDomainDb();
    const { runId } = await seedRun(db, "submit-loop");
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const submitted = (await call(db, accessToken, "bfb_submit_result", {
      run_id: runId,
      summary: "Synthetic delegated result",
      limitations: "Synthetic limits",
      evidence_refs: [{ kind: "comment", ref: "synthetic-comment", version: "1" }],
      git_branch: "synthetic",
      git_commit: COMMIT,
      git_dirty: false,
      request_id: "submit-request-1",
    })) as {
      ok: boolean;
      result: {
        submission: { version: number; submitted_by_kind: string; submitted_by_id: string };
      };
    };
    expect(submitted).toMatchObject({
      ok: true,
      result: {
        submission: { version: 1, submitted_by_kind: "human", submitted_by_id: FIX.owner },
      },
    });
    const stored = (await db
      .prepare(
        `SELECT submitted_by_kind FROM result_submissions WHERE workspace_id = ? AND run_id = ?`,
      )
      .all(FIX.workspace, runId)) as Array<{ submitted_by_kind: string }>;
    expect(stored).toEqual([{ submitted_by_kind: "human" }]);
    const rerun = (await call(db, accessToken, "bfb_submit_result", {
      run_id: runId,
      summary: "Synthetic changed retry",
      request_id: "submit-request-1",
    })) as { result: { submission: { version: number } } };
    expect(rerun.result.submission.version).toBe(1);
  });

  it("publishes and finalizes a delegated artifact without storing the grant secret", async () => {
    const db = await openDomainDb();
    const { runId } = await seedRun(db, "artifact-loop");
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const published = (await call(db, accessToken, "bfb_publish_artifact", {
      run_id: runId,
      format: "markdown",
      role: "review",
      declared_size: 18,
      expected_digest: DIGEST,
      request_id: "publish-request-1",
    })) as {
      ok: boolean;
      result: {
        state: string;
        version_id: string;
        upload_grant: { grant_id: string; secret: string; expires_at: string };
      };
    };
    expect(published).toMatchObject({ ok: true, result: { state: "uploading" } });
    const secret = published.result.upload_grant.secret;
    expect(typeof secret).toBe("string");
    const dump = JSON.stringify({
      grants: await db.prepare(`SELECT * FROM artifact_upload_grants`).all(),
      audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
    });
    expect(dump.includes(secret)).toBe(false);
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: published.result.version_id,
      runId,
      role: "review",
      contentHash: DIGEST,
      r2Key: `workspaces/${FIX.workspace}/artifacts/sha256/${DIGEST}`,
      size: 18,
      now: NOW,
    });
    const finalized = (await call(db, accessToken, "bfb_finalize_artifact", {
      version_id: published.result.version_id,
      content_hash: DIGEST,
      size: 18,
      request_id: "finalize-request-1",
    })) as { ok: boolean; result: { state: string; content_hash: string } };
    expect(finalized).toMatchObject({
      ok: true,
      result: { state: "available", content_hash: DIGEST },
    });
  });

  it("keeps every extension tool inside the delegated project and task boundary", async () => {
    const db = await openDomainDb();
    const home = await seedRun(db, "boundary-home");
    const away = await seedRun(db, "boundary-away", FIX.projectB);
    const { accessToken } = await issueSyntheticMcpAccess(db, { projectId: FIX.projectA });
    const escapes: Array<[string, Record<string, unknown>]> = [
      [
        "bfb_request_human",
        {
          run_id: away.runId,
          kind: "clarification",
          question: "x",
          blocking: false,
          request_id: "escape-1",
        },
      ],
      ["bfb_submit_result", { run_id: away.runId, summary: "x", request_id: "escape-2" }],
      [
        "bfb_publish_artifact",
        {
          run_id: away.runId,
          format: "markdown",
          role: "review",
          declared_size: 3,
          expected_digest: DIGEST,
          request_id: "escape-3",
        },
      ],
      [
        "bfb_finalize_artifact",
        { version_id: randomUlid(), content_hash: DIGEST, size: 3, request_id: "escape-4" },
      ],
    ];
    for (const [name, args] of escapes) {
      const response = await request(db, "tools/call", name, args, accessToken);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { result: { isError?: boolean } }).result.isError).toBe(
        true,
      );
    }
    const requested = (await call(db, accessToken, "bfb_request_human", {
      run_id: home.runId,
      kind: "clarification",
      question: "Synthetic home question",
      blocking: false,
      request_id: "home-attention-1",
    })) as { ok: boolean };
    expect(requested.ok).toBe(true);
    const taskBound = await issueSyntheticMcpAccess(db, { taskId: home.taskId });
    const foreign = await request(
      db,
      "tools/call",
      "bfb_submit_result",
      { run_id: away.runId, summary: "Must not escape", request_id: "escape-5" },
      taskBound.accessToken,
    );
    expect(((await foreign.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
    expect(
      await db
        .prepare(`SELECT COUNT(*) AS count FROM result_submissions WHERE workspace_id = ?`)
        .get(FIX.workspace),
    ).toEqual({ count: 0 });
  });

  it("requires the write scope for mutations while reads stay available", async () => {
    const db = await openDomainDb();
    const { taskId, runId } = await seedRun(db, "scope-loop");
    const full = await issueSyntheticMcpAccess(db);
    const attentionId = (
      (await call(db, full.accessToken, "bfb_request_human", {
        run_id: runId,
        kind: "clarification",
        question: "Synthetic scope question",
        blocking: false,
        request_id: "scope-attention-1",
      })) as { result: { id: string } }
    ).result.id;
    const readOnly = await issueSyntheticMcpAccess(db, { scopes: ["bfb:read", "offline_access"] });
    const read = (await call(db, readOnly.accessToken, "bfb_get_attention", {
      attention_id: attentionId,
    })) as { attention: { id: string } };
    expect(read.attention.id).toBe(attentionId);
    const denials: Array<[string, Record<string, unknown>]> = [
      [
        "bfb_request_human",
        {
          run_id: runId,
          kind: "clarification",
          question: "x",
          blocking: false,
          request_id: "scope-1",
        },
      ],
      ["bfb_submit_result", { run_id: runId, summary: "x", request_id: "scope-2" }],
      [
        "bfb_publish_artifact",
        {
          run_id: runId,
          format: "markdown",
          role: "review",
          declared_size: 3,
          expected_digest: DIGEST,
          request_id: "scope-3",
        },
      ],
      [
        "bfb_finalize_artifact",
        { version_id: randomUlid(), content_hash: DIGEST, size: 3, request_id: "scope-4" },
      ],
      ["bfb_add_comment", { task_id: taskId, body: "x", request_id: "scope-5" }],
    ];
    for (const [name, args] of denials) {
      const response = await request(db, "tools/call", name, args, readOnly.accessToken);
      const body = (await response.json()) as {
        result: { isError?: boolean; content?: Array<{ text: string }> };
      };
      expect(body.result.isError).toBe(true);
      expect(JSON.stringify(body.result.content)).toMatch(/insufficient_scope|missing scope/);
    }
  });

  it("blocks the next call after delegation revocation without touching the token", async () => {
    const db = await openDomainDb();
    const { runId } = await seedRun(db, "revoke-loop");
    const { accessToken, delegationId } = await issueSyntheticMcpAccess(db);
    const projects = (await call(db, accessToken, "bfb_list_projects", {})) as {
      projects: Array<{ id: string }>;
    };
    expect(projects.projects.map((project) => project.id)).toEqual([FIX.projectA]);
    await revokeDelegation(db, FIX.workspace, delegationId, NOW);
    const blocked = await request(
      db,
      "tools/call",
      "bfb_submit_result",
      { run_id: runId, summary: "Must not land", request_id: "revoke-submit-1" },
      accessToken,
    );
    expect(blocked.status).toBe(401);
  });

  it("proves no persistent MCP session state across isolated requests", async () => {
    const db = await openDomainDb();
    const first = await seedRun(db, "stateless-a");
    const second = await seedRun(db, "stateless-b");
    const alpha = await issueSyntheticMcpAccess(db);
    const beta = await issueSyntheticMcpAccess(db);
    const alphaSubmit = (await call(db, alpha.accessToken, "bfb_submit_result", {
      run_id: first.runId,
      summary: "Synthetic alpha submission",
      request_id: "shared-request-key",
    })) as { ok: boolean };
    expect(alphaSubmit.ok).toBe(true);
    const betaReplay = await request(
      db,
      "tools/call",
      "bfb_submit_result",
      {
        run_id: second.runId,
        summary: "Synthetic beta submission",
        request_id: "shared-request-key",
      },
      beta.accessToken,
    );
    const betaBody = (await betaReplay.json()) as {
      result: { isError?: boolean; content?: Array<{ text: string }> };
    };
    expect(betaBody.result.isError).toBe(true);
    expect(JSON.stringify(betaBody.result.content)).toContain("idempotency_authority_mismatch");
    const alphaReread = (await call(db, alpha.accessToken, "bfb_submit_result", {
      run_id: first.runId,
      summary: "Synthetic changed retry",
      request_id: "shared-request-key",
    })) as { result: { submission: { version: number } } };
    expect(alphaReread.result.submission.version).toBe(1);
  });

  it("leaves delegation scopes and boundaries unchanged by tool use", async () => {
    const db = await openDomainDb();
    const { runId } = await seedRun(db, "scope-stable");
    const { accessToken, delegationId } = await issueSyntheticMcpAccess(db);
    const before = (await db
      .prepare(`SELECT scopes_json, project_id, task_id FROM oauth_delegations WHERE id = ?`)
      .get(delegationId)) as Record<string, unknown>;
    await call(db, accessToken, "bfb_submit_result", {
      run_id: runId,
      summary: "Synthetic scope stability probe",
      request_id: "scope-stable-1",
    });
    const after = (await db
      .prepare(`SELECT scopes_json, project_id, task_id FROM oauth_delegations WHERE id = ?`)
      .get(delegationId)) as Record<string, unknown>;
    expect(after).toEqual(before);
  });

  it("denies the privilege attack matrix without resolving, accepting, approving, or promoting", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await seedRun(db, "attack-matrix");
    const { accessToken, delegationId } = await issueSyntheticMcpAccess(db);
    const requested = (await call(db, accessToken, "bfb_request_human", {
      run_id: runId,
      kind: "credential",
      question: "Synthetic attack question",
      blocking: false,
      request_id: "attack-attention-1",
    })) as { result: { id: string; resource_version: number } };
    const submitted = (await call(db, accessToken, "bfb_submit_result", {
      run_id: runId,
      summary: "Synthetic attack submission",
      request_id: "attack-submit-1",
    })) as { result: { submission: { id: string }; runVersion: number; taskVersion: number } };
    const published = (await call(db, accessToken, "bfb_publish_artifact", {
      run_id: runId,
      format: "markdown",
      role: "review",
      declared_size: 9,
      expected_digest: DIGEST,
      request_id: "attack-publish-1",
    })) as { result: { version_id: string } };
    function delegated<T>(input: T) {
      return {
        workspaceId: FIX.workspace,
        idempotencyKey: randomUlid(),
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        actorDelegationId: delegationId,
        now: NOW,
        input,
      };
    }
    const denials: Array<{ name: string; command: unknown; input: unknown; code: string }> = [
      {
        name: "attention.answer",
        command: answerAttentionCommand,
        input: { attentionId: requested.result.id, expectedVersion: 1, answer: "Seized answer" },
        code: "forbidden",
      },
      {
        name: "attention.resolve",
        command: resolveAttentionCommand,
        input: { attentionId: requested.result.id, expectedVersion: 1 },
        code: "forbidden",
      },
      {
        name: "result.request_changes",
        command: requestChangesCommand,
        input: {
          runId,
          submissionId: submitted.result.submission.id,
          expectedRunVersion: submitted.result.runVersion,
          expectedTaskVersion: submitted.result.taskVersion,
          comment: "Seized review",
        },
        code: "forbidden",
      },
      {
        name: "result.accept",
        command: acceptResultCommand,
        input: {
          runId,
          submissionId: submitted.result.submission.id,
          expectedRunVersion: submitted.result.runVersion,
          expectedTaskVersion: submitted.result.taskVersion,
        },
        code: "forbidden",
      },
      {
        name: "result.fail",
        command: failRunCommand,
        input: { runId, expectedRunVersion: submitted.result.runVersion },
        code: "forbidden",
      },
      {
        name: "result.cancel",
        command: cancelRunCommand,
        input: { runId, expectedRunVersion: submitted.result.runVersion },
        code: "forbidden",
      },
      {
        name: "artifact.mark_failed",
        command: markArtifactFailedCommand,
        input: { versionId: published.result.version_id },
        code: "request_rejected",
      },
    ];
    for (const { name, command, input, code } of denials) {
      const outcome = await hub.execute(
        command as Parameters<typeof hub.execute>[0],
        delegated(input) as never,
      );
      expect(outcome.ok, name).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code, name).toBe(code);
      }
    }
    const taskVersion = (
      (await db
        .prepare(`SELECT resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, taskId)) as { resource_version: number }
    ).resource_version;
    const promote = await hub.execute(
      updateTaskCommand,
      delegated({ taskId, expectedVersion: taskVersion, promote: true }) as never,
    );
    expect(promote.ok).toBe(false);
    if (!promote.ok) {
      expect(promote.error.code).toBe("forbidden");
    }
    for (const name of [
      "bfb_answer_attention",
      "bfb_resolve_attention",
      "bfb_accept_result",
      "bfb_approve_artifact",
      "bfb_promote_task",
      "bfb_admin_policy",
    ]) {
      const response = await request(
        db,
        "tools/call",
        name,
        { request_id: "attack-probe" },
        accessToken,
      );
      if (response.status === 200) {
        const body = (await response.json()) as { result?: { content?: unknown } };
        expect(body.result?.content, name).toBeUndefined();
      }
    }
    const submissions = (await db
      .prepare(
        `SELECT submitted_by_kind FROM result_submissions WHERE workspace_id = ? AND submitted_by_kind = 'agent_run'`,
      )
      .all(FIX.workspace)) as unknown[];
    expect(submissions).toEqual([]);
    const sessions = (await db
      .prepare(`SELECT id FROM provider_sessions WHERE workspace_id = ?`)
      .all(FIX.workspace)) as unknown[];
    expect(sessions).toEqual([]);
  });

  it("dispatches extension commands through the catalogued hub namespace", async () => {
    const db = await openDomainDb();
    const { runId } = await seedRun(db, "catalog-loop");
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const response = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: headers("tools/call", "bfb_submit_result", accessToken),
        body: JSON.stringify(
          modernBody("tools/call", "bfb_submit_result", {
            run_id: runId,
            summary: "Synthetic namespaced submission",
            request_id: "catalog-submit-1",
          }),
        ),
      }),
      { db, ...handlerEnv, workspaceHubNs: createTestWorkspaceHubNamespace(db) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0]!.text)).toMatchObject({
      ok: true,
      result: { runResultState: "submitted" },
    });
  });
});

async function call(
  db: import("@bfb/db").SqlDatabase,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await request(db, "tools/call", name, args, accessToken);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text) as unknown;
}

function request(
  db: import("@bfb/db").SqlDatabase,
  method: string,
  name?: string,
  args: Record<string, unknown> = {},
  accessToken?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: { ...headers(method, name, accessToken), ...extraHeaders },
      body: JSON.stringify(modernBody(method, name, args)),
    }),
    { db, ...handlerEnv },
  );
}

function headers(method: string, name?: string, accessToken?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {}),
    Host: "bfb.example.test",
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

function modernBody(method: string, name?: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...(name ? { name, arguments: args } : {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "bfb-test", version: "1.0.0" },
      },
    },
  };
}
