// ABOUTME: Proves private attention and result delivery under current human, delegated and assignment authority.
// ABOUTME: Synthetic canaries exercise action grants, cache revocation and ACL-before-limit selection without activation.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentAttention } from "../src/agent-attention.js";
import { agentWorkKey } from "../src/agent-work.js";
import {
  answerAttentionCommand,
  getAttention,
  listAttention,
  listAttentionObservations,
  requestAttentionCommand,
  resolveAttentionCommand,
} from "../src/attention.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import {
  createDelegatedArtifactCommand,
  requestDelegatedAttentionCommand,
  submitDelegatedResultCommand,
} from "../src/remote-parity.js";
import {
  acceptResultCommand,
  authorizeResultEvidence,
  cancelRunCommand,
  listResultSubmissions,
  requestChangesCommand,
  submitResultCommand,
  type ResultSubmissionInput,
} from "../src/results.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { claimAnotherAttentionRun } from "./attention-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";
import { resultFixture, resultStagedD1 } from "./result-fixture.js";

type Fixture = Awaited<ReturnType<typeof captureFixture>>;
type Permission = "read" | "contribute" | "edit";
const CANARY = "SYNTHETIC-C11-PRIVATE-CHILD-CANARY";
const creatorOptions = { taskCreatorHumanId: FIX.member, requestingHumanId: FIX.owner };
const attentionFixture = () => captureFixture(undefined, false, false, creatorOptions);
const privateResultFixture = () => resultFixture(undefined, true, false, creatorOptions);
const access = (humanId = FIX.owner, authorizationEpoch = 1) => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

async function privatize(f: Fixture) {
  await f.db
    .prepare(
      `INSERT INTO task_privacy
    (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
}
async function grant(f: Fixture, permission: Permission, humanId = FIX.owner) {
  const id = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, id, f.task.id, humanId, permission, LAUNCH_NOW);
  return id;
}
async function revoke(db: SqlDatabase, id: string) {
  await db.prepare("UPDATE task_human_grants SET revoked_at = ? WHERE id = ?").run(LAUNCH_NOW, id);
}
function human<I, R>(
  f: Fixture,
  command: HubCommand<I, R>,
  input: I,
  actor = FIX.owner,
  key = randomUlid(),
) {
  return f.hub.execute(command, {
    workspaceId: FIX.workspace,
    actorHumanId: actor,
    authorizationEpoch: 1,
    idempotencyKey: key,
    now: LAUNCH_NOW,
    input,
  });
}
function attentionRequest(f: Fixture) {
  return { ...f.bound(), kind: "clarification" as const, question: CANARY, blocking: true };
}
function attentionOperation(f: Fixture, request = attentionRequest(f)) {
  return {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: f.principal.authorizationEpoch,
    idempotencyKey: agentWorkKey("attention-request", request.reference),
    now: LAUNCH_NOW,
    input: { principal: f.principal, request },
  };
}
function readAttention(f: Fixture, id: string) {
  return readAgentAttention(f.db, FIX.workspace, {
    principal: f.principal,
    request: { reference: f.reference(), binding: f.binding, attention_id: id },
  });
}
async function artifactEvidence(
  f: Fixture,
  runId: string | null = f.launch.run_id,
  workspaceId = FIX.workspace,
) {
  const artifactId = randomUlid(),
    versionId = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO artifacts
    (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
    VALUES (?, ?, ?, 'markdown', 'review', ?, ?)`,
    )
    .run(workspaceId, artifactId, runId, FIX.member, LAUNCH_NOW);
  // Synthetic immutable metadata only; no upload capability or real artifact bytes are created.
  await f.db
    .prepare(
      `INSERT INTO artifact_versions
    (workspace_id, id, artifact_id, state, format, declared_size, expected_digest,
     content_hash, r2_key, created_at, available_at)
    VALUES (?, ?, ?, 'available', 'markdown', 1, ?, ?, 'synthetic-c11-object', ?, ?)`,
    )
    .run(
      workspaceId,
      versionId,
      artifactId,
      "a".repeat(64),
      "a".repeat(64),
      LAUNCH_NOW,
      LAUNCH_NOW,
    );
  return { kind: "artifact_version", ref: artifactId, version: versionId };
}
async function otherRun(f: Fixture) {
  const request = await claimAnotherAttentionRun(f);
  return (await f.db
    .prepare(
      `SELECT run_id, task_id FROM execution_assignments
    WHERE workspace_id = ? AND execution_id = ? AND assignment_generation = ?`,
    )
    .get(
      FIX.workspace,
      request.reference.run_execution_id,
      request.reference.assignment_generation,
    )) as { run_id: string; task_id: string };
}
async function sharedResultRun(f: Fixture, projectId: string) {
  const task = success(
    await human(f, createTaskCommand, {
      projectId,
      title: "Synthetic evidence source task",
      priority: "P2",
    }),
  );
  const policy = (await f.db
    .prepare("SELECT MAX(version) AS version FROM workspace_policy_versions WHERE workspace_id = ?")
    .get(FIX.workspace)) as { version: number };
  const run = success(
    await human(f, createRunCommand, {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: policy.version,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    }),
  );
  return { run_id: run.run.id, task_id: task.id };
}
async function historicalEvidence(
  f: Fixture,
  submissionId: string,
  evidence: unknown,
  rawJson?: string,
) {
  const id = randomUlid();
  // Synthetic historical metadata represents an envelope accepted before current validation.
  await f.db
    .prepare(
      `INSERT INTO result_submissions
    (workspace_id, id, run_id, version, summary, limitations, evidence_refs_json,
     config_snapshot_id, config_hash, submitted_by_kind, submitted_by_id, submitted_at)
    SELECT workspace_id, ?, run_id, 2, summary, limitations, ?, config_snapshot_id, config_hash,
      submitted_by_kind, submitted_by_id, submitted_at FROM result_submissions WHERE id = ?`,
    )
    .run(id, rawJson ?? JSON.stringify(evidence), submissionId);
  return id;
}
async function delegation(
  f: Fixture,
  scopes = ["bfb:read", "bfb:task:write"],
  taskId: string | null = f.task.id,
) {
  const id = randomUlid();
  const expiry = (await f.db
    .prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes') AS expires_at`)
    .get()) as { expires_at: string };
  await f.db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id, id, human_id, client_id, resource, project_id, task_id,
     scopes_json, authorization_epoch, expires_at, created_at)
    VALUES (?, ?, ?, ?, 'https://bfb.example.test/mcp', ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      FIX.workspace,
      id,
      FIX.owner,
      FIX.client,
      FIX.projectA,
      taskId,
      JSON.stringify(scopes),
      expiry.expires_at,
      LAUNCH_NOW,
    );
  return id;
}
function delegated<I, R>(
  f: Fixture,
  command: HubCommand<I, R>,
  input: I,
  delegationId: string,
  key = randomUlid(),
) {
  return f.hub.execute(command, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    actorDelegationId: delegationId,
    authorizationEpoch: 1,
    idempotencyKey: key,
    now: LAUNCH_NOW,
    input,
  });
}

describe("private attention delivery", () => {
  it.each(["revoke", "expiry", "sponsor", "project", "boundary", "epoch"] as const)(
    "attention reads retain delegation %s at actual selection",
    async (change) => {
      const f = await attentionFixture();
      const request = success(await f.hub.execute(requestAttentionCommand, attentionOperation(f)));
      await privatize(f);
      await grant(f, "read");
      const delegationId = await delegation(f, ["bfb:read"]);
      const credential = { ...access(), delegationId, taskBoundaryId: f.task.id };
      expect(
        await getAttention(f.db, FIX.workspace, [FIX.projectA], request.id, credential),
      ).toMatchObject({ question: CANARY });
      expect(
        await listAttention(f.db, FIX.workspace, [FIX.projectA], { limit: 1 }, credential),
      ).toHaveLength(1);
      expect(
        await listAttentionObservations(
          f.db,
          FIX.workspace,
          [FIX.projectA],
          request.id,
          credential,
        ),
      ).toHaveLength(1);
      if (change === "revoke")
        await f.db
          .prepare("UPDATE oauth_delegations SET revoked_at = ? WHERE id = ?")
          .run(LAUNCH_NOW, delegationId);
      if (change === "expiry")
        await f.db
          .prepare("UPDATE oauth_delegations SET expires_at = ? WHERE id = ?")
          .run(LAUNCH_NOW, delegationId);
      if (change === "sponsor")
        await f.db
          .prepare("UPDATE oauth_delegations SET human_id = ? WHERE id = ?")
          .run(FIX.member, delegationId);
      if (change === "project")
        await f.db
          .prepare("UPDATE oauth_delegations SET project_id = ?, task_id = NULL WHERE id = ?")
          .run(FIX.projectB, delegationId);
      if (change === "boundary") {
        const unrelated = await otherRun(f);
        await f.db
          .prepare("UPDATE oauth_delegations SET task_id = ? WHERE id = ?")
          .run(unrelated.task_id, delegationId);
      }
      if (change === "epoch")
        await f.db
          .prepare("UPDATE oauth_delegations SET authorization_epoch = 2 WHERE id = ?")
          .run(delegationId);
      expect(
        await getAttention(f.db, FIX.workspace, [FIX.projectA], request.id, credential),
      ).toBeNull();
      expect(
        await listAttention(f.db, FIX.workspace, [FIX.projectA], { limit: 1 }, credential),
      ).toEqual([]);
      expect(
        await listAttentionObservations(
          f.db,
          FIX.workspace,
          [FIX.projectA],
          request.id,
          credential,
        ),
      ).toEqual([]);
    },
  );

  it("rejects credential revoke between upstream authentication and attention selection", async () => {
    const f = await attentionFixture();
    const request = success(await f.hub.execute(requestAttentionCommand, attentionOperation(f)));
    await privatize(f);
    await grant(f, "read");
    const delegationId = await delegation(f, ["bfb:read"]);
    let revoked = false;
    const readingDb = {
      ...f.db,
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            if (sql.includes("SELECT attention.* FROM attention_requests")) {
              await f.db
                .prepare("UPDATE oauth_delegations SET revoked_at = ? WHERE id = ?")
                .run(LAUNCH_NOW, delegationId);
              revoked = true;
            }
            return statement.get(...parameters);
          },
        };
      },
    };
    expect(
      await getAttention(readingDb, FIX.workspace, [FIX.projectA], request.id, {
        ...access(),
        delegationId,
        taskBoundaryId: f.task.id,
      }),
    ).toBeNull();
    expect(revoked).toBe(true);
  });

  it("hides content, observations and ranked slots from an unshared workspace owner", async () => {
    const f = await attentionFixture();
    const hidden = success(await f.hub.execute(requestAttentionCommand, attentionOperation(f)));
    const sharedBinding = await claimAnotherAttentionRun(f);
    const visible = success(
      await f.native(requestAttentionCommand, {
        principal: f.principal,
        request: {
          ...sharedBinding,
          kind: "clarification",
          question: "Synthetic shared question",
          blocking: false,
        },
      }),
    );
    await privatize(f);
    expect(await getAttention(f.db, FIX.workspace, [FIX.projectA], hidden.id, access())).toBeNull();
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA], randomUlid(), access()),
    ).toBeNull();
    expect(
      await listAttentionObservations(f.db, FIX.workspace, [FIX.projectA], hidden.id, access()),
    ).toEqual([]);
    const page = await listAttention(f.db, FIX.workspace, [FIX.projectA], { limit: 1 }, access());
    expect(page.map((record) => record.id)).toEqual([visible.id]);
    expect(JSON.stringify(page)).not.toContain(CANARY);
    expect(await getAttention(f.db, FIX.workspace, [FIX.projectA], hidden.id)).toBeNull();
    expect(await listAttention(f.db, FIX.workspace, [FIX.projectA])).toHaveLength(1);
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA], hidden.id, access(FIX.member)),
    ).toMatchObject({ question: CANARY });
    await grant(f, "read");
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA], hidden.id, access()),
    ).toMatchObject({ question: CANARY });
    expect(await getAttention(f.db, FIX.workspace, [], hidden.id, access())).toBeNull();
    expect(await getAttention(f.db, FIX.projectB, [FIX.projectA], hidden.id, access())).toBeNull();
  });

  it.each<Permission>(["read", "contribute", "edit"])(
    "%s grant intersects answering permission and cache revocation",
    async (permission) => {
      const f = await attentionFixture();
      const record = success(await f.hub.execute(requestAttentionCommand, attentionOperation(f)));
      await privatize(f);
      const grantId = await grant(f, permission);
      const input = { attentionId: record.id, expectedVersion: 1, answer: CANARY };
      const key = randomUlid();
      const outcome = await human(f, answerAttentionCommand, input, FIX.owner, key);
      if (permission === "read") {
        expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
        return;
      }
      expect(outcome).toMatchObject({ ok: true });
      expect(await human(f, answerAttentionCommand, input, FIX.owner, key)).toMatchObject({
        ok: true,
      });
      success(
        await human(f, resolveAttentionCommand, { attentionId: record.id, expectedVersion: 2 }),
      );
      await revoke(f.db, grantId);
      const denied = await human(f, answerAttentionCommand, input, FIX.owner, key);
      expect(denied).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(denied)).not.toContain(CANARY);
    },
  );

  it("keeps the required-role ceiling after a task grant", async () => {
    const f = await attentionFixture();
    const operation = attentionOperation(f);
    const record = success(
      await f.hub.execute(requestAttentionCommand, {
        ...operation,
        input: { ...operation.input, request: { ...operation.input.request, kind: "credential" } },
      }),
    );
    await privatize(f);
    await grant(f, "contribute", FIX.reviewer);
    expect(
      await human(
        f,
        answerAttentionCommand,
        { attentionId: record.id, expectedVersion: 1, answer: CANARY },
        FIX.reviewer,
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("fresh selection rejects stale project and membership authority", async () => {
    const f = await attentionFixture();
    const record = success(await f.hub.execute(requestAttentionCommand, attentionOperation(f)));
    await privatize(f);
    await grant(f, "read");
    await f.db
      .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
      .run(FIX.projectA);
    await f.db
      .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
      .run(FIX.projectA, FIX.owner);
    expect(await listAttention(f.db, FIX.workspace, [FIX.projectA], {}, access())).toEqual([]);
    await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
    expect(await getAttention(f.db, FIX.workspace, [FIX.projectA], record.id, access())).toBeNull();
  });

  it("uses assignment requester ACL for local reads/writes and fences cached replies", async () => {
    const f = await attentionFixture();
    const operation = attentionOperation(f);
    const record = success(await f.hub.execute(requestAttentionCommand, operation));
    await privatize(f);
    await expect(readAttention(f, record.id)).rejects.toMatchObject({ code: "revoked" });
    const grantId = await grant(f, "read");
    expect((await readAttention(f, record.id)).attention.question).toBe(CANARY);
    expect(await f.hub.execute(requestAttentionCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "revoked" },
    });
    await revoke(f.db, grantId);
    const contribute = await grant(f, "contribute");
    expect(await f.hub.execute(requestAttentionCommand, operation)).toMatchObject({ ok: true });
    await revoke(f.db, contribute);
    expect(await f.hub.execute(requestAttentionCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "revoked" },
    });
  });
  it("runner ownership cannot substitute for the retained requesting-human authority", async () => {
    const f = await captureFixture(undefined, false);
    const operation = attentionOperation(f);
    const record = success(await f.hub.execute(requestAttentionCommand, operation));
    await f.db
      .prepare(
        `INSERT INTO task_privacy
      (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
    expect(
      await getAttention(f.db, FIX.workspace, [FIX.projectA], record.id, access()),
    ).toMatchObject({ id: record.id });
    await expect(readAttention(f, record.id)).rejects.toMatchObject({ code: "revoked" });
    expect(await f.hub.execute(requestAttentionCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "revoked" },
    });
  });
});

describe("private result actions and delivery", () => {
  it.each<Permission>(["read", "contribute", "edit"])(
    "%s grant cannot widen submission or closing authority",
    async (permission) => {
      const f = await privateResultFixture();
      await privatize(f);
      await grant(f, permission);
      expect(
        await human(f, cancelRunCommand, { runId: f.launch.run_id, expectedRunVersion: 1 }),
      ).toMatchObject(
        permission === "edit" ? { ok: true } : { ok: false, error: { code: "not_found" } },
      );
      if (permission === "edit") return;
      const outcome = await human(f, submitResultCommand, {
        runId: f.launch.run_id,
        summary: CANARY,
      });
      expect(outcome).toMatchObject(
        permission === "read" ? { ok: false, error: { code: "not_found" } } : { ok: true },
      );
    },
  );

  it("result history is current-ACL selected and unscoped internal access is shared-only", async () => {
    const f = await privateResultFixture();
    success(
      await human(f, submitResultCommand, {
        runId: f.launch.run_id,
        summary: CANARY,
        limitations: CANARY,
      }),
    );
    await privatize(f);
    expect(
      await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id, new Map(), access()),
    ).toEqual([]);
    expect(await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id)).toEqual([]);
    expect(
      await listResultSubmissions(
        f.db,
        FIX.workspace,
        f.launch.run_id,
        new Map(),
        access(FIX.member),
      ),
    ).toMatchObject([{ summary: CANARY }]);
    const id = await grant(f, "read");
    expect(
      await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id, new Map(), access()),
    ).toMatchObject([{ summary: CANARY }]);
    await revoke(f.db, id);
    expect(
      await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id, new Map(), access()),
    ).toEqual([]);
    expect(
      await listResultSubmissions(f.db, FIX.projectB, f.launch.run_id, new Map(), access()),
    ).toEqual([]);
  });

  it("a read grant cannot decide results and reviewer grants cannot accept", async () => {
    const f = await privateResultFixture();
    const submitted = success(
      await human(f, submitResultCommand, { runId: f.launch.run_id, summary: CANARY }),
    );
    await privatize(f);
    const readId = await grant(f, "read");
    const input = {
      runId: f.launch.run_id,
      submissionId: submitted.submission.id,
      expectedRunVersion: submitted.runVersion,
      expectedTaskVersion: submitted.taskVersion,
    };
    expect(await human(f, acceptResultCommand, input)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await human(f, requestChangesCommand, input)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await revoke(f.db, readId);
    await grant(f, "contribute", FIX.reviewer);
    expect(await human(f, acceptResultCommand, input, FIX.reviewer)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await human(f, requestChangesCommand, input, FIX.reviewer)).toMatchObject({ ok: true });
  });

  it("contribute preserves human acceptance authority but cannot replay either private result after revoke", async () => {
    const f = await attentionFixture();
    await privatize(f);
    const grantId = await grant(f, "contribute");
    const submitKey = randomUlid(),
      reviewKey = randomUlid();
    const input = { runId: f.launch.run_id, summary: CANARY };
    const submitted = success(await human(f, submitResultCommand, input, FIX.owner, submitKey));
    const review = {
      runId: f.launch.run_id,
      submissionId: submitted.submission.id,
      expectedRunVersion: submitted.runVersion,
      expectedTaskVersion: submitted.taskVersion,
    };
    success(await human(f, acceptResultCommand, review, FIX.owner, reviewKey));
    expect(await human(f, submitResultCommand, input, FIX.owner, submitKey)).toMatchObject({
      ok: true,
    });
    expect(await human(f, acceptResultCommand, review, FIX.owner, reviewKey)).toMatchObject({
      ok: true,
    });
    await revoke(f.db, grantId);
    const denied = await human(f, submitResultCommand, input, FIX.owner, submitKey);
    expect(denied).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(denied)).not.toContain(CANARY);
    expect(await human(f, acceptResultCommand, review, FIX.owner, reviewKey)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("submission cache and local pending replay require fresh contribution authority", async () => {
    const f = await privateResultFixture();
    const request = f.request();
    const capture = await f.resultCapture(request);
    await privatize(f);
    const readId = await grant(f, "read");
    const operation = {
      workspaceId: FIX.workspace,
      actorRunnerId: f.runner,
      authorizationEpoch: 1,
      idempotencyKey: agentWorkKey("submit_result", request.reference),
      now: LAUNCH_NOW,
      input: { principal: f.principal, request, replayCapture: capture },
    };
    expect(await f.hub.execute(submitResultCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "revoked" },
    });
    await revoke(f.db, readId);
    const grantId = await grant(f, "contribute");
    success(await f.hub.execute(submitResultCommand, operation));
    expect(await f.hub.execute(submitResultCommand, operation)).toMatchObject({ ok: true });
    await revoke(f.db, grantId);
    const denied = await f.hub.execute(submitResultCommand, operation);
    expect(denied).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(JSON.stringify(denied)).not.toContain("PRIVATE_RESULT_SUMMARY");
  });
  it.each(["artifact_id", "version_id"] as const)(
    "a known private %s reference cannot be committed across tasks even when the submitter reads both",
    async (shape) => {
      const f = await attentionFixture();
      const target = await otherRun(f);
      const artifactRef = await artifactEvidence(f);
      const ref =
        shape === "version_id" ? { kind: artifactRef.kind, ref: artifactRef.version } : artifactRef;
      await privatize(f);
      await grant(f, "contribute");
      const input = { runId: target.run_id, summary: CANARY, evidenceRefs: [ref] };
      expect(await human(f, submitResultCommand, input)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      const delegationId = await delegation(f, undefined, target.task_id);
      expect(await delegated(f, submitDelegatedResultCommand, input, delegationId)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(
        await f.db.prepare("SELECT id FROM result_submissions WHERE run_id = ?").all(target.run_id),
      ).toEqual([]);
    },
  );
  it.each(["artifact_id", "version_id"] as const)(
    "historical result reads filter newly private %s refs without changing the saved submission",
    async (shape) => {
      const f = await attentionFixture();
      const target = await otherRun(f);
      const artifactRef = await artifactEvidence(f);
      const ref =
        shape === "version_id" ? { kind: artifactRef.kind, ref: artifactRef.version } : artifactRef;
      const unknown = { kind: "comment", ref: ref.ref, version: "opaque-comment-version" };
      const input = { runId: target.run_id, summary: CANARY, evidenceRefs: [ref, unknown] };
      const key = randomUlid();
      const original = success(await human(f, submitResultCommand, input, FIX.owner, key));
      const receipt = await f.db
        .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
        .get(key);
      expect(
        (await listResultSubmissions(f.db, FIX.workspace, target.run_id, new Map(), access()))[0]
          ?.evidence_refs,
      ).toEqual([ref, unknown]);
      await privatize(f);
      const hidden = await listResultSubmissions(
        f.db,
        FIX.workspace,
        target.run_id,
        new Map(),
        access(),
      );
      expect(hidden[0]?.evidence_refs).toEqual([unknown]);
      expect(hidden[0]?.outdated_reasons).toEqual([]);
      const cached = await human(f, submitResultCommand, input, FIX.owner, key);
      expect(cached).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(cached)).not.toContain(ref.ref);
      const saved = await f.db
        .prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?")
        .get(original.submission.id);
      expect(saved).toMatchObject({ evidence_refs_json: JSON.stringify([ref, unknown]) });
      await grant(f, "read");
      expect(
        (await listResultSubmissions(f.db, FIX.workspace, target.run_id, new Map(), access()))[0]
          ?.evidence_refs,
      ).toEqual([unknown]);
      expect(
        await f.db
          .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
          .get(key),
      ).toEqual(receipt);
    },
  );
  it.each(["artifact_id", "version_id"] as const)(
    "filters newly private cross-task %s evidence at content selection even with source read authority",
    async (shape) => {
      const f = await attentionFixture();
      const target = await otherRun(f);
      const artifactRef = await artifactEvidence(f);
      const ref =
        shape === "version_id" ? { kind: artifactRef.kind, ref: artifactRef.version } : artifactRef;
      const unknown = { kind: "comment", ref: "synthetic-opaque-comment" };
      const original = success(
        await human(f, submitResultCommand, {
          runId: target.run_id,
          summary: CANARY,
          evidenceRefs: [ref, unknown],
        }),
      );
      let privatized = false;
      const readingDb = {
        prepare(sql: string) {
          const statement = f.db.prepare(sql);
          return {
            ...statement,
            async get(...parameters: unknown[]) {
              if (sql.includes("SELECT run.id FROM runs AS run JOIN tasks AS task")) {
                await privatize(f);
                await grant(f, "read");
                privatized = true;
              }
              return statement.get(...parameters);
            },
          };
        },
      };
      const delivered = await listResultSubmissions(
        readingDb,
        FIX.workspace,
        target.run_id,
        new Map([[`artifact_version\n${artifactRef.ref}`, "synthetic-new-version"]]),
        access(),
      );
      expect(privatized).toBe(true);
      expect(delivered[0]?.evidence_refs).toEqual([unknown]);
      expect(delivered[0]?.outdated_reasons).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?")
          .get(original.submission.id),
      ).toMatchObject({ evidence_refs_json: JSON.stringify([ref, unknown]) });
    },
  );
  it("accepts exact canonical and version-ID evidence while keeping other kinds opaque", async () => {
    const f = await attentionFixture();
    const first = await artifactEvidence(f);
    await privatize(f);
    await grant(f, "contribute");
    const refs = [
      first,
      { kind: first.kind, ref: first.version },
      {
        kind: "external",
        ref: "synthetic-unknown-artifact",
        version: "synthetic-unknown-version",
      },
    ];
    expect(
      await human(f, submitResultCommand, {
        runId: f.launch.run_id,
        summary: CANARY,
        evidenceRefs: refs,
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id, new Map(), access()))[0]
        ?.evidence_refs,
    ).toEqual(refs);
    expect(
      (
        await listResultSubmissions(
          f.db,
          FIX.workspace,
          f.launch.run_id,
          new Map([[`artifact_version\n${first.ref}`, "synthetic-new-version"]]),
          access(),
        )
      )[0]?.outdated_reasons,
    ).toEqual(["evidence_changed"]);
  });

  it.each([
    "missing_artifact",
    "missing_version",
    "artifact_only",
    "missing_alias",
    "wrong_binding",
    "alias_with_version",
    "other_tenant",
    "dangling_run",
  ] as const)(
    "%s has one recognized-reference denial for human, delegated and local submission",
    async (kind) => {
      const f = await privateResultFixture();
      const first = await artifactEvidence(f),
        second = await artifactEvidence(f);
      const foreignWorkspace = randomUlid();
      await f.db
        .prepare(
          "INSERT INTO workspaces (id, slug, jurisdiction, created_at) VALUES (?, ?, 'eu', ?)",
        )
        .run(foreignWorkspace, `synthetic-evidence-${foreignWorkspace}`, LAUNCH_NOW);
      const foreign = await artifactEvidence(f, null, foreignWorkspace);
      const dangling = await artifactEvidence(f, randomUlid());
      const refs = {
        missing_artifact: { ...first, ref: randomUlid() },
        missing_version: { ...first, version: randomUlid() },
        artifact_only: { kind: first.kind, ref: first.ref },
        missing_alias: { kind: first.kind, ref: randomUlid() },
        wrong_binding: { ...first, version: second.version },
        alias_with_version: { kind: first.kind, ref: first.version, version: first.version },
        other_tenant: foreign,
        dangling_run: dangling,
      };
      const ref = refs[kind];
      const expected = {
        ok: false,
        error: { code: "not_found", message: "evidence artifact not found" },
      };
      const input = { runId: f.launch.run_id, summary: CANARY, evidenceRefs: [ref] };
      expect(await human(f, submitResultCommand, input)).toEqual(expected);
      const delegationId = await delegation(f);
      expect(await delegated(f, submitDelegatedResultCommand, input, delegationId)).toEqual(
        expected,
      );
      const request = { ...f.request(), evidence_refs: [ref] };
      expect(
        await f.hub.execute(submitResultCommand, {
          workspaceId: FIX.workspace,
          actorRunnerId: f.runner,
          authorizationEpoch: 1,
          idempotencyKey: agentWorkKey("submit_result", request.reference),
          now: LAUNCH_NOW,
          input: { principal: f.principal, request, replayCapture: await f.resultCapture(request) },
        }),
      ).toEqual(expected);
      expect(
        await f.db
          .prepare("SELECT id FROM result_submissions WHERE run_id = ?")
          .all(f.launch.run_id),
      ).toEqual([]);
    },
  );

  it("uses the same reference denial for hidden and readable private cross-task sources", async () => {
    const f = await attentionFixture();
    const target = await otherRun(f);
    const ref = await artifactEvidence(f);
    await privatize(f);
    const input = { runId: target.run_id, summary: CANARY, evidenceRefs: [ref] };
    const expected = {
      ok: false,
      error: { code: "not_found", message: "evidence artifact not found" },
    };
    expect(await human(f, submitResultCommand, input)).toEqual(expected);
    await grant(f, "read");
    expect(await human(f, submitResultCommand, input)).toEqual(expected);
    const delegationId = await delegation(f, undefined, target.task_id);
    expect(await delegated(f, submitDelegatedResultCommand, input, delegationId)).toEqual(expected);
  });

  it("suppresses historical invalid exact-version refs in content SQL without changing saved rows", async () => {
    const f = await attentionFixture();
    const first = await artifactEvidence(f),
      second = await artifactEvidence(f);
    const dangling = await artifactEvidence(f, randomUlid());
    const original = success(
      await human(f, submitResultCommand, { runId: f.launch.run_id, summary: CANARY }),
    );
    const opaque = { kind: "external", ref: first.ref, version: "opaque-version" };
    const invalid = [
      { ...first, ref: randomUlid() },
      { ...first, version: randomUlid() },
      { kind: first.kind, ref: first.ref },
      { kind: first.kind, ref: randomUlid() },
      { ...first, version: second.version },
      { kind: first.kind, ref: first.version, version: first.version },
      { kind: first.kind, ref: first.version, version: null },
      dangling,
    ];
    const refs = [...invalid, first, { kind: first.kind, ref: first.version }, opaque];
    const id = await historicalEvidence(f, original.submission.id, refs);
    const versions = new Map(
      invalid.map((ref) => [`artifact_version\n${ref.ref}`, "synthetic-new-version"]),
    );
    versions.set(`artifact_version\n${first.ref}`, first.version);
    const delivered = await listResultSubmissions(
      f.db,
      FIX.workspace,
      f.launch.run_id,
      versions,
      access(),
    );
    expect(delivered[0]?.evidence_refs).toEqual([
      first,
      { kind: first.kind, ref: first.version },
      opaque,
    ]);
    expect(delivered[0]?.outdated_reasons).toEqual([]);
    expect(
      await f.db.prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?").get(id),
    ).toEqual({ evidence_refs_json: JSON.stringify(refs) });
  });

  it("omits malformed historical elements before outdated flags without poisoning valid opaque refs", async () => {
    const f = await attentionFixture();
    const ref = await artifactEvidence(f);
    const original = success(
      await human(f, submitResultCommand, { runId: f.launch.run_id, summary: CANARY }),
    );
    const opaque = {
      kind: "external",
      ref: "synthetic-opaque-ref",
      version: "v1",
      hash: `sha256:${"b".repeat(64)}`,
    };
    const refs = [
      "scalar-not-json-object",
      null,
      42,
      false,
      [],
      {},
      { kind: ref.kind },
      { ref: ref.ref, version: ref.version },
      { ...ref, ref: null },
      { ...ref, kind: 1 },
      { ...ref, version: [] },
      { ...ref, extra: CANARY },
      { ...ref, hash: 1 },
      { ...ref, hash: "invalid-hash" },
      { ...ref, kind: " artifact_version " },
      { kind: "external", ref: null },
      { kind: "external", ref: "bad\u0001control" },
      ref,
      { kind: ref.kind, ref: ref.version },
      opaque,
    ];
    const id = await historicalEvidence(f, original.submission.id, refs);
    const views = await listResultSubmissions(
      f.db,
      FIX.workspace,
      f.launch.run_id,
      new Map([[`external\n${opaque.ref}`, "v2"]]),
      access(),
    );
    expect(views[0]?.evidence_refs).toEqual([ref, { kind: ref.kind, ref: ref.version }, opaque]);
    expect(views[0]?.outdated_reasons).toEqual(["evidence_changed"]);
    expect(
      await f.db.prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?").get(id),
    ).toEqual({ evidence_refs_json: JSON.stringify(refs) });
  });

  it.each(["string", "object", "null", "number", "oversized"] as const)(
    "normalizes %s historical envelope to no evidence without rewriting it",
    async (kind) => {
      const f = await attentionFixture();
      const ref = await artifactEvidence(f);
      const original = success(
        await human(f, submitResultCommand, { runId: f.launch.run_id, summary: CANARY }),
      );
      const envelope = {
        string: "scalar",
        object: ref,
        null: null,
        number: 1,
        oversized: Array.from({ length: 21 }, () => ref),
      }[kind];
      const id = await historicalEvidence(f, original.submission.id, envelope);
      const views = await listResultSubmissions(
        f.db,
        FIX.workspace,
        f.launch.run_id,
        new Map(),
        access(),
      );
      expect(views[0]?.evidence_refs).toEqual([]);
      expect(views[0]?.outdated_reasons).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?")
          .get(id),
      ).toEqual({ evidence_refs_json: JSON.stringify(envelope) });
    },
  );

  it("omits duplicate historical keys whose SQL and JSON identities disagree", async () => {
    const f = await attentionFixture();
    const target = await otherRun(f);
    const ref = await artifactEvidence(f);
    const original = success(
      await human(f, submitResultCommand, { runId: target.run_id, summary: CANARY }),
    );
    await privatize(f);
    const opaque = { kind: "external", ref: "synthetic-opaque-duplicate-control" };
    const raw = `[{"kind":"external","kind":"artifact_version","ref":${JSON.stringify(ref.ref)},"version":${JSON.stringify(ref.version)}},${JSON.stringify(opaque)}]`;
    const id = await historicalEvidence(f, original.submission.id, undefined, raw);
    const views = await listResultSubmissions(
      f.db,
      FIX.workspace,
      target.run_id,
      new Map(),
      access(),
    );
    expect(views[0]?.evidence_refs).toEqual([opaque]);
    expect(
      await f.db.prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?").get(id),
    ).toEqual({ evidence_refs_json: raw });
  });

  it.each(["own_run", "foreign_run", "run_free"] as const)(
    "local exact-version source remains %s scoped rather than sponsor-wide",
    async (kind) => {
      const f = await privateResultFixture();
      const sourceRun =
        kind === "foreign_run"
          ? (await otherRun(f)).run_id
          : kind === "run_free"
            ? null
            : f.launch.run_id;
      const ref = await artifactEvidence(f, sourceRun);
      const request = {
        ...f.request(),
        evidence_refs: [ref, { kind: ref.kind, ref: ref.version }],
      };
      const operation = {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: agentWorkKey("submit_result", request.reference),
        now: LAUNCH_NOW,
        input: { principal: f.principal, request, replayCapture: await f.resultCapture(request) },
      };
      const outcome = await f.hub.execute(submitResultCommand, operation);
      if (kind === "own_run") {
        expect(outcome).toMatchObject({ ok: true });
        expect(await f.hub.execute(submitResultCommand, operation)).toMatchObject({
          ok: true,
          replayed: true,
        });
      } else {
        expect(outcome).toEqual({
          ok: false,
          error: { code: "not_found", message: "evidence artifact not found" },
        });
        expect(
          await human(f, submitResultCommand, {
            runId: f.launch.run_id,
            summary: CANARY,
            evidenceRefs: [ref],
          }),
        ).toMatchObject({ ok: true });
      }
    },
  );

  it.each(["same_task", "other_task", "other_project", "run_free"] as const)(
    "delegated source selection retains %s credential boundary",
    async (kind) => {
      const f = await privateResultFixture();
      const sourceRun =
        kind === "other_task"
          ? (await otherRun(f)).run_id
          : kind === "other_project"
            ? (await sharedResultRun(f, FIX.projectB)).run_id
            : kind === "run_free"
              ? null
              : f.launch.run_id;
      const ref = await artifactEvidence(f, sourceRun);
      const delegationId = await delegation(f);
      const input = {
        runId: f.launch.run_id,
        summary: CANARY,
        evidenceRefs: [ref, { kind: ref.kind, ref: ref.version }],
      };
      const outcome = await delegated(f, submitDelegatedResultCommand, input, delegationId);
      if (kind === "same_task") expect(outcome).toMatchObject({ ok: true });
      else {
        expect(outcome).toEqual({
          ok: false,
          error: { code: "not_found", message: "evidence artifact not found" },
        });
        expect(await human(f, submitResultCommand, input)).toMatchObject({ ok: true });
      }
    },
  );

  it.each(["revocation", "expiry", "elapsed_expiry", "scope", "read_scope"] as const)(
    "delegated %s before source SELECT cannot use earlier authority",
    async (change) => {
      const f = await privateResultFixture();
      const ref = await artifactEvidence(f);
      const delegationId = await delegation(f);
      const credential = (await f.db
        .prepare(`SELECT expires_at FROM oauth_delegations WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, delegationId)) as { expires_at: string };
      let changed = false;
      const db: SqlDatabase = {
        ...f.db,
        withTransaction(fn) {
          return f.db.withTransaction((tx) =>
            fn({
              ...tx,
              prepare(sql) {
                const statement = tx.prepare(sql);
                return {
                  ...statement,
                  async get(...parameters: unknown[]) {
                    if (!changed && sql.includes("SELECT 1 AS authorized")) {
                      changed = true;
                      if (change === "elapsed_expiry")
                        vi.setSystemTime(new Date(credential.expires_at));
                      else {
                        const column =
                          change === "revocation"
                            ? "revoked_at"
                            : change === "expiry"
                              ? "expires_at"
                              : "scopes_json";
                        await tx
                          .prepare(`UPDATE oauth_delegations SET ${column} = ? WHERE id = ?`)
                          .run(
                            change === "scope"
                              ? JSON.stringify(["bfb:read"])
                              : change === "read_scope"
                                ? JSON.stringify(["bfb:task:write"])
                                : LAUNCH_NOW,
                            delegationId,
                          );
                      }
                    }
                    return statement.get(...parameters);
                  },
                };
              },
            }),
          );
        },
      };
      const outcome = await new WorkspaceHub(db).execute(submitDelegatedResultCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        actorDelegationId: delegationId,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: LAUNCH_NOW,
        input: { runId: f.launch.run_id, summary: CANARY, evidenceRefs: [ref] },
      });
      expect(changed).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "not_found", message: "evidence artifact not found" },
      });
      expect(
        await f.db
          .prepare("SELECT id FROM result_submissions WHERE run_id = ?")
          .all(f.launch.run_id),
      ).toEqual([]);
    },
  );

  it.each(["human", "delegated", "local"] as const)(
    "%s rechecks actual cached references after idempotency hydration",
    async (transport) => {
      for (const loss of ["privacy", "grant", "credential"] as const) {
        const f = await privateResultFixture();
        const target = transport === "human" ? await otherRun(f) : { run_id: f.launch.run_id };
        const ref = await artifactEvidence(f);
        let grantId: string | undefined;
        if (loss === "grant") {
          await privatize(f);
          grantId = await grant(f, "contribute");
        }
        // A private cross-task source is never valid, even with a grant.
        const runId = loss === "grant" ? f.launch.run_id : target.run_id;
        const delegationId = transport === "delegated" ? await delegation(f) : undefined;
        const key = randomUlid();
        const request = { ...f.request(), evidence_refs: [ref] };
        const input = { runId, summary: CANARY, evidenceRefs: [ref] };
        const operationKey =
          transport === "local" ? agentWorkKey("submit_result", request.reference) : key;
        const localInput = {
          principal: f.principal,
          request,
          replayCapture: transport === "local" ? await f.resultCapture(request) : undefined,
        };
        const operation = {
          workspaceId: FIX.workspace,
          authorizationEpoch: 1,
          idempotencyKey: operationKey,
          now: LAUNCH_NOW,
          ...(transport === "local" ? { actorRunnerId: f.runner } : { actorHumanId: FIX.owner }),
          ...(delegationId ? { actorDelegationId: delegationId } : {}),
        };
        if (transport === "local")
          success(await f.hub.execute(submitResultCommand, { ...operation, input: localInput }));
        else if (transport === "delegated")
          success(await f.hub.execute(submitDelegatedResultCommand, { ...operation, input }));
        else success(await f.hub.execute(submitResultCommand, { ...operation, input }));
        const before = await f.db
          .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
          .get(operationKey);
        let changed = false;
        const db: SqlDatabase = {
          ...f.db,
          withTransaction(fn) {
            return f.db.withTransaction((tx) =>
              fn({
                ...tx,
                prepare(sql) {
                  const statement = tx.prepare(sql);
                  return {
                    ...statement,
                    async get(...parameters: unknown[]) {
                      const result = await statement.get(...parameters);
                      if (
                        !changed &&
                        sql.includes("FROM idempotency_records") &&
                        parameters.includes(operationKey)
                      ) {
                        changed = true;
                        if (loss === "privacy")
                          await tx
                            .prepare(
                              "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
                            )
                            .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
                        else if (loss === "grant") await revoke(tx, grantId!);
                        else if (transport === "delegated")
                          await tx
                            .prepare("UPDATE oauth_delegations SET revoked_at=? WHERE id=?")
                            .run(LAUNCH_NOW, delegationId);
                        else if (transport === "local")
                          await tx
                            .prepare("UPDATE runner_tokens SET revoked_at=? WHERE id=?")
                            .run(LAUNCH_NOW, f.principal.tokenId);
                        else {
                          await tx
                            .prepare(
                              "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
                            )
                            .run(FIX.workspace, FIX.owner);
                          await tx
                            .prepare(
                              "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
                            )
                            .run(FIX.workspace, FIX.owner);
                        }
                      }
                      return result;
                    },
                  };
                },
              }),
            );
          },
        };
        const hub = new WorkspaceHub(db);
        const outcome =
          transport === "local"
            ? await hub.execute(submitResultCommand, { ...operation, input: localInput })
            : transport === "delegated"
              ? await hub.execute(submitDelegatedResultCommand, { ...operation, input })
              : await hub.execute(submitResultCommand, { ...operation, input });
        expect(changed).toBe(true);
        expect(outcome).toEqual({
          ok: false,
          error: { code: "not_found", message: "evidence artifact not found" },
        });
        expect(JSON.stringify(outcome)).not.toContain(CANARY);
        expect(
          await f.db
            .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
            .get(operationKey),
        ).toEqual(before);
      }
    },
  );

  it.each([
    "human_source",
    "human_role",
    "delegated",
    "delegated_read_scope",
    "delegated_write_scope",
    "local",
  ] as const)(
    "%s independent commit-time authority loss rolls back result and receipt",
    async (transport) => {
      const f = await privateResultFixture();
      const target = transport === "human_source" ? await otherRun(f) : { run_id: f.launch.run_id };
      const refs = [await artifactEvidence(f), await artifactEvidence(f)];
      const delegationId = transport.startsWith("delegated") ? await delegation(f) : undefined;
      const request = { ...f.request(), evidence_refs: refs };
      const localInput = {
        principal: f.principal,
        request,
        replayCapture: transport === "local" ? await f.resultCapture(request) : undefined,
      };
      const key =
        transport === "local" ? agentWorkKey("submit_result", request.reference) : randomUlid();
      let changed = false;
      const staged = resultStagedD1(f.db, async () => {
        changed = true;
        if (transport === "human_source") await privatize(f);
        else if (transport === "human_role")
          await f.db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.owner);
        else if (transport === "delegated")
          await f.db
            .prepare("UPDATE oauth_delegations SET revoked_at=? WHERE id=?")
            .run(LAUNCH_NOW, delegationId);
        else if (transport.startsWith("delegated"))
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE id=?")
            .run(
              JSON.stringify([
                transport === "delegated_read_scope" ? "bfb:task:write" : "bfb:read",
              ]),
              delegationId,
            );
        else
          await f.db
            .prepare("UPDATE runner_tokens SET revoked_at=? WHERE id=?")
            .run(LAUNCH_NOW, f.principal.tokenId);
      });
      const hub = new WorkspaceHub(staged.db);
      const operation = {
        workspaceId: FIX.workspace,
        authorizationEpoch: 1,
        idempotencyKey: key,
        now: LAUNCH_NOW,
        ...(transport === "local" ? { actorRunnerId: f.runner } : { actorHumanId: FIX.owner }),
        ...(delegationId ? { actorDelegationId: delegationId } : {}),
      };
      const input = { runId: target.run_id, summary: CANARY, evidenceRefs: refs };
      const outcome =
        transport === "local"
          ? await hub.execute(submitResultCommand, { ...operation, input: localInput })
          : transport.startsWith("delegated")
            ? await hub.execute(submitDelegatedResultCommand, { ...operation, input })
            : await hub.execute(submitResultCommand, { ...operation, input });
      expect(changed).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(
        await f.db.prepare("SELECT id FROM result_submissions WHERE run_id=?").all(target.run_id),
      ).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT idempotency_key FROM idempotency_records WHERE idempotency_key=?")
          .all(key),
      ).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT audit_id FROM audit_events WHERE action LIKE 'result.submit%'")
          .all(),
      ).toEqual([]);
      expect(await f.db.prepare("SELECT id FROM artifact_mutation_guards").all()).toEqual([]);
      expect(await f.db.prepare("SELECT id FROM runner_mutation_guards").all()).toEqual([]);
      expect(
        await f.db.prepare("SELECT result_state FROM runs WHERE id=?").get(target.run_id),
      ).toEqual({ result_state: "open" });
      expect(
        await f.db
          .prepare("SELECT state FROM tasks WHERE id=(SELECT task_id FROM runs WHERE id=?)")
          .get(target.run_id),
      ).toEqual({ state: "active" });
      expect(
        await f.db
          .prepare("SELECT event_id FROM semantic_events WHERE kind LIKE 'result.submit%'")
          .all(),
      ).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT outbox_id FROM outbox_records WHERE kind LIKE 'result.submit%'")
          .all(),
      ).toEqual([]);
    },
  );

  it.each(["human", "delegated", "local"] as const)(
    "%s authorizes cached payload references rather than only original input",
    async (transport) => {
      for (const corruption of [
        "unknown_reference",
        "malformed_reference",
        "wrong_parent",
      ] as const) {
        const f = await privateResultFixture();
        const input = { runId: f.launch.run_id, summary: CANARY, evidenceRefs: [] };
        const request = { ...f.request(), evidence_refs: [] };
        const localInput = {
          principal: f.principal,
          request,
          replayCapture: transport === "local" ? await f.resultCapture(request) : undefined,
        };
        const delegationId = transport === "delegated" ? await delegation(f) : undefined;
        const key =
          transport === "local" ? agentWorkKey("submit_result", request.reference) : randomUlid();
        const operation = {
          workspaceId: FIX.workspace,
          authorizationEpoch: 1,
          idempotencyKey: key,
          now: LAUNCH_NOW,
          ...(transport === "local" ? { actorRunnerId: f.runner } : { actorHumanId: FIX.owner }),
          ...(delegationId ? { actorDelegationId: delegationId } : {}),
        };
        if (transport === "local")
          success(await f.hub.execute(submitResultCommand, { ...operation, input: localInput }));
        else if (transport === "delegated")
          success(await f.hub.execute(submitDelegatedResultCommand, { ...operation, input }));
        else success(await f.hub.execute(submitResultCommand, { ...operation, input }));
        const cached = (await f.db
          .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key=?")
          .get(key)) as { result_json: string };
        const parsed = JSON.parse(cached.result_json);
        if (corruption === "wrong_parent") parsed.result.submission.run_id = randomUlid();
        else
          parsed.result.submission.evidence_refs =
            corruption === "malformed_reference"
              ? [{ kind: "artifact_version", ref: null, unknown: CANARY }]
              : [{ kind: "artifact_version", ref: randomUlid(), version: randomUlid() }];
        const stored = JSON.stringify(parsed);
        // Synthetic corrupt historical cache, not a production receipt rewrite.
        await f.db
          .prepare("UPDATE idempotency_records SET result_json=? WHERE idempotency_key=?")
          .run(stored, key);
        const outcome =
          transport === "local"
            ? await f.hub.execute(submitResultCommand, { ...operation, input: localInput })
            : transport === "delegated"
              ? await f.hub.execute(submitDelegatedResultCommand, { ...operation, input })
              : await f.hub.execute(submitResultCommand, { ...operation, input });
        expect(outcome).toEqual({
          ok: false,
          error: { code: "not_found", message: "evidence artifact not found" },
        });
        expect(
          await f.db
            .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key=?")
            .get(key),
        ).toEqual({ result_json: stored });
      }
    },
  );

  it("selects every exact source together instead of retaining earlier reference authority", async () => {
    const f = await privateResultFixture();
    const target = await otherRun(f);
    const refs = [await artifactEvidence(f), await artifactEvidence(f)];
    let selections = 0;
    const db: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            if (sql.includes("SELECT 1 AS authorized")) {
              selections++;
              if (selections === 2) await privatize(f);
            }
            return statement.get(...parameters);
          },
        };
      },
    };
    await authorizeResultEvidence(
      db,
      FIX.workspace,
      target.task_id,
      refs,
      access(),
      undefined,
      target.run_id,
    );
    expect(selections).toBe(1);
    await privatize(f);
    await expect(
      authorizeResultEvidence(
        f.db,
        FIX.workspace,
        target.task_id,
        refs,
        access(),
        undefined,
        target.run_id,
      ),
    ).rejects.toMatchObject({ code: "not_found", message: "evidence artifact not found" });
  });

  it.each(["human", "delegated", "local"] as const)(
    "%s invalid reference retry is denied before cached delivery",
    async (transport) => {
      const f = await privateResultFixture();
      const ref = { kind: "artifact_version", ref: randomUlid(), version: randomUlid() };
      const input = { runId: f.launch.run_id, summary: CANARY, evidenceRefs: [ref] };
      const key = randomUlid();
      const request = { ...f.request(), evidence_refs: [ref] };
      const capture = transport === "local" ? await f.resultCapture(request) : undefined;
      const original = success(
        await human(f, submitResultCommand, { runId: f.launch.run_id, summary: CANARY }),
      );
      const command =
        transport === "delegated" ? submitDelegatedResultCommand : submitResultCommand;
      const requestInput =
        transport === "local" ? { principal: f.principal, request, replayCapture: capture } : input;
      const delegationId = transport === "delegated" ? await delegation(f) : undefined;
      const stored = JSON.stringify({
        result: { ...original, submission: { ...original.submission, evidence_refs: [ref] } },
        cursor: 1,
        authorizationEpoch: 1,
        ...(transport === "local" ? { actorRunnerId: f.runner } : { actorHumanId: FIX.owner }),
        ...(delegationId ? { actorDelegationId: delegationId } : {}),
        inputFingerprint: command.inputFingerprint!(requestInput as never),
      });
      // Synthetic pre-reservation cache metadata; production never rewrites this receipt.
      const operationKey =
        transport === "local" ? agentWorkKey("submit_result", request.reference) : key;
      await f.db
        .prepare(
          "INSERT INTO idempotency_records (workspace_id, idempotency_key, command_name, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(FIX.workspace, operationKey, command.name, stored, LAUNCH_NOW);
      const denied =
        transport === "local"
          ? await f.hub.execute(submitResultCommand, {
              workspaceId: FIX.workspace,
              actorRunnerId: f.runner,
              authorizationEpoch: 1,
              idempotencyKey: operationKey,
              now: LAUNCH_NOW,
              input: requestInput as ResultSubmissionInput,
            })
          : transport === "delegated"
            ? await delegated(f, submitDelegatedResultCommand, input, delegationId!, key)
            : await human(f, submitResultCommand, input, FIX.owner, key);
      expect(denied).toEqual({
        ok: false,
        error: { code: "not_found", message: "evidence artifact not found" },
      });
      expect(JSON.stringify(denied)).not.toContain(CANARY);
      expect(
        await f.db
          .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
          .get(operationKey),
      ).toEqual({ result_json: stored });
    },
  );

  it.each(["grant", "project", "epoch"] as const)(
    "run-free exact references retain destination %s authority before cache",
    async (change) => {
      const f = await attentionFixture();
      const ref = await artifactEvidence(f, null);
      await privatize(f);
      const grantId = await grant(f, "contribute");
      const input = {
        runId: f.launch.run_id,
        summary: CANARY,
        evidenceRefs: [ref, { kind: ref.kind, ref: ref.version }],
      };
      const key = randomUlid();
      success(await human(f, submitResultCommand, input, FIX.owner, key));
      expect(
        (await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id, new Map(), access()))[0]
          ?.evidence_refs,
      ).toEqual(input.evidenceRefs);
      if (change === "grant") await revoke(f.db, grantId);
      if (change === "project") {
        await f.db
          .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
          .run(FIX.projectA);
        await f.db
          .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
          .run(FIX.projectA, FIX.owner);
      }
      if (change === "epoch") await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
      await expect(
        authorizeResultEvidence(f.db, FIX.workspace, f.task.id, [ref], access()),
      ).rejects.toMatchObject({ code: "not_found", message: "evidence artifact not found" });
      const denied = await human(f, submitResultCommand, input, FIX.owner, key);
      expect(denied.ok).toBe(false);
      expect(JSON.stringify(denied)).not.toContain(CANARY);
      expect(
        await listResultSubmissions(f.db, FIX.workspace, f.launch.run_id, new Map(), access()),
      ).toEqual([]);
    },
  );

  it("rechecks run-free destination authority in the exact-reference selection", async () => {
    const f = await attentionFixture();
    const ref = await artifactEvidence(f, null);
    await privatize(f);
    const grantId = await grant(f, "contribute");
    await authorizeResultEvidence(f.db, FIX.workspace, f.task.id, [ref], access());
    let revoked = false;
    const readingDb: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters: unknown[]) {
            if (sql.includes("SELECT 1 AS authorized")) {
              await revoke(f.db, grantId);
              revoked = true;
            }
            return statement.get(...parameters);
          },
        };
      },
    };
    await expect(
      authorizeResultEvidence(readingDb, FIX.workspace, f.task.id, [ref], access()),
    ).rejects.toMatchObject({ code: "not_found", message: "evidence artifact not found" });
    expect(revoked).toBe(true);
  });
});

describe("private delegated child commands", () => {
  it.each(["attention", "result"] as const)(
    "%s missing and private-denied runs have the same public error",
    async (kind) => {
      const f = await privateResultFixture();
      await privatize(f);
      const delegationId = await delegation(f);
      const runCommand = (runId: string) =>
        kind === "attention"
          ? delegated(
              f,
              requestDelegatedAttentionCommand,
              { runId, kind: "clarification", question: CANARY, blocking: true },
              delegationId,
            )
          : delegated(f, submitDelegatedResultCommand, { runId, summary: CANARY }, delegationId);
      const missing = await runCommand(randomUlid());
      const hidden = await runCommand(f.launch.run_id);
      expect(hidden).toEqual(missing);
      expect(hidden).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "run not found" },
      });
    },
  );
  it.each<Permission>(["read", "contribute", "edit"])(
    "%s grant intersects delegation write scope for attention and results",
    async (permission) => {
      const f = await privateResultFixture();
      await privatize(f);
      const grantId = await grant(f, permission);
      const delegationId = await delegation(f);
      const attentionInput = {
        runId: f.launch.run_id,
        kind: "clarification" as const,
        question: CANARY,
        blocking: true,
      };
      const key = randomUlid();
      const requested = await delegated(
        f,
        requestDelegatedAttentionCommand,
        attentionInput,
        delegationId,
        key,
      );
      expect(requested).toMatchObject(
        permission === "read" ? { ok: false, error: { code: "not_found" } } : { ok: true },
      );
      const submitted = await delegated(
        f,
        submitDelegatedResultCommand,
        { runId: f.launch.run_id, summary: CANARY },
        delegationId,
      );
      expect(submitted).toMatchObject(
        permission === "read" ? { ok: false, error: { code: "not_found" } } : { ok: true },
      );
      await revoke(f.db, grantId);
      expect(
        await delegated(f, requestDelegatedAttentionCommand, attentionInput, delegationId, key),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
    },
  );

  it("task contribution cannot widen scope, task boundary or bound epoch", async () => {
    const f = await privateResultFixture();
    const unrelated = await otherRun(f);
    await privatize(f);
    await grant(f, "contribute");
    const input = { runId: f.launch.run_id, summary: CANARY };
    const readOnly = await delegation(f, ["bfb:read"]);
    expect(await delegated(f, submitDelegatedResultCommand, input, readOnly)).toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
    const outside = await delegation(f, undefined, unrelated.task_id);
    expect(await delegated(f, submitDelegatedResultCommand, input, outside)).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    const current = await delegation(f);
    await bumpMemberEpoch(f.db, FIX.workspace, FIX.owner);
    expect(await delegated(f, submitDelegatedResultCommand, input, current)).toMatchObject({
      ok: false,
      error: { code: "stale_authorization" },
    });
  });

  it("delegated artifact issue uses the same current contribute parent guard", async () => {
    const f = await privateResultFixture();
    await privatize(f);
    const delegationId = await delegation(f);
    const id = await grant(f, "read");
    const input = {
      runId: f.launch.run_id,
      format: "markdown" as const,
      role: "review" as const,
      declaredSize: 1,
      expectedDigest: "a".repeat(64),
      grantSecretHash: "b".repeat(64),
    };
    expect(await delegated(f, createDelegatedArtifactCommand, input, delegationId)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    await revoke(f.db, id);
    await grant(f, "contribute");
    success(await delegated(f, createDelegatedArtifactCommand, input, delegationId));
  });
});
