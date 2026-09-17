// ABOUTME: Proves X03 delegated attention, result, and artifact commands match owning-package behavior.
// ABOUTME: Delegation acceptance, boundary, revocation, and idempotency fail closed without new scopes.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import { requestAttentionCommand } from "../src/attention.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import {
  ARTIFACT_LOG_MAX_BYTES,
  ARTIFACT_REVIEW_MAX_BYTES,
  artifactHash,
  createArtifactCommand,
  finalizeArtifactCommand,
  mintUploadGrantSecret,
  recordVerifiedUpload,
} from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandOutcome } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import {
  createDelegatedArtifactCommand,
  finalizeDelegatedArtifactCommand,
  requestDelegatedAttentionCommand,
  submitDelegatedResultCommand,
} from "../src/remote-parity.js";
import { submitResultCommand } from "../src/results.js";
import { resolveCommand } from "../src/command-catalog.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createExecutionCommand, createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { launchFixture, LAUNCH_NOW, success } from "./launch-fixture.js";

const NOW = "2026-08-12T08:00:00Z";
const LATER = "2026-08-12T09:00:00Z";
const COMMIT = "a".repeat(40);
const TREE_HASH = `sha256:${"c".repeat(64)}`;
const DIGEST = artifactHash("synthetic-remote-artifact");

function ok<T>(outcome: CommandOutcome<T>): T {
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
  if (!outcome.ok) {
    throw new Error(outcome.error.code);
  }
  return outcome.result;
}

function err(outcome: CommandOutcome<unknown>): string {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error("expected failure");
  }
  return outcome.error.code;
}

function human<T>(idempotencyKey: string, input: T, humanId = FIX.owner, now = NOW) {
  return {
    workspaceId: FIX.workspace,
    idempotencyKey,
    authorizationEpoch: 1,
    actorHumanId: humanId,
    now,
    input,
  };
}

function delegated<T>(
  idempotencyKey: string,
  delegationId: string,
  input: T,
  humanId = FIX.owner,
  now = NOW,
) {
  return {
    workspaceId: FIX.workspace,
    idempotencyKey,
    authorizationEpoch: 1,
    actorHumanId: humanId,
    actorDelegationId: delegationId,
    now,
    input,
  };
}

async function seedDelegation(
  db: SqlDatabase,
  options: {
    humanId?: string;
    projectId?: string | null;
    taskId?: string;
    scopes?: string[];
    expiresAt?: string;
  } = {},
): Promise<string> {
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations
       (workspace_id, id, human_id, client_id, resource, project_id, task_id,
        scopes_json, authorization_epoch, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      options.humanId ?? FIX.owner,
      FIX.client,
      options.projectId === undefined ? FIX.projectA : options.projectId,
      options.taskId ?? null,
      JSON.stringify(options.scopes ?? ["bfb:read", "bfb:task:write", "offline_access"]),
      options.expiresAt ?? LATER,
      NOW,
    );
  return delegationId;
}

async function createTaskAndRun(
  db: SqlDatabase,
  hub: WorkspaceHub,
  key: string,
  projectId = FIX.projectA,
): Promise<{ taskId: string; runId: string }> {
  const task = ok(
    await hub.execute(
      createTaskCommand,
      human(`${key}-task`, {
        projectId,
        title: `Synthetic remote parity task ${key}`,
        priority: "P1" as const,
      }),
    ),
  );
  const run = ok(
    await hub.execute(
      createRunCommand,
      human(`${key}-run`, {
        taskId: task.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      }),
    ),
  );
  return { taskId: task.id, runId: run.run.id };
}

async function seedExecution(
  db: SqlDatabase,
  hub: WorkspaceHub,
  key: string,
  runId: string,
  taskId: string,
  projectId = FIX.projectA,
): Promise<string> {
  const runnerId = randomUlid();
  const checkoutId = randomUlid();
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
  const execution = ok(await hub.execute(createExecutionCommand, human(`${key}-execution`, { runId })));
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
      runId,
      taskId,
      projectId,
      runnerId,
      checkoutId,
      TREE_HASH,
      FIX.owner,
      `synthetic-remote-key-${key}`,
      NOW,
    );
  return execution.id;
}

describe("remote parity command registration", () => {
  it("resolves every X03 command through the hub catalog", () => {
    for (const name of [
      "attention.request.delegation",
      "result.submit.delegation",
      "artifact.create_version.delegation",
      "artifact.finalize_version.delegation",
    ]) {
      expect(resolveCommand(name)?.name).toBe(name);
    }
  });
});

describe("delegated attention request", () => {
  it("commits an open request bound to the run execution with the authorizing human observed", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "request");
    const executionId = await seedExecution(db, hub, "request", runId, taskId);
    const delegationId = await seedDelegation(db);
    const record = ok(
      await hub.execute(
        requestDelegatedAttentionCommand,
        delegated("request-attention", delegationId, {
          runId,
          kind: "clarification" as const,
          question: "Synthetic delegated question",
          blocking: true,
        }),
      ),
    );
    expect(record).toMatchObject({
      state: "open",
      kind: "clarification",
      required_role: "reviewer",
      blocking: true,
      task_id: taskId,
      run_id: runId,
      run_execution_id: executionId,
      assignment_generation: 1,
      resource_version: 1,
      answer: null,
    });
    const observations = (await db
      .prepare(
        `SELECT observed_kind, actor_type, actor_id FROM attention_observations
         WHERE workspace_id = ? AND attention_id = ?`,
      )
      .all(FIX.workspace, record.id)) as Array<{
      observed_kind: string;
      actor_type: string;
      actor_id: string;
    }>;
    expect(observations).toEqual([{ observed_kind: "requested", actor_type: "human", actor_id: FIX.owner }]);
    const audit = (await db
      .prepare(
        `SELECT payload_json FROM audit_events WHERE workspace_id = ? AND action = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(FIX.workspace, "attention.request.delegation")) as { payload_json: string };
    expect(JSON.parse(audit.payload_json).actor).toMatchObject({
      humanId: FIX.owner,
      delegationId,
    });
  });

  it("matches the runner command record shape on twin bound runs", async () => {
    const f = await launchFixture();
    const { claimed } = await f.claim();
    const bound = {
      runId: claimed.specification.run_id,
      executionId: claimed.specification.run_execution_id,
      generation: claimed.specification.assignment_generation,
      taskId: f.task.id,
    };
    const runnerRecord = success(
      await f.native(requestAttentionCommand, {
        principal: f.principal,
        runId: bound.runId,
        executionId: bound.executionId,
        assignmentGeneration: bound.generation,
        kind: "blocker",
        question: "Synthetic twin question",
        blocking: false,
      }),
    );
    const delegationId = await seedDelegation(f.db, {
      taskId: bound.taskId,
      expiresAt: "2026-09-12T13:00:00.000Z",
    });
    const delegatedRecord = ok(
      await f.hub.execute(
        requestDelegatedAttentionCommand,
        {
          workspaceId: FIX.workspace,
          idempotencyKey: randomUlid(),
          authorizationEpoch: 1,
          actorHumanId: FIX.owner,
          actorDelegationId: delegationId,
          now: LAUNCH_NOW,
          input: {
            runId: bound.runId,
            kind: "blocker",
            question: "Synthetic twin question",
            blocking: false,
          },
        },
      ),
    );
    for (const record of [runnerRecord, delegatedRecord]) {
      expect(record).toMatchObject({
        state: "open",
        kind: "blocker",
        required_role: "member",
        blocking: false,
        task_id: bound.taskId,
        run_id: bound.runId,
        run_execution_id: bound.executionId,
        assignment_generation: bound.generation,
        resource_version: 1,
      });
    }
  });

  it("rejects malformed attention input with the A02 human-path codes", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "malformed");
    const delegationId = await seedDelegation(db);
    const attempt = (input: Record<string, unknown>) =>
      hub.execute(
        requestDelegatedAttentionCommand,
        delegated(randomUlid(), delegationId, { runId, ...input }),
      );
    expect(err(await attempt({ kind: "unknown", question: "q", blocking: true }))).toBe(
      "invalid_argument",
    );
    expect(err(await attempt({ kind: "clarification", question: "  ", blocking: true }))).toBe(
      "invalid_argument",
    );
    expect(
      err(await attempt({ kind: "clarification", question: "x".repeat(2049), blocking: true })),
    ).toBe("invalid_argument");
    expect(
      err(await attempt({ kind: "clarification", question: "badchar", blocking: true })),
    ).toBe("invalid_argument");
    expect(
      err(
        await attempt({
          kind: "clarification",
          question: "q",
          referenceKind: "artifact_version",
          blocking: true,
        }),
      ),
    ).toBe("invalid_argument");
    expect(err(await attempt({ kind: "clarification", question: "q", blocking: "yes" }))).toBe(
      "invalid_argument",
    );
    expect(
      err(
        await hub.execute(
          requestDelegatedAttentionCommand,
          delegated(randomUlid(), delegationId, {
            runId: randomUlid(),
            kind: "clarification",
            question: "q",
            blocking: true,
          }),
        ),
      ),
    ).toBe("not_found");
  });

  it("refuses runs outside the delegation boundary, without execution, or past terminal", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "noexec");
    const foreign = await createTaskAndRun(db, hub, "foreign", FIX.projectB);
    await seedExecution(db, hub, "foreign", foreign.runId, foreign.taskId, FIX.projectB);
    const delegationId = await seedDelegation(db);
    const base = { kind: "clarification" as const, question: "Synthetic boundary", blocking: false };
    expect(
      err(
        await hub.execute(
          requestDelegatedAttentionCommand,
          delegated("noexec-attention", delegationId, { ...base, runId }),
        ),
      ),
    ).toBe("invalid_transition");
    expect(
      err(
        await hub.execute(
          requestDelegatedAttentionCommand,
          delegated("foreign-attention", delegationId, { ...base, runId: foreign.runId }),
        ),
      ),
    ).toBe("forbidden");
    const taskBound = await seedDelegation(db, {
      projectId: FIX.projectB,
      taskId: foreign.taskId,
    });
    expect(
      err(
        await hub.execute(
          requestDelegatedAttentionCommand,
          delegated("taskbound-attention", taskBound, { ...base, runId }),
        ),
      ),
    ).toBe("forbidden");
    await seedExecution(db, hub, "terminal", runId, taskId);
    ok(
      await hub.execute(
        submitResultCommand,
        human("terminal-submit", { runId, summary: "Synthetic terminal submission" }),
      ),
    );
    expect(
      err(
        await hub.execute(
          requestDelegatedAttentionCommand,
          delegated("terminal-attention", delegationId, { ...base, runId }),
        ),
      ),
    ).toBe("invalid_transition");
  });

  it("replays the same idempotency key to the identical record", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "replay");
    await seedExecution(db, hub, "replay", runId, taskId);
    const delegationId = await seedDelegation(db);
    const input = {
      runId,
      kind: "review" as const,
      question: "Synthetic replay question",
      blocking: false,
    };
    const first = ok(
      await hub.execute(requestDelegatedAttentionCommand, delegated("replay-key", delegationId, input)),
    );
    const second = ok(
      await hub.execute(
        requestDelegatedAttentionCommand,
        delegated("replay-key", delegationId, { ...input, question: "Synthetic changed retry" }),
      ),
    );
    expect(second.id).toBe(first.id);
    const count = (await db
      .prepare(`SELECT COUNT(*) AS count FROM attention_requests WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { count: number };
    expect(count).toEqual({ count: 1 });
  });

  it("blocks revoked, expired, epoch-mismatched, and read-only delegations", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "fence");
    await seedExecution(db, hub, "fence", runId, taskId);
    const input = {
      runId,
      kind: "clarification" as const,
      question: "Synthetic fence question",
      blocking: false,
    };
    const revoked = await seedDelegation(db);
    await revokeDelegation(db, FIX.workspace, revoked, NOW);
    expect(
      err(await hub.execute(requestDelegatedAttentionCommand, delegated("fence-revoked", revoked, input))),
    ).toBe("forbidden");
    const expired = await seedDelegation(db, { expiresAt: NOW });
    expect(
      err(
        await hub.execute(
          requestDelegatedAttentionCommand,
          delegated("fence-expired", expired, input, FIX.owner, LATER),
        ),
      ),
    ).toBe("forbidden");
    const readOnly = await seedDelegation(db, { scopes: ["bfb:read", "offline_access"] });
    expect(
      err(await hub.execute(requestDelegatedAttentionCommand, delegated("fence-readonly", readOnly, input))),
    ).toBe("insufficient_scope");
    const stale = await seedDelegation(db);
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    expect(err(await hub.execute(requestDelegatedAttentionCommand, delegated("fence-stale", stale, input)))).toBe(
      "stale_authorization",
    );
    expect(
      err(await hub.execute(requestDelegatedAttentionCommand, human("fence-direct", input))),
    ).toBe("forbidden");
  });
});

describe("delegated result submission", () => {
  it("submits with human attribution and never mints agent_run identity", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { taskId, runId } = await createTaskAndRun(db, hub, "submit");
    const delegationId = await seedDelegation(db);
    const result = ok(
      await hub.execute(
        submitDelegatedResultCommand,
        delegated("submit-result", delegationId, {
          runId,
          summary: "Synthetic delegated submission",
          limitations: "Synthetic limits",
          evidenceRefs: [{ kind: "comment", ref: "synthetic-comment" }],
          gitBranch: "synthetic",
          gitCommit: COMMIT,
          gitDirty: false,
        }),
      ),
    );
    expect(result).toMatchObject({
      runResultState: "submitted",
      taskState: "review",
      runVersion: 2,
      taskVersion: 3,
    });
    expect(result.submission).toMatchObject({
      version: 1,
      summary: "Synthetic delegated submission",
      submitted_by_kind: "human",
      submitted_by_id: FIX.owner,
    });
    const stored = (await db
      .prepare(
        `SELECT submitted_by_kind, submitted_by_id, config_hash FROM result_submissions
         WHERE workspace_id = ? AND run_id = ?`,
      )
      .all(FIX.workspace, runId)) as Array<{
      submitted_by_kind: string;
      submitted_by_id: string;
      config_hash: string;
    }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.submitted_by_kind).toBe("human");
    expect(stored[0]?.submitted_by_id).toBe(FIX.owner);
    const agentRuns = (await db
      .prepare(
        `SELECT COUNT(*) AS count FROM result_submissions
         WHERE workspace_id = ? AND submitted_by_kind = 'agent_run'`,
      )
      .get(FIX.workspace)) as { count: number };
    expect(agentRuns).toEqual({ count: 0 });
    expect(await readRunState(db, runId)).toBe("submitted");
    expect(await readTaskState(db, taskId)).toBe("review");
  });

  it("matches the human command transitions and invalid-input codes on twin runs", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const first = await createTaskAndRun(db, hub, "twin-a");
    const second = await createTaskAndRun(db, hub, "twin-b");
    const delegationId = await seedDelegation(db);
    const humanOutcome = ok(
      await hub.execute(
        submitResultCommand,
        human("twin-human", { runId: first.runId, summary: "Synthetic twin submission" }),
      ),
    );
    const delegatedOutcome = ok(
      await hub.execute(
        submitDelegatedResultCommand,
        delegated("twin-delegated", delegationId, {
          runId: second.runId,
          summary: "Synthetic twin submission",
        }),
      ),
    );
    expect(delegatedOutcome.runResultState).toBe(humanOutcome.runResultState);
    expect(delegatedOutcome.taskState).toBe(humanOutcome.taskState);
    expect(delegatedOutcome.submission.version).toBe(humanOutcome.submission.version);
    for (const hash of [
      humanOutcome.submission.config_hash,
      delegatedOutcome.submission.config_hash,
    ]) {
      expect(hash.startsWith("sha256:")).toBe(true);
      expect(hash).toHaveLength(71);
    }
    const invalid: Array<{ input: Record<string, unknown>; code: string }> = [
      { input: { runId: second.runId, summary: "  " }, code: "invalid_argument" },
      { input: { runId: second.runId, summary: "x".repeat(2049) }, code: "invalid_argument" },
      {
        input: {
          runId: second.runId,
          summary: "ok",
          evidenceRefs: [
            { kind: "comment", ref: "dup" },
            { kind: "comment", ref: "dup" },
          ],
        },
        code: "invalid_argument",
      },
      {
        input: { runId: second.runId, summary: "ok", evidenceRefs: [{ kind: "Bad!", ref: "r" }] },
        code: "invalid_argument",
      },
      {
        input: { runId: second.runId, summary: "ok", gitCommit: "not-a-commit" },
        code: "invalid_argument",
      },
      {
        input: { runId: second.runId, summary: "ok", gitDirty: "yes" },
        code: "invalid_argument",
      },
      { input: { runId: randomUlid(), summary: "ok" }, code: "not_found" },
    ];
    for (const { input, code } of invalid) {
      const humanErr = err(await hub.execute(submitResultCommand, human(randomUlid(), input)));
      const delegatedErr = err(
        await hub.execute(submitDelegatedResultCommand, delegated(randomUlid(), delegationId, input)),
      );
      expect(humanErr).toBe(code);
      expect(delegatedErr).toBe(code);
    }
  });

  it("replays idempotent retries and refuses reviewer, foreign, and terminal submissions", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "idempotent");
    const foreign = await createTaskAndRun(db, hub, "foreign-submit", FIX.projectB);
    const delegationId = await seedDelegation(db);
    const input = { runId, summary: "Synthetic idempotent submission" };
    const first = ok(
      await hub.execute(submitDelegatedResultCommand, delegated("submit-once", delegationId, input)),
    );
    const second = ok(
      await hub.execute(
        submitDelegatedResultCommand,
        delegated("submit-once", delegationId, { ...input, summary: "Synthetic changed retry" }),
      ),
    );
    expect(second.submission.id).toBe(first.submission.id);
    const count = (await db
      .prepare(`SELECT COUNT(*) AS count FROM result_submissions WHERE workspace_id = ? AND run_id = ?`)
      .get(FIX.workspace, runId)) as { count: number };
    expect(count).toEqual({ count: 1 });
    expect(
      err(
        await hub.execute(
          submitDelegatedResultCommand,
          delegated("submit-again", delegationId, { ...input, summary: "Synthetic second version" }),
        ),
      ),
    ).toBe("invalid_transition");
    expect(
      err(
        await hub.execute(
          submitDelegatedResultCommand,
          delegated("submit-foreign", delegationId, { runId: foreign.runId, summary: "x" }),
        ),
      ),
    ).toBe("forbidden");
    const reviewer = await seedDelegation(db, { humanId: FIX.reviewer });
    const fresh = await createTaskAndRun(db, hub, "reviewer-run");
    expect(
      err(
        await hub.execute(
          submitDelegatedResultCommand,
          delegated("submit-reviewer", reviewer, { runId: fresh.runId, summary: "x" }),
        ),
      ),
    ).toBe("forbidden");
    const readOnly = await seedDelegation(db, {
      scopes: ["bfb:read", "offline_access"],
    });
    expect(
      err(
        await hub.execute(
          submitDelegatedResultCommand,
          delegated("submit-readonly", readOnly, { runId: fresh.runId, summary: "x" }),
        ),
      ),
    ).toBe("insufficient_scope");
    const revoked = await seedDelegation(db);
    await revokeDelegation(db, FIX.workspace, revoked, NOW);
    expect(
      err(
        await hub.execute(
          submitDelegatedResultCommand,
          delegated("submit-revoked", revoked, { runId: fresh.runId, summary: "x" }),
        ),
      ),
    ).toBe("forbidden");
  });
});

describe("delegated artifact publication", () => {
  function createInput(runId: string, overrides: Record<string, unknown> = {}) {
    return {
      artifactId: null,
      runId,
      format: "markdown",
      role: "review",
      declaredSize: 18,
      expectedDigest: DIGEST,
      grantSecretHash: mintUploadGrantSecret().secretHash,
      ...overrides,
    };
  }

  it("creates an uploading version plus a human-bound grant and keeps secrets out of D1", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "artifact");
    const delegationId = await seedDelegation(db);
    const minted = mintUploadGrantSecret();
    const created = ok(
      await hub.execute(
        createDelegatedArtifactCommand,
        delegated("artifact-create", delegationId, {
          ...createInput(runId),
          grantSecretHash: minted.secretHash,
        }),
      ),
    );
    expect(created).toMatchObject({ state: "uploading", format: "markdown", role: "review" });
    const grant = (await db
      .prepare(`SELECT human_id, run_id, grant_hash, consumed_at FROM artifact_upload_grants WHERE id = ?`)
      .get(created.upload_grant.grant_id)) as Record<string, unknown>;
    expect(grant).toMatchObject({
      human_id: FIX.owner,
      run_id: runId,
      grant_hash: artifactHash(minted.secret),
      consumed_at: null,
    });
    const dump = JSON.stringify({
      grants: await db.prepare(`SELECT * FROM artifact_upload_grants`).all(),
      versions: await db.prepare(`SELECT * FROM artifact_versions`).all(),
      audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
      idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
    });
    expect(dump.includes(minted.secret)).toBe(false);
  });

  it("mirrors the human command accept/reject boundary on twin fixtures", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "artifact-twin");
    const delegationId = await seedDelegation(db);
    const attempt = (
      command:
        | typeof createArtifactCommand
        | typeof createDelegatedArtifactCommand,
      input: Record<string, unknown>,
      extra: { humanId?: string; delegationId?: string } = {},
    ) =>
      hub.execute(command as never, {
        workspaceId: FIX.workspace,
        idempotencyKey: randomUlid(),
        authorizationEpoch: 1,
        actorHumanId: extra.humanId ?? FIX.owner,
        ...(extra.delegationId === undefined ? {} : { actorDelegationId: extra.delegationId }),
        now: NOW,
        input: input as never,
      } as never);
    const vectors: Array<{ input: Record<string, unknown>; code: string }> = [
      { input: createInput(runId, { format: "exe" }), code: "request_rejected" },
      { input: createInput(runId, { role: "viewer" }), code: "request_rejected" },
      { input: createInput(runId, { declaredSize: 0 }), code: "request_rejected" },
      {
        input: createInput(runId, { declaredSize: ARTIFACT_REVIEW_MAX_BYTES + 1 }),
        code: "request_rejected",
      },
      {
        input: createInput(runId, { role: "log", declaredSize: ARTIFACT_LOG_MAX_BYTES + 1 }),
        code: "request_rejected",
      },
      { input: createInput(runId, { expectedDigest: "not-a-digest" }), code: "request_rejected" },
      { input: createInput(runId, { grantSecretHash: "short" }), code: "request_rejected" },
      { input: createInput(runId, { runId: randomUlid() }), code: "request_rejected" },
      { input: createInput(runId, { artifactId: randomUlid() }), code: "request_rejected" },
      { input: createInput(runId, { extraField: true }), code: "request_rejected" },
    ];
    for (const { input, code } of vectors) {
      expect(err(await attempt(createArtifactCommand, input))).toBe(code);
      expect(err(await attempt(createDelegatedArtifactCommand, input, { delegationId }))).toBe(code);
    }
    expect(err(await attempt(createArtifactCommand, createInput(runId), { humanId: FIX.restricted }))).toBe(
      "forbidden",
    );
    const reviewerDelegation = await seedDelegation(db, {
      humanId: FIX.reviewer,
    });
    expect(
      err(
        await attempt(createDelegatedArtifactCommand, createInput(runId), {
          humanId: FIX.reviewer,
          delegationId: reviewerDelegation,
        }),
      ),
    ).toBe("forbidden");
  });

  it("requires a run-bound version inside the delegation boundary", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "artifact-bound");
    const foreign = await createTaskAndRun(db, hub, "artifact-foreign", FIX.projectB);
    const delegationId = await seedDelegation(db);
    expect(
      err(
        await hub.execute(
          createDelegatedArtifactCommand,
          delegated("artifact-norun", delegationId, { ...createInput(runId), runId: undefined }),
        ),
      ),
    ).toBe("request_rejected");
    expect(
      err(
        await hub.execute(
          createDelegatedArtifactCommand,
          delegated("artifact-foreign", delegationId, createInput(foreign.runId)),
        ),
      ),
    ).toBe("forbidden");
    const minted = mintUploadGrantSecret();
    const humanCreated = ok(
      await hub.execute(createArtifactCommand, human("artifact-human", {
        ...createInput(runId),
        runId: null,
        grantSecretHash: minted.secretHash,
      })),
    );
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: humanCreated.version_id,
      runId: null,
      role: "review",
      contentHash: DIGEST,
      r2Key: `workspaces/${FIX.workspace}/artifacts/sha256/${DIGEST}`,
      size: 18,
      now: NOW,
    });
    expect(
      err(
        await hub.execute(
          finalizeDelegatedArtifactCommand,
          delegated("finalize-runless-version", delegationId, {
            versionId: humanCreated.version_id,
            contentHash: DIGEST,
            size: 18,
          }),
        ),
      ),
    ).toBe("request_rejected");
  });

  it("finalizes a delegated version after a verified upload receipt", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "finalize");
    const delegationId = await seedDelegation(db);
    const minted = mintUploadGrantSecret();
    const created = ok(
      await hub.execute(
        createDelegatedArtifactCommand,
        delegated("finalize-create", delegationId, {
          ...createInput(runId),
          grantSecretHash: minted.secretHash,
        }),
      ),
    );
    expect(
      err(
        await hub.execute(
          finalizeDelegatedArtifactCommand,
          delegated("finalize-early", delegationId, {
            versionId: created.version_id,
            contentHash: DIGEST,
            size: 18,
          }),
        ),
      ),
    ).toBe("request_rejected");
    await recordVerifiedUpload(db, {
      workspaceId: FIX.workspace,
      versionId: created.version_id,
      runId,
      role: "review",
      contentHash: DIGEST,
      r2Key: `workspaces/${FIX.workspace}/artifacts/sha256/${DIGEST}`,
      size: 18,
      now: NOW,
    });
    const finalized = ok(
      await hub.execute(
        finalizeDelegatedArtifactCommand,
        delegated("finalize-version", delegationId, {
          versionId: created.version_id,
          contentHash: DIGEST,
          size: 18,
        }),
      ),
    );
    expect(finalized).toMatchObject({ state: "available", content_hash: DIGEST });
    expect(
      err(
        await hub.execute(
          finalizeDelegatedArtifactCommand,
          delegated("finalize-replay", delegationId, {
            versionId: created.version_id,
            contentHash: DIGEST,
            size: 18,
          }),
        ),
      ),
    ).toBe("request_rejected");
    expect(
      err(
        await hub.execute(
          finalizeArtifactCommand,
          human("finalize-human-replay", {
            versionId: created.version_id,
            contentHash: DIGEST,
            size: 18,
          }),
        ),
      ),
    ).toBe("request_rejected");
  });

  it("rejects replayed creation keys instead of minting a second grant", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const { runId } = await createTaskAndRun(db, hub, "artifact-replay");
    const delegationId = await seedDelegation(db);
    const minted = mintUploadGrantSecret();
    ok(
      await hub.execute(
        createDelegatedArtifactCommand,
        delegated("artifact-once", delegationId, {
          ...createInput(runId),
          grantSecretHash: minted.secretHash,
        }),
      ),
    );
    expect(
      err(
        await hub.execute(
          createDelegatedArtifactCommand,
          delegated("artifact-once", delegationId, {
            ...createInput(runId),
            grantSecretHash: mintUploadGrantSecret().secretHash,
          }),
        ),
      ),
    ).toBe("request_rejected");
  });
});

async function readRunState(db: SqlDatabase, runId: string): Promise<string> {
  const row = (await db
    .prepare(`SELECT result_state FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, runId)) as { result_state: string };
  return row.result_state;
}

async function readTaskState(db: SqlDatabase, taskId: string): Promise<string> {
  const row = (await db
    .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, taskId)) as { state: string };
  return row.state;
}
