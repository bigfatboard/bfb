// ABOUTME: Proves artifact agents use the authenticated requesting human's private-task authority.
// ABOUTME: Synthetic run grants exercise cached, upload-consume and publication commit revocation.

import type { AgentArtifactRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentArtifactPrepareCommand,
  agentArtifactFinalizeCommand,
} from "../src/agent-artifacts.js";
import { agentWorkKey } from "../src/agent-work.js";
import {
  artifactHash,
  mintUploadGrantSecret,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";
import { resultFixture, resultStagedD1 } from "./result-fixture.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(LAUNCH_NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture(permission?: "read" | "contribute") {
  const f = await resultFixture(undefined, false, false, {
    taskCreatorHumanId: FIX.owner,
    requestingHumanId: FIX.member,
  });
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
  let grantId: string | undefined;
  async function grant(value: "read" | "contribute") {
    grantId = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)",
      )
      .run(FIX.workspace, grantId, f.task.id, FIX.member, value, LAUNCH_NOW);
  }
  if (permission) await grant(permission);
  async function revoke(readOnly = false) {
    await f.db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(LAUNCH_NOW, FIX.workspace, grantId);
    if (readOnly) await grant("read");
  }
  const request: AgentArtifactRequest = {
    ...f.bound(randomUlid()),
    format: "markdown",
    role: "review",
    declared_size: 26,
    expected_digest: artifactHash("synthetic private agent artifact"),
  };
  function prepare(input = request, target = f.hub) {
    const minted = mintUploadGrantSecret();
    return {
      secret: minted.secret,
      outcome: target.execute(agentArtifactPrepareCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: f.principal.authorizationEpoch,
        idempotencyKey: randomUlid(),
        input: { principal: f.principal, request: input, grantSecretHash: minted.secretHash },
      }),
    };
  }
  const finalize = (input = request, target = f.hub) =>
    target.execute(agentArtifactFinalizeCommand, {
      workspaceId: FIX.workspace,
      actorRunnerId: f.runner,
      authorizationEpoch: f.principal.authorizationEpoch,
      idempotencyKey: agentWorkKey("publish_artifact", input.reference),
      input: { principal: f.principal, request: input },
    });
  async function consumed() {
    const issued = prepare(),
      prepared = success(await issued.outcome);
    const claim = await f.db.withTransaction((tx) =>
      redeemUploadGrant(tx, {
        grantId: prepared.upload!.grant_id,
        secret: issued.secret,
        now: LAUNCH_NOW,
      }),
    );
    return { prepared, claim };
  }
  async function verified() {
    const { prepared, claim } = await consumed();
    await f.db.withTransaction((tx) =>
      recordVerifiedUpload(tx, {
        grantId: claim.grantId,
        consumeAttemptId: claim.consumeAttemptId,
        contentHash: request.expected_digest,
        size: request.declared_size,
        now: LAUNCH_NOW,
      }),
    );
    return prepared;
  }
  const rows = () =>
    Promise.all(
      [
        "artifacts",
        "artifact_versions",
        "artifact_agent_operations",
        "artifact_agent_grants",
        "artifact_upload_grants",
        "artifact_upload_consumptions",
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
        "artifact_audit_outbox",
      ].map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    );
  return { ...f, request, prepare, finalize, consumed, verified, revoke, rows };
}

describe("private agent artifacts", () => {
  it.each([undefined, "read"] as const)(
    "denies publication with %s sponsor grant even though runner owner is private creator",
    async (permission) => {
      const f = await fixture(permission),
        before = await f.rows();
      expect(await f.prepare().outcome).toMatchObject({ ok: false, error: { code: "revoked" } });
      expect(await f.rows()).toEqual(before);
    },
  );
  it("allows exact current contribute sponsor authority without assigning the runner as creator", async () => {
    const f = await fixture("contribute"),
      prepared = await f.verified();
    expect(success(await f.finalize())).toMatchObject({
      state: "available",
      version_id: prepared.version_id,
    });
    expect(
      await f.db
        .prepare("SELECT created_by_human_id FROM artifacts WHERE id=?")
        .get(prepared.artifact_id),
    ).toEqual({ created_by_human_id: null });
  });
  it("denies cached availability and changed retries after sponsor task revoke", async () => {
    const f = await fixture("contribute");
    await f.verified();
    success(await f.finalize());
    await f.revoke();
    const before = await f.rows();
    expect(await f.finalize()).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(
      await f.prepare({ ...f.request, expected_digest: "b".repeat(64) }).outcome,
    ).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(await f.rows()).toEqual(before);
  });
  it.each(["before", "commit", "read_only_commit"] as const)(
    "rejects upload when sponsor authority closes at %s",
    async (timing) => {
      const f = await fixture("contribute"),
        issued = f.prepare(),
        prepared = success(await issued.outcome),
        before = await f.rows();
      const db =
        timing === "before"
          ? f.db
          : resultStagedD1(f.db, () => f.revoke(timing === "read_only_commit")).db;
      if (timing === "before") await f.revoke();
      await expect(
        db.withTransaction((tx) =>
          redeemUploadGrant(tx, {
            grantId: prepared.upload!.grant_id,
            secret: issued.secret,
            now: LAUNCH_NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    },
  );
  it.each(["prepare", "finalize"] as const)(
    "rolls back %s if the private grant is revoked only at commit",
    async (stage) => {
      const f = await fixture("contribute");
      if (stage === "finalize") await f.verified();
      const before = await f.rows(),
        hub = new WorkspaceHub(resultStagedD1(f.db, () => f.revoke()).db);
      expect(
        stage === "prepare"
          ? await f.prepare(f.request, hub).outcome
          : await f.finalize(f.request, hub),
      ).toMatchObject({ ok: false });
      expect(await f.rows()).toEqual(before);
    },
  );
  it.each(["before", "commit", "read_only_commit", "session_commit"] as const)(
    "rejects new receipt effects when authenticated sponsor/session authority closes at %s",
    async (timing) => {
      const f = await fixture("contribute"),
        { claim } = await f.consumed(),
        before = await f.rows();
      const close = async () => {
        if (timing === "session_commit")
          await f.db
            .prepare("UPDATE provider_sessions SET state='ended',ended_at=? WHERE id=?")
            .run(LAUNCH_NOW, f.request.binding.provider_session_id);
        else await f.revoke(timing === "read_only_commit");
      };
      const db = timing === "before" ? f.db : resultStagedD1(f.db, close).db;
      if (timing === "before") await close();
      await expect(
        db.withTransaction((tx) =>
          recordVerifiedUpload(tx, {
            grantId: claim.grantId,
            consumeAttemptId: claim.consumeAttemptId,
            contentHash: f.request.expected_digest,
            size: f.request.declared_size,
            now: LAUNCH_NOW,
          }),
        ),
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    },
  );
  it("uses fresh receipt authority time when the lease expires after valid consume", async () => {
    const f = await fixture("contribute"),
      leaseExpiry = new Date(Date.parse(LAUNCH_NOW) + 1_000).toISOString();
    await f.db
      .prepare("UPDATE checkout_leases SET expires_at=? WHERE execution_id=?")
      .run(leaseExpiry, f.request.reference.run_execution_id);
    const { claim } = await f.consumed(),
      before = await f.rows();
    vi.setSystemTime(new Date(Date.parse(leaseExpiry) + 1));
    await expect(
      f.db.withTransaction((tx) =>
        recordVerifiedUpload(tx, {
          grantId: claim.grantId,
          consumeAttemptId: claim.consumeAttemptId,
          contentHash: f.request.expected_digest,
          size: f.request.declared_size,
          // The immutable observation timestamp is not a current authority clock.
          now: LAUNCH_NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });
});
