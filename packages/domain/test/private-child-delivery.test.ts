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
import type { HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  createDelegatedArtifactCommand,
  requestDelegatedAttentionCommand,
  submitDelegatedResultCommand,
} from "../src/remote-parity.js";
import {
  acceptResultCommand,
  cancelRunCommand,
  listResultSubmissions,
  requestChangesCommand,
  submitResultCommand,
} from "../src/results.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { claimAnotherAttentionRun } from "./attention-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";
import { resultFixture } from "./result-fixture.js";

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
async function artifactEvidence(f: Fixture) {
  const artifactId = randomUlid(),
    versionId = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO artifacts
    (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
    VALUES (?, ?, ?, 'markdown', 'review', ?, ?)`,
    )
    .run(FIX.workspace, artifactId, f.launch.run_id, FIX.member, LAUNCH_NOW);
  // Synthetic immutable metadata only; no upload capability or real artifact bytes are created.
  await f.db
    .prepare(
      `INSERT INTO artifact_versions
    (workspace_id, id, artifact_id, state, format, declared_size, expected_digest,
     content_hash, r2_key, created_at, available_at)
    VALUES (?, ?, ?, 'available', 'markdown', 1, ?, ?, 'synthetic-c11-object', ?, ?)`,
    )
    .run(
      FIX.workspace,
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
async function delegation(
  f: Fixture,
  scopes = ["bfb:read", "bfb:task:write"],
  taskId: string | null = f.task.id,
) {
  const id = randomUlid();
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
      "2026-09-12T13:00:00.000Z",
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
      const unknown = { kind: "comment", ref: "synthetic-opaque-comment" };
      const input = { runId: target.run_id, summary: CANARY, evidenceRefs: [ref, unknown] };
      const key = randomUlid();
      const original = success(await human(f, submitResultCommand, input, FIX.owner, key));
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
      ).toEqual([ref, unknown]);
    },
  );
  it.each(["artifact_id", "version_id"] as const)(
    "selects %s evidence with current source authority after the target precheck",
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
      await privatize(f);
      const grantId = await grant(f, "read");
      let revoked = false;
      const readingDb = {
        prepare(sql: string) {
          const statement = f.db.prepare(sql);
          return {
            ...statement,
            async get(...parameters: unknown[]) {
              if (sql.includes("SELECT run.id FROM runs AS run JOIN tasks AS task")) {
                await revoke(f.db, grantId);
                revoked = true;
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
      expect(revoked).toBe(true);
      expect(delivered[0]?.evidence_refs).toEqual([unknown]);
      expect(delivered[0]?.outdated_reasons).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT evidence_refs_json FROM result_submissions WHERE id = ?")
          .get(original.submission.id),
      ).toMatchObject({ evidence_refs_json: JSON.stringify([ref, unknown]) });
    },
  );
  it("recognized bound versions belong to the named artifact while missing refs stay opaque", async () => {
    const f = await attentionFixture();
    const first = await artifactEvidence(f),
      second = await artifactEvidence(f);
    await privatize(f);
    await grant(f, "contribute");
    expect(
      await human(f, submitResultCommand, {
        runId: f.launch.run_id,
        summary: CANARY,
        evidenceRefs: [{ ...first, version: second.version }],
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(
      await human(f, submitResultCommand, {
        runId: f.launch.run_id,
        summary: CANARY,
        evidenceRefs: [
          first,
          { kind: first.kind, ref: first.version },
          {
            kind: "artifact_version",
            ref: "synthetic-unknown-artifact",
            version: "synthetic-unknown-version",
          },
        ],
      }),
    ).toMatchObject({ ok: true });
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
