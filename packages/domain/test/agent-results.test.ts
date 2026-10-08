// ABOUTME: Proves canonical result authority, protected replay and current authorization before outcomes.
// ABOUTME: Exercises real launch/session commands, immutable submissions and staged D1 rollback.

import type { SqlDatabase } from "@bfb/db";
import type { AgentResultRequest, AgentResultCapture } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentResultProjection, resultConfirmationKey } from "../src/agent-results.js";
import { agentWorkKey } from "../src/agent-work.js";
import { FIX } from "../src/fixtures.js";
import { resolveCommand } from "../src/command-catalog.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import {
  acceptResultCommand,
  requestChangesCommand,
  submitResultCommand,
  type SubmitResultResult,
} from "../src/results.js";
import { randomUlid } from "../src/ids.js";
import { selectNotificationEvent } from "../src/notifications.js";
import type { RunnerTokenClaims } from "../src/runner-crypto.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";
import { resultFixture, resultStagedD1 } from "./result-fixture.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());
type Fixture = Awaited<ReturnType<typeof resultFixture>>;
function execute(
  f: Fixture,
  request: AgentResultRequest,
  capture?: AgentResultCapture,
  hub = f.hub,
) {
  return hub.execute(resolveCommand("result.submit") as HubCommand<unknown, SubmitResultResult>, {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: f.principal.authorizationEpoch,
    idempotencyKey: agentWorkKey("submit_result", request.reference),
    input: { principal: f.principal, request, ...(capture ? { replayCapture: capture } : {}) },
  });
}
async function state(db: SqlDatabase) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "result_submissions",
    "result_reviews",
    "runs",
    "tasks",
    "checkout_leases",
    "idempotency_records",
    "audit_events",
    "semantic_events",
    "outbox_records",
    "workspace_cursors",
  ])
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}
const human = (input: unknown) => ({
  workspaceId: FIX.workspace,
  actorHumanId: FIX.owner,
  authorizationEpoch: 1,
  idempotencyKey: randomUlid(),
  input,
});

describe("canonical result confirmation", () => {
  it("defaults result capture to deny independently of four-tool capture", async () => {
    const f = await resultFixture(undefined, false);
    expect(success(await f.confirmResult())).toMatchObject({
      can_submit: true,
      configured_permission: { allow_submit_result: false, max_pending_age_seconds: 0 },
    });
    expect(success(await f.confirm())).toMatchObject({
      configured_permission: { allowed_tools: [], max_pending_age_seconds: 0 },
    });
  });
  it("retains original confirmation time and derives false eligibility in submitted", async () => {
    const f = await resultFixture(),
      reference = f.confirmationRequest();
    const original = success(await f.confirmResult(reference));
    vi.setSystemTime(new Date(Date.now() + 1_000));
    expect(success(await f.confirmResult(reference))).toEqual(original);
    success(await execute(f, f.request()));
    expect(success(await f.confirmResult())).toMatchObject({ can_submit: false });
    expect(success(await f.confirmResult(reference))).toEqual(original);
    expect(await f.confirm()).toMatchObject({ ok: false, error: { code: "policy_rejected" } });
  });
  it("retains mismatched approved and tightened snapshot hashes without admitting replay", async () => {
    const f = await resultFixture(undefined, true, true),
      request = f.request();
    const confirmation = success(await f.confirmResult());
    expect(confirmation.snapshot_repository_config_hash).not.toBe(
      confirmation.approved_repository_config_hash,
    );
    const capture = await f.resultCapture(request, confirmation);
    expect(await execute(f, request, capture)).toMatchObject({
      ok: false,
      error: { code: "policy_rejected" },
    });
    expect(await execute(f, request)).toMatchObject({ ok: true });
  });
});

describe("agent result effects and replay", () => {
  it("binds explicit empty evidence, omission, evidence order and separator spelling before trimming", async () => {
    const f = await resultFixture();
    const request = f.request();
    delete request.evidence_refs;
    const capture = await f.resultCapture(request);
    success(await execute(f, request, capture));
    expect(await execute(f, { ...request, evidence_refs: [] }, capture)).toMatchObject({
      ok: false,
      error: { code: "capture_invalid" },
    });
    expect(
      await execute(
        f,
        { ...request, summary: request.summary.replace("\u2028", "\\u2028") },
        capture,
      ),
    ).toMatchObject({ ok: false, error: { code: "capture_invalid" } });
    const changed = { ...request, summary: request.summary.trim() };
    expect(await execute(f, changed)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    const second = await resultFixture(),
      ordered = second.request();
    ordered.evidence_refs = [
      { kind: "comment", ref: "A" },
      { kind: "comment", ref: "B" },
    ];
    const original = await second.resultCapture(ordered);
    success(await execute(second, ordered, original));
    expect(
      await execute(
        second,
        { ...ordered, evidence_refs: [...ordered.evidence_refs].reverse() },
        original,
      ),
    ).toMatchObject({ ok: false, error: { code: "capture_invalid" } });
  });
  it.each([-1, 1, 45_000])(
    "rejects capture outside original send horizon at %i milliseconds",
    async (offset) => {
      const f = await resultFixture(),
        request = f.request(),
        capture = await f.resultCapture(request);
      if (offset === 45_000) {
        vi.setSystemTime(new Date(Date.now() + offset));
        await f.refresh(new Date().toISOString());
        await f.renew(new Date().toISOString());
      }
      const { signature: _signature, ...unsigned } = capture;
      const captured = Date.parse(capture.confirmation.confirmed_at) + offset;
      const invalid = (await f.signResult({
        ...unsigned,
        captured_at: new Date(captured).toISOString(),
        intent_expires_at: new Date(captured + 300_000).toISOString(),
      })) as AgentResultCapture;
      expect(await execute(f, request, invalid)).toMatchObject({
        ok: false,
        error: { code: "capture_invalid" },
      });
      expect(await f.db.prepare("SELECT COUNT(*) AS count FROM result_submissions").get()).toEqual({
        count: 0,
      });
    },
  );
  it("allows current token renewal while retaining historical capture metadata", async () => {
    const f = await resultFixture(),
      request = f.request(),
      capture = await f.resultCapture(request);
    success(await execute(f, request));
    const stored = (await f.db
      .prepare("SELECT claims_json FROM runner_tokens WHERE id=?")
      .get(f.principal.tokenId)) as { claims_json: string };
    const claims: RunnerTokenClaims = { ...JSON.parse(stored.claims_json), token_epoch: 2 };
    await f.db.prepare("UPDATE runners SET token_epoch=2 WHERE id=?").run(f.runner);
    await f.db
      .prepare("UPDATE runner_tokens SET claims_json=? WHERE id=?")
      .run(JSON.stringify(claims), f.principal.tokenId);
    f.principal.tokenEpoch = 2;
    expect(await execute(f, request, capture)).toMatchObject({ ok: true, replayed: true });
    expect(capture.confirmation.runner_token_epoch).toBe(1);
    await f.db.prepare("UPDATE runners SET grant_epoch=2 WHERE id=?").run(f.runner);
    expect(await execute(f, request, capture)).toMatchObject({
      ok: false,
      error: { code: "revoked" },
    });
  });
  it("rejects an older active assignment even when a newer recorded generation is ended", async () => {
    const f = await resultFixture(),
      request = f.request(),
      first = success(await execute(f, request)),
      execution = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO run_executions (workspace_id,id,run_id,state,end_reason,resource_version,created_at,ended_at) VALUES (?, ?, ?, 'ended','process_exit',1,?,?)",
      )
      .run(FIX.workspace, execution, f.launch.run_id, LAUNCH_NOW, LAUNCH_NOW);
    await f.db
      .prepare(
        `INSERT INTO execution_assignments (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at)
      SELECT workspace_id,?,assignment_generation+1,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at FROM execution_assignments WHERE execution_id=?`,
      )
      .run(execution, f.final.run_execution_id);
    expect(await execute(f, request)).toMatchObject({
      ok: false,
      error: { code: "assignment_ended" },
    });
    expect(first.submission.version).toBe(1);
  });
  it("returns bounded truthful origin and one immutable effect for online/replay retries", async () => {
    const f = await resultFixture(),
      request = f.request(),
      capture = await f.resultCapture(request);
    const beforeLease = await f.db.prepare("SELECT * FROM checkout_leases").all();
    const original = success(await execute(f, request));
    expect(original.submission).toMatchObject({
      version: 1,
      submitted_by_kind: "agent_run",
      submitted_by_id: f.launch.run_id,
      config_snapshot_id: f.final.config_snapshot_id,
      config_hash: f.final.config_snapshot_hash,
    });
    expect(agentResultProjection(original)).toEqual({
      submission_id: original.submission.id,
      version: 1,
      result_state: "submitted",
      task_state: "review",
      run_version: original.runVersion,
      task_version: original.taskVersion,
      origin: {
        run_id: f.launch.run_id,
        run_execution_id: f.final.run_execution_id,
        assignment_generation: f.final.assignment_generation,
        provider_session_id: f.binding.provider_session_id,
      },
    });
    expect(await execute(f, request, capture)).toMatchObject({
      ok: true,
      replayed: true,
      result: original,
    });
    expect(await execute(f, request)).toMatchObject({ ok: true, replayed: true, result: original });
    expect(await execute(f, { ...request, summary: request.summary.trim() })).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    expect(await execute(f, f.request())).toMatchObject({
      ok: false,
      error: { code: "invalid_transition" },
    });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM result_submissions").get()).toEqual({
      count: 1,
    });
    expect(await f.db.prepare("SELECT * FROM checkout_leases").all()).toEqual(beforeLease);
    const event = (await f.db
      .prepare("SELECT payload_json FROM semantic_events WHERE kind='result.submit'")
      .get()) as { payload_json: string };
    expect(selectNotificationEvent("result.submit", JSON.parse(event.payload_json))).toEqual({
      category: "result_submitted",
      runId: f.launch.run_id,
      submissionVersion: 1,
    });
    for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
      const receipts = JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all());
      for (const canary of [
        "PRIVATE_RESULT_SUMMARY",
        "PRIVATE_RESULT_LIMITATION",
        "PRIVATE_RESULT_EVIDENCE",
      ])
        expect(receipts).not.toContain(canary);
    }
    expect(
      JSON.stringify(
        await f.db
          .prepare("SELECT result_json FROM idempotency_records WHERE command_name='result.submit'")
          .all(),
      ),
    ).toContain("PRIVATE_RESULT_SUMMARY");
  });
  it("preserves the original cached effect after human changes requested and a newer submission", async () => {
    const f = await resultFixture(),
      request = f.request(),
      capture = await f.resultCapture(request);
    const first = success(await execute(f, request, capture));
    success(
      await f.hub.execute(
        requestChangesCommand,
        human({
          runId: f.launch.run_id,
          submissionId: first.submission.id,
          expectedRunVersion: first.runVersion,
          expectedTaskVersion: first.taskVersion,
          comment: "PRIVATE_REVIEW_COMMENT",
        }),
      ),
    );
    const second = success(await execute(f, f.request()));
    expect(second.submission.version).toBe(2);
    expect(await execute(f, request, capture)).toMatchObject({
      ok: true,
      replayed: true,
      result: first,
    });
    expect(JSON.stringify(await f.db.prepare("SELECT * FROM audit_events").all())).not.toContain(
      "PRIVATE_REVIEW_COMMENT",
    );
  });
  it.each([
    "requester",
    "runner",
    "session",
    "execution",
    "lease",
    "result",
    "policy",
    "workspace-policy",
    "repository-policy",
  ])("checks current %s authority before cached online/replay outcomes", async (kind) => {
    const f = await resultFixture(),
      request = f.request(),
      capture = await f.resultCapture(request),
      first = success(await execute(f, request));
    if (kind === "requester")
      await f.db.prepare("DELETE FROM runner_launch_grants WHERE human_id=?").run(FIX.member);
    if (kind === "runner")
      await f.db.prepare("DELETE FROM runner_project_grants WHERE runner_id=?").run(f.runner);
    if (kind === "session")
      await f.db
        .prepare("UPDATE provider_sessions SET state='ended',ended_at=? WHERE id=?")
        .run(LAUNCH_NOW, f.binding.provider_session_id);
    if (kind === "execution")
      await f.db
        .prepare(
          "UPDATE run_executions SET state='ended',end_reason='process_exit',ended_at=? WHERE id=?",
        )
        .run(LAUNCH_NOW, f.final.run_execution_id);
    if (kind === "lease")
      await f.db.prepare("UPDATE checkout_leases SET expires_at=?").run(LAUNCH_NOW);
    if (kind === "result")
      success(
        await f.hub.execute(
          acceptResultCommand,
          human({
            runId: f.launch.run_id,
            submissionId: first.submission.id,
            expectedRunVersion: first.runVersion,
            expectedTaskVersion: first.taskVersion,
          }),
        ),
      );
    if (kind === "policy") await f.advancePolicy("project");
    if (kind === "workspace-policy") await f.advancePolicy("workspace");
    if (kind === "repository-policy") await f.advancePolicy("repository");
    expect(await execute(f, request)).toMatchObject({ ok: false });
    expect(await execute(f, request, capture)).toMatchObject({ ok: false });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM result_submissions").get()).toEqual({
      count: 1,
    });
  });
  it.each([
    "signature",
    "binding",
    "operation",
    "domain",
    "missing-confirmation",
    "stored-result",
    "stored-actor",
    "stored-fingerprint",
    "stored-command",
  ])("rejects tampered %s evidence before any effect", async (kind) => {
    const f = await resultFixture(),
      request = f.request();
    let capture = await f.resultCapture(request);
    if (kind === "signature") capture = { ...capture, signature: "A".repeat(86) };
    if (kind === "binding")
      request.binding = { ...request.binding, observed_session_id: "foreign-session" };
    if (kind === "operation")
      capture = { ...capture, operation: { ...capture.operation, request_id: randomUlid() } };
    if (kind === "domain") {
      const { signature: _sig, ...unsigned } = capture;
      capture = (await f.signCapture(unsigned)) as AgentResultCapture;
    }
    const key = resultConfirmationKey({
      schema_version: 1,
      request_id: capture.confirmation.confirmation_id,
      run_execution_id: capture.confirmation.run_execution_id,
      assignment_generation: capture.confirmation.assignment_generation,
      binding: capture.confirmation.binding,
    });
    if (kind === "missing-confirmation")
      await f.db.prepare("DELETE FROM idempotency_records WHERE idempotency_key=?").run(key);
    if (kind.startsWith("stored-")) {
      const stored = (await f.db
        .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key=?")
        .get(key)) as { result_json: string };
      const record = JSON.parse(stored.result_json);
      if (kind === "stored-result") record.result.can_submit = false;
      if (kind === "stored-actor") record.actorRunnerId = randomUlid();
      if (kind === "stored-fingerprint") record.inputFingerprint = "a".repeat(64);
      if (kind === "stored-command")
        await f.db
          .prepare(
            "UPDATE idempotency_records SET command_name='agent_run.capture_confirmation' WHERE idempotency_key=?",
          )
          .run(key);
      else
        await f.db
          .prepare("UPDATE idempotency_records SET result_json=? WHERE idempotency_key=?")
          .run(JSON.stringify(record), key);
    }
    const before = await state(f.db);
    expect(await execute(f, request, capture)).toMatchObject({ ok: false });
    expect(await state(f.db)).toEqual(before);
  });
  it("requires original true eligibility and exact signed expiry", async () => {
    const f = await resultFixture(),
      request = f.request();
    let capture = await f.resultCapture(request);
    const { signature: _sig, ...unsigned } = capture;
    capture = (await f.signResult({
      ...unsigned,
      intent_expires_at: new Date(Date.now() + 301_000).toISOString(),
    })) as AgentResultCapture;
    expect(await execute(f, request, capture)).toMatchObject({
      ok: false,
      error: { code: "capture_invalid" },
    });
    success(await execute(f, request));
    const no = f.request();
    capture = await f.resultCapture(no);
    expect(capture.confirmation.can_submit).toBe(false);
    expect(await execute(f, no, capture)).toMatchObject({
      ok: false,
      error: { code: "capture_invalid" },
    });
  });
  it("expires a cached replay despite current token, inventory and same-fence lease renewal", async () => {
    const f = await resultFixture(),
      request = f.request(),
      capture = await f.resultCapture(request);
    success(await execute(f, request, capture));
    vi.setSystemTime(new Date(capture.intent_expires_at!));
    f.principal.authExpiresAt = "2026-09-12T12:06:00.000Z";
    await f.db
      .prepare("UPDATE runner_tokens SET expires_at=?,claims_json=? WHERE id=?")
      .run(
        f.principal.authExpiresAt,
        JSON.stringify({ ...f.claims, exp: Date.parse(f.principal.authExpiresAt) / 1000 }),
        f.principal.tokenId,
      );
    await f.refresh(new Date().toISOString());
    await f.renew(new Date().toISOString());
    const before = await state(f.db);
    expect(await execute(f, request, capture)).toMatchObject({
      ok: false,
      error: { code: "intent_expired" },
    });
    expect(await state(f.db)).toEqual(before);
  });
  it.each([
    /INSERT INTO result_submissions/,
    /UPDATE tasks SET state = 'review'/,
    /INSERT INTO outbox_records/,
    /INSERT INTO idempotency_records/,
  ])("rolls back a late staged D1 batch failure %s", async (pattern) => {
    const f = await resultFixture(),
      request = f.request(),
      capture = await f.resultCapture(request),
      adapter = resultStagedD1(f.db);
    const before = await state(f.db);
    adapter.fail(pattern);
    expect(await execute(f, request, capture, new WorkspaceHub(adapter.db))).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(await state(f.db)).toEqual(before);
    adapter.fail();
    expect(await execute(f, request, capture, new WorkspaceHub(adapter.db))).toMatchObject({
      ok: true,
    });
  });
  it("rejects arbitrary internal capture fields and human impersonation", async () => {
    const f = await resultFixture(),
      request = f.request();
    expect(
      await f.hub.execute(submitResultCommand, {
        ...human({ principal: f.principal, request }),
        actorRunnerId: f.runner,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await f.hub.execute(submitResultCommand, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { principal: f.principal, request, unexpected: true } as never,
      }),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
  });
});
