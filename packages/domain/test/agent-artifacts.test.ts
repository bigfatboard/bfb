// ABOUTME: Proves canonical agent publication recovery, truthful provenance and fresh current authority.
// ABOUTME: Exercises shared human artifact effects and direct-D1 upload/receipt atomicity without provider turns.

import type { SqlDatabase } from "@bfb/db";
import type { AgentArtifactRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentArtifactPrepareCommand,
  agentArtifactFinalizeCommand,
  agentArtifactPrepareProjection,
} from "../src/agent-artifacts.js";
import { agentWorkKey } from "../src/agent-work.js";
import {
  artifactHash,
  mintUploadGrantSecret,
  redeemUploadGrant,
  recordVerifiedUpload,
  createArtifactCommand,
} from "../src/artifacts.js";
import { resolveCommand } from "../src/command-catalog.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { submitResultCommand, acceptResultCommand } from "../src/results.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";
import { resultFixture, resultStagedD1 } from "./result-fixture.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => vi.useRealTimers());
type Fixture = Awaited<ReturnType<typeof resultFixture>>;
const DIGEST = artifactHash("synthetic agent artifact");
const request = (f: Fixture, id = randomUlid()): AgentArtifactRequest => ({
  ...f.bound(id),
  format: "markdown",
  role: "review",
  declared_size: 24,
  expected_digest: DIGEST,
});
function prepare(
  f: Fixture,
  input = request(f),
  hub = f.hub,
  key = `artifact-prepare:${randomUlid()}`,
) {
  const minted = mintUploadGrantSecret();
  return {
    secret: minted.secret,
    outcome: hub.execute(agentArtifactPrepareCommand, {
      workspaceId: FIX.workspace,
      actorRunnerId: f.runner,
      authorizationEpoch: f.principal.authorizationEpoch,
      idempotencyKey: key,
      input: { principal: f.principal, request: input, grantSecretHash: minted.secretHash },
    }),
  };
}
const finalize = (f: Fixture, input: AgentArtifactRequest, hub = f.hub) =>
  hub.execute(agentArtifactFinalizeCommand, {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: f.principal.authorizationEpoch,
    idempotencyKey: agentWorkKey("publish_artifact", input.reference),
    input: { principal: f.principal, request: input },
  });
async function verified(f: Fixture, input = request(f), hub = f.hub, db = f.db) {
  const issued = prepare(f, input, hub),
    prepared = success(await issued.outcome);
  if (!prepared.upload) throw new Error("expected upload grant");
  const consumed = await db.withTransaction((tx) =>
    redeemUploadGrant(tx, {
      grantId: prepared.upload!.grant_id,
      secret: issued.secret,
      now: LAUNCH_NOW,
    }),
  );
  await db.withTransaction((tx) =>
    recordVerifiedUpload(tx, {
      grantId: consumed.grantId,
      consumeAttemptId: consumed.consumeAttemptId,
      contentHash: input.expected_digest,
      size: input.declared_size,
      now: LAUNCH_NOW,
    }),
  );
  return prepared;
}
async function rows(db: SqlDatabase) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "artifacts",
    "artifact_versions",
    "artifact_agent_operations",
    "artifact_agent_grants",
    "artifact_upload_grants",
    "artifact_upload_consumptions",
    "artifact_upload_receipts",
    "artifact_upload_receipt_sources",
    "artifact_objects",
    "artifact_audit_outbox",
  ])
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}
async function renewToken(f: Fixture) {
  const id = randomUlid(),
    claims = { ...f.claims, jti: id, token_epoch: 2 };
  await f.db.prepare("UPDATE runners SET token_epoch=2 WHERE id=?").run(f.runner);
  await f.db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id,runner_id,id,token_hash,claims_json,expires_at,revoked_at)
      SELECT workspace_id,runner_id,?,?,?,expires_at,NULL FROM runner_tokens WHERE id=?`,
    )
    .run(id, artifactHash(randomUlid()), JSON.stringify(claims), f.principal.tokenId);
  f.principal.tokenId = id;
  f.principal.tokenEpoch = 2;
}
async function close(f: Fixture, kind: string) {
  if (kind === "requester")
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.member);
  if (kind === "owner")
    await f.db
      .prepare("UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE human_id=?")
      .run(FIX.owner);
  if (kind === "token")
    await f.db
      .prepare("UPDATE runner_tokens SET revoked_at=? WHERE id=?")
      .run(LAUNCH_NOW, f.principal.tokenId);
  if (kind === "grant")
    await f.db
      .prepare(
        "DELETE FROM runner_project_grants WHERE workspace_id=? AND runner_id=? AND project_id=?",
      )
      .run(FIX.workspace, f.runner, FIX.projectA);
  if (kind === "session")
    await f.db
      .prepare("UPDATE provider_sessions SET state='ended',ended_at=? WHERE id=?")
      .run(LAUNCH_NOW, f.binding.provider_session_id);
  if (kind === "execution")
    await f.db
      .prepare(
        "UPDATE run_executions SET state='ended',end_reason='process_exit',ended_at=? WHERE id=?",
      )
      .run(LAUNCH_NOW, f.reference().run_execution_id);
  if (kind === "terminal")
    await f.db.prepare("UPDATE runs SET result_state='cancelled' WHERE id=?").run(f.launch.run_id);
  if (kind === "lease")
    await f.db
      .prepare("UPDATE checkout_leases SET expires_at=? WHERE execution_id=?")
      .run("2026-01-01T00:00:00.000Z", f.reference().run_execution_id);
  if (kind === "policy")
    await f.db
      .prepare(
        "UPDATE workspace_policies SET resource_version=resource_version+1 WHERE workspace_id=?",
      )
      .run(FIX.workspace);
  if (kind === "inventory")
    await f.db
      .prepare("UPDATE runner_inventories SET received_at=? WHERE runner_id=?")
      .run("2026-01-01T00:00:00.000Z", f.runner);
  if (kind === "profile")
    await f.db
      .prepare(
        "UPDATE agent_profiles SET provider='codex',resource_version=resource_version+1 WHERE id=?",
      )
      .run(f.profile.id);
  if (kind === "provider_identity")
    await f.db
      .prepare("UPDATE provider_sessions SET provider='codex' WHERE id=?")
      .run(f.binding.provider_session_id);
  if (kind === "session_identity")
    await f.db
      .prepare(
        "UPDATE provider_sessions SET observed_session_id='changed-observed-session' WHERE id=?",
      )
      .run(f.binding.provider_session_id);
  if (kind === "superseded") {
    // A synthetic later historical assignment isolates the explicit latest-
    // assignment fence while the original execution and its lease stay live.
    const executionId = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO run_executions (workspace_id,id,run_id,state,end_reason,resource_version,created_at,ended_at)
        VALUES (?, ?, ?, 'ended', 'process_exit', 1, ?, ?)`,
      )
      .run(FIX.workspace, executionId, f.launch.run_id, LAUNCH_NOW, LAUNCH_NOW);
    await f.db
      .prepare(
        `INSERT INTO execution_assignments
        (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,
         physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,
         runner_grant_epoch,runner_key_thumbprint,created_at)
        SELECT workspace_id,?,assignment_generation+1,run_id,task_id,project_id,runner_id,checkout_id,
          physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,
          runner_grant_epoch,runner_key_thumbprint,created_at FROM execution_assignments
        WHERE workspace_id=? AND execution_id=?`,
      )
      .run(executionId, FIX.workspace, f.reference().run_execution_id);
  }
}
const closures = [
  "requester",
  "owner",
  "token",
  "grant",
  "session",
  "execution",
  "terminal",
  "lease",
  "policy",
  "inventory",
];
const commitChanges = ["superseded", "profile", "provider_identity", "session_identity"];

describe("agent artifact canonical publication", () => {
  it("resolves both commands through the production catalog", () => {
    expect(resolveCommand("artifact.agent_prepare")).toBe(agentArtifactPrepareCommand);
    expect(resolveCommand("artifact.agent_finalize")).toBe(agentArtifactFinalizeCommand);
  });
  it("rejects unbound/foreign sessions and human actor substitution without a source lookup/effect", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f);
    const before = await rows(f.db);
    expect(
      await prepare(f, {
        ...input,
        binding: { ...input.binding, provider_session_id: randomUlid() },
      }).outcome,
    ).toMatchObject({ ok: false, error: { code: "session_conflict" } });
    const minted = mintUploadGrantSecret();
    expect(
      await f.hub.execute(agentArtifactPrepareCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { principal: f.principal, request: input, grantSecretHash: minted.secretHash },
      }),
    ).toMatchObject({ ok: false });
    expect(await rows(f.db)).toEqual(before);
  });
  it("keeps publication identity and cached origin across a current token renewal", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f);
    await verified(f, input);
    const original = success(await finalize(f, input));
    await renewToken(f);
    expect(success(await finalize(f, input))).toEqual(original);
    expect(success(await prepare(f, input).outcome)).toMatchObject({
      stage: "available",
      version_id: original.version_id,
      upload: null,
    });
    expect(await f.db.prepare("SELECT * FROM artifact_versions").all()).toHaveLength(1);
  });
  it("denies original private outcomes when a later assignment supersedes the still-live execution", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f);
    await verified(f, input);
    success(await finalize(f, input));
    await close(f, "superseded");
    const before = await rows(f.db);
    expect(await finalize(f, input)).toMatchObject({
      ok: false,
      error: { code: "assignment_ended" },
    });
    expect(await prepare(f, { ...input, expected_digest: "b".repeat(64) }).outcome).toMatchObject({
      ok: false,
      error: { code: "assignment_ended" },
    });
    expect(await rows(f.db)).toEqual(before);
  });
  it("recovers original version after lost prepare outcomes/cache deletion with fresh secret attempts", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f);
    const first = prepare(f, input),
      a = success(await first.outcome);
    await f.db
      .prepare("DELETE FROM idempotency_records WHERE command_name='artifact.agent_prepare'")
      .run();
    const second = prepare(f, input),
      b = success(await second.outcome);
    expect(b.version_id).toBe(a.version_id);
    expect(b.artifact_id).toBe(a.artifact_id);
    expect(b.upload?.grant_id).not.toBe(a.upload?.grant_id);
    expect(await f.db.prepare("SELECT * FROM artifact_versions").all()).toHaveLength(1);
    expect(await f.db.prepare("SELECT * FROM artifact_agent_operations").all()).toHaveLength(1);
    expect(
      await f.db.prepare("SELECT created_by_human_id FROM artifacts WHERE id=?").get(a.artifact_id),
    ).toEqual({ created_by_human_id: null });
    const projection = agentArtifactPrepareProjection(
      b,
      "https://artifacts.synthetic.test",
      second.secret,
    );
    expect(projection.stage).toBe("upload_required");
    const dump = JSON.stringify({
      ...(await rows(f.db)),
      cache: await f.db.prepare("SELECT result_json FROM idempotency_records").all(),
      audit: await f.db.prepare("SELECT payload_json FROM audit_events").all(),
      semantic: await f.db.prepare("SELECT payload_json FROM semantic_events").all(),
    });
    expect(dump).not.toContain(first.secret);
    expect(dump).not.toContain(second.secret);
    expect(() =>
      agentArtifactPrepareProjection(b, "https://artifacts.synthetic.test", first.secret),
    ).toThrow();
    expect(() =>
      agentArtifactPrepareProjection(b, "https://other.test/unsafe", second.secret),
    ).toThrow();
  });
  it("recovers physical receipt/finalized effects with no second version, upload or publication", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f);
    const original = await verified(f, input);
    const afterUpload = success(await prepare(f, input).outcome);
    expect(afterUpload).toMatchObject({
      version_id: original.version_id,
      stage: "finalize_required",
      upload: null,
    });
    const first = success(await finalize(f, input));
    expect(success(await finalize(f, input))).toEqual(first);
    await f.db
      .prepare("DELETE FROM idempotency_records WHERE command_name='artifact.agent_finalize'")
      .run();
    expect(success(await finalize(f, input))).toEqual(first);
    expect(success(await prepare(f, input).outcome)).toMatchObject({
      stage: "available",
      upload: null,
      available_at: first.available_at,
    });
    expect(await f.db.prepare("SELECT * FROM artifact_versions").all()).toHaveLength(1);
    expect(
      await f.db
        .prepare("SELECT * FROM artifact_audit_outbox WHERE action='artifact.finalized'")
        .all(),
    ).toHaveLength(1);
    expect(first.origin).toEqual({
      run_id: f.launch.run_id,
      run_execution_id: input.reference.run_execution_id,
      assignment_generation: input.reference.assignment_generation,
      provider_session_id: f.binding.provider_session_id,
    });
    expect(JSON.stringify(first)).not.toMatch(/secret|r2_key|path|upload/);
  });
  it.each(["digest", "size", "format", "role", "optional_target"])(
    "binds original %s across cache loss and fresh grant attempts",
    async (field) => {
      const f = await resultFixture(undefined, false),
        input = request(f),
        initial = success(await prepare(f, input).outcome);
      const changed = {
        ...input,
        ...(field === "digest"
          ? { expected_digest: "b".repeat(64) }
          : field === "size"
            ? { declared_size: 25 }
            : field === "format"
              ? { format: "diff" as const }
              : field === "role"
                ? { role: "log" as const }
                : { artifact_id: initial.artifact_id }),
      };
      const before = await rows(f.db);
      expect(await prepare(f, changed).outcome).toMatchObject({
        ok: false,
        error: { code: "request_conflict" },
      });
      expect(await finalize(f, changed)).toMatchObject({
        ok: false,
        error: { code: "request_conflict" },
      });
      expect(await rows(f.db)).toEqual(before);
    },
  );
  it("requires original target run/format/role and permits a new operation/version on an exact target", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f),
      first = await verified(f, input);
    success(await finalize(f, input));
    const second = success(
      await prepare(f, { ...request(f), artifact_id: first.artifact_id }).outcome,
    );
    expect(second.artifact_id).toBe(first.artifact_id);
    expect(second.version_id).not.toBe(first.version_id);
    const mint = mintUploadGrantSecret();
    const foreign = success(
      await f.human(createArtifactCommand, {
        format: "markdown",
        role: "review",
        declaredSize: 24,
        expectedDigest: DIGEST,
        grantSecretHash: mint.secretHash,
      }),
    );
    expect(
      await prepare(f, { ...request(f), artifact_id: foreign.artifact_id }).outcome,
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
  });
  it("allows still-active submitted runs through genuine result submission and denies after human accept", async () => {
    const f = await resultFixture(undefined, false);
    const submission = success(
      await f.hub.execute(submitResultCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { principal: f.principal, request: f.request() },
      }),
    );
    const input = request(f);
    await verified(f, input);
    const available = success(await finalize(f, input));
    success(
      await f.human(acceptResultCommand, {
        runId: f.launch.run_id,
        submissionId: submission.submission.id,
        expectedRunVersion: submission.runVersion,
        expectedTaskVersion: submission.taskVersion,
      }),
    );
    const before = await rows(f.db);
    expect(await finalize(f, input)).toMatchObject({
      ok: false,
      error: { code: "capability_closed" },
    });
    expect(await prepare(f, input).outcome).toMatchObject({
      ok: false,
      error: { code: "capability_closed" },
    });
    expect(available.state).toBe("available");
    expect(await rows(f.db)).toEqual(before);
  });
  it.each(closures)(
    "checks current %s before private cached outcomes and changed-input conflicts",
    async (kind) => {
      const f = await resultFixture(undefined, false),
        input = request(f);
      await verified(f, input);
      success(await finalize(f, input));
      await close(f, kind);
      const before = await rows(f.db);
      for (const attempt of [
        finalize(f, input),
        prepare(f, { ...input, expected_digest: "b".repeat(64) }).outcome,
      ]) {
        const outcome = await attempt;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("expected denial");
        expect(outcome.error.code).not.toBe("request_conflict");
      }
      expect(await rows(f.db)).toEqual(before);
    },
  );
  it("shares staged D1 effects atomically with provenance/grant/outcome rows", async () => {
    const f = await resultFixture(undefined, false),
      staged = resultStagedD1(f.db),
      hub = new WorkspaceHub(staged.db),
      input = request(f);
    const before = await rows(f.db);
    staged.fail(/INSERT INTO artifact_agent_grants/);
    expect(await prepare(f, input, hub).outcome).toMatchObject({ ok: false });
    expect(await rows(f.db)).toEqual(before);
    staged.fail();
    await verified(f, input, hub, staged.db);
    const physical = await rows(f.db);
    staged.fail(/INSERT INTO outbox_records/);
    expect(await finalize(f, input, hub)).toMatchObject({ ok: false });
    expect(await rows(f.db)).toEqual(physical);
    staged.fail();
    expect(success(await finalize(f, input, hub)).state).toBe("available");
  });

  it.each([
    "token",
    "grant",
    "requester",
    "session",
    "lease",
    "policy",
    "inventory",
    ...commitChanges,
  ])("rolls back new publication effects if %s changes at commit", async (kind) => {
    const f = await resultFixture(undefined, false),
      input = request(f);
    const before = await rows(f.db),
      staged = resultStagedD1(f.db, () => close(f, kind));
    expect(await prepare(f, input, new WorkspaceHub(staged.db)).outcome).toMatchObject({
      ok: false,
    });
    expect(await rows(f.db)).toEqual(before);
  });

  it.each([
    "token",
    "grant",
    "requester",
    "session",
    "lease",
    "policy",
    "inventory",
    ...commitChanges,
  ])(
    "retains physical facts without availability if %s changes at finalize commit",
    async (kind) => {
      const f = await resultFixture(undefined, false),
        input = request(f);
      await verified(f, input);
      const before = await rows(f.db),
        staged = resultStagedD1(f.db, () => close(f, kind));
      expect(await finalize(f, input, new WorkspaceHub(staged.db))).toMatchObject({ ok: false });
      expect(await rows(f.db)).toEqual(before);
    },
  );
});

describe("agent upload consumption authority", () => {
  it("denies an obsolete-token upload secret after renewal and issues a fresh explicit-retry grant", async () => {
    const f = await resultFixture(undefined, false),
      input = request(f),
      original = prepare(f, input),
      first = success(await original.outcome);
    await renewToken(f);
    const before = await rows(f.db);
    await expect(
      f.db.withTransaction((tx) =>
        redeemUploadGrant(tx, {
          grantId: first.upload!.grant_id,
          secret: original.secret,
          now: LAUNCH_NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(await rows(f.db)).toEqual(before);
    const retry = prepare(f, input),
      next = success(await retry.outcome);
    expect(next.version_id).toBe(first.version_id);
    expect(next.upload!.grant_id).not.toBe(first.upload!.grant_id);
    await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: next.upload!.grant_id,
        secret: retry.secret,
        now: LAUNCH_NOW,
      }),
    );
    expect(await f.db.prepare("SELECT * FROM artifact_versions").all()).toHaveLength(1);
    expect(await f.db.prepare("SELECT * FROM artifact_upload_consumptions").all()).toHaveLength(1);
    expect(
      await f.db
        .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE id=?")
        .get(first.upload!.grant_id),
    ).toEqual({ consumed_at: null });
  });
  it.each([...closures, ...commitChanges])(
    "rolls back the exact consume claim/audit when %s changes before batch commit",
    async (kind) => {
      const f = await resultFixture(undefined, false),
        issued = prepare(f),
        prepared = success(await issued.outcome);
      const staged = resultStagedD1(f.db, () => close(f, kind));
      const before = await rows(f.db);
      await expect(
        staged.db.withTransaction((tx) =>
          redeemUploadGrant(tx, {
            grantId: prepared.upload!.grant_id,
            secret: issued.secret,
            now: LAUNCH_NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(await rows(f.db)).toEqual(before);
    },
  );
  it.each(closures)(
    "denies upload before any body effect after current %s closes",
    async (kind) => {
      const f = await resultFixture(undefined, false),
        issued = prepare(f),
        prepared = success(await issued.outcome);
      await close(f, kind);
      await expect(
        f.db.withTransaction((tx) =>
          redeemUploadGrant(tx, {
            grantId: prepared.upload!.grant_id,
            secret: issued.secret,
            now: LAUNCH_NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(
        await f.db
          .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE id=?")
          .get(prepared.upload!.grant_id),
      ).toEqual({ consumed_at: null });
      expect(await f.db.prepare("SELECT * FROM artifact_upload_consumptions").all()).toEqual([]);
    },
  );
});
