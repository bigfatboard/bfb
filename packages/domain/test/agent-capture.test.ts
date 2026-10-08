// ABOUTME: Proves canonical confirmation and signed replay authorization in the real Hub lane.
// ABOUTME: Covers immutable capture identity, fresh authority, cached effect recovery and atomic denial.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import type { AgentWorkCapture } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import {
  agentCaptureConfirmationKey,
  agentWriteAction,
  type AgentWriteCommandName,
  type AgentWriteRequest,
} from "../src/agent-capture.js";
import {
  agentCaptureConfirmationCommand,
  agentRunCommentCommand,
  agentRunUpdateCommand,
  agentRunProgressCommand,
  agentRunProposalCommand,
} from "../src/agent-sessions.js";
import { agentWorkKey } from "../src/agent-work.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { runnerHash, type RunnerTokenClaims } from "../src/runner-crypto.js";
import { resolveCommand } from "../src/command-catalog.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { openMigratedDomainDb } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());
type Fixture = Awaited<ReturnType<typeof captureFixture>>;
const commands = {
  "agent_run.comment": agentRunCommentCommand,
  "agent_run.update": agentRunUpdateCommand,
  "agent_run.progress": agentRunProgressCommand,
  "agent_run.proposal": agentRunProposalCommand,
};
const commandNames = Object.keys(commands) as AgentWriteCommandName[];
async function requestFor(f: Fixture, command: AgentWriteCommandName): Promise<AgentWriteRequest> {
  const bound = f.bound();
  if (command === "agent_run.comment")
    return { ...bound, body: " Synthetic <>& \u2028 \u2029 \\u2028 comment " };
  if (command === "agent_run.progress")
    return { ...bound, summary: " Synthetic progress ", percent: 12.5, confidence: 0.75 };
  if (command === "agent_run.proposal")
    return { ...bound, title: "Synthetic child proposal", parent_task_id: f.task.id };
  const task = (await f.db
    .prepare("SELECT resource_version FROM tasks WHERE id = ?")
    .get(f.task.id)) as { resource_version: number };
  return { ...bound, title: "Synthetic updated title", expected_version: task.resource_version };
}
function execute(
  f: Fixture,
  command: AgentWriteCommandName,
  request: AgentWriteRequest,
  capture?: AgentWorkCapture,
  hub = f.hub,
) {
  return hub.execute(commands[command] as HubCommand<unknown, unknown>, {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: 1,
    idempotencyKey: agentWorkKey(agentWriteAction(command), request.reference),
    input: { principal: f.principal, request, ...(capture ? { replayCapture: capture } : {}) },
  });
}
async function state(db: SqlDatabase) {
  const tables = [
    "tasks",
    "comments",
    "agent_work_effects",
    "idempotency_records",
    "audit_events",
    "semantic_events",
    "outbox_records",
    "workspace_cursors",
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables)
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}
async function reSign(f: Fixture, capture: AgentWorkCapture, changes: Record<string, unknown>) {
  const { signature: _signature, ...unsigned } = capture;
  return f.signCapture({ ...unsigned, ...changes }) as Promise<AgentWorkCapture>;
}
function stagedD1(db: SqlDatabase) {
  const entries = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
  let failure: RegExp | undefined;
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, params: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...params) {
          entry.params = params;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.params)) ?? null,
        all: async () => ({ results: await db.prepare(sql).all(...entry.params) }),
        run: async () => ({ meta: await db.prepare(sql).run(...entry.params) }),
      };
      entries.set(statement, entry);
      return statement;
    },
    async batch(pending) {
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const statement of pending) {
          const entry = entries.get(statement)!;
          const meta = await tx.prepare(entry.sql).run(...entry.params);
          if (failure?.test(entry.sql)) throw new Error("synthetic-private-capture-batch-failure");
          results.push({ meta });
        }
        return results;
      });
    },
  };
  return {
    db: adaptD1(binding),
    fail(pattern?: RegExp) {
      failure = pattern;
    },
  };
}

describe("capture confirmation", () => {
  it("derives complete canonical scope and keeps the original time across retries", async () => {
    const f = await captureFixture(),
      request = f.confirmationRequest();
    const original = success(await f.confirm(request));
    expect(original).toMatchObject({
      confirmation_id: request.request_id,
      workspace_id: FIX.workspace,
      project_id: FIX.projectA,
      source_task_id: f.task.id,
      run_id: f.launch.run_id,
      runner_id: f.runner,
      checkout_id: f.checkout,
      requesting_human_id: FIX.member,
      runner_owner_human_id: FIX.owner,
      binding: f.binding,
      confirmed_at: LAUNCH_NOW,
      runner_token_epoch: 1,
      workspace_policy_version: 3,
      project_policy_version: 3,
      repository_config_version: 3,
      configured_permission: {
        allowed_tools: [
          "bfb_add_comment",
          "bfb_propose_task",
          "bfb_report_progress",
          "bfb_update_task",
        ],
        max_pending_age_seconds: 300,
      },
    });
    expect(original.snapshot_repository_config_hash).toBe(original.approved_repository_config_hash);
    expect(Buffer.byteLength(JSON.stringify(original))).toBeLessThanOrEqual(4096);
    vi.setSystemTime(Date.parse(LAUNCH_NOW) + 5_000);
    const before = await state(f.db);
    const retry = await f.hub.execute(agentCaptureConfirmationCommand, {
      ...f.envelope(request),
      now: "2025-01-01T00:00:00.000Z",
    });
    expect(retry.ok && retry.replayed).toBe(true);
    expect(success(retry)).toEqual(original);
    expect(await state(f.db)).toEqual(before);
  });
  it("retains explicit deny-by-default policy without inventing offline permission", async () => {
    const f = await captureFixture(undefined, false);
    expect(success(await f.confirm()).configured_permission).toEqual({
      allowed_tools: [],
      max_pending_age_seconds: 0,
    });
    const request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    const before = await state(f.db);
    const forged = await reSign(f, capture, {
      admitted_permission: { allowed_tools: ["bfb_add_comment"], max_pending_age_seconds: 300 },
      intent_expires_at: "2026-09-12T12:05:00.000Z",
    });
    expect(await execute(f, "agent_run.comment", request, forged)).toMatchObject({
      ok: false,
      error: { code: "policy_rejected" },
    });
    expect(await state(f.db)).toEqual(before);
  });
  it("retains both hashes for a real tightened launch but permits only online provenance", async () => {
    const f = await captureFixture(undefined, true, true),
      confirmation = success(await f.confirm());
    expect(confirmation.snapshot_generation).toBe(2);
    expect(confirmation.snapshot_repository_config_hash).not.toBe(
      confirmation.approved_repository_config_hash,
    );
    const request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request, confirmation);
    const before = await state(f.db);
    expect(await execute(f, "agent_run.comment", request, capture)).toMatchObject({
      ok: false,
      error: { code: "policy_rejected" },
    });
    expect(await state(f.db)).toEqual(before);
    success(await execute(f, "agent_run.comment", request));
  });
  it("rolls back confirmation receipts, cursor and idempotency on a late D1 batch failure", async () => {
    const staged = stagedD1(await openMigratedDomainDb()),
      f = await captureFixture(staged.db);
    const before = await state(f.db),
      request = f.confirmationRequest();
    staged.fail(/INSERT INTO idempotency_records/u);
    expect(await f.confirm(request)).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(await state(f.db)).toEqual(before);
    staged.fail();
    success(await f.confirm(request));
  });
  it("reauthorizes requester and authenticated actor before a cached confirmation", async () => {
    const f = await captureFixture(),
      request = f.confirmationRequest();
    success(await f.confirm(request));
    const before = await state(f.db);
    expect(
      await f.hub.execute(agentCaptureConfirmationCommand, {
        ...f.envelope(request),
        actorRunnerId: randomUlid(),
      }),
    ).toMatchObject({ ok: false });
    expect(
      await f.hub.execute(agentCaptureConfirmationCommand, {
        ...f.envelope(request),
        input: { ...f.envelope(request).input, arbitrary: true },
      }),
    ).toMatchObject({ ok: false });
    await f.db
      .prepare("DELETE FROM runner_launch_grants WHERE human_id = ? AND runner_id = ?")
      .run(FIX.member, f.runner);
    expect(await f.confirm(request)).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(await state(f.db)).toEqual(before);
  });
});

describe("original-command replay", () => {
  it.each(commandNames)(
    "atomically rolls back %s and provenance on a late D1 batch failure",
    async (command) => {
      const staged = stagedD1(await openMigratedDomainDb()),
        f = await captureFixture(staged.db);
      const request = await requestFor(f, command),
        capture = await f.capture(command, request),
        before = await state(f.db);
      staged.fail(/INSERT INTO agent_work_effects/u);
      const rejected = await execute(f, command, request, capture);
      expect(rejected).toMatchObject({ ok: false, error: { code: "command_failed" } });
      expect(JSON.stringify(rejected)).not.toContain("synthetic-private");
      expect(await state(f.db)).toEqual(before);
      staged.fail();
      success(await execute(f, command, request, capture));
    },
  );
  it.each(commandNames)(
    "applies and deduplicates %s without changing its key or business fingerprint",
    async (command) => {
      const f = await captureFixture(),
        request = await requestFor(f, command),
        capture = await f.capture(command, request);
      expect(resolveCommand(command)).toBe(commands[command]);
      const result = success(await execute(f, command, request, capture));
      const before = await state(f.db);
      const replay = await execute(f, command, request, capture, new WorkspaceHub(f.db));
      expect(replay.ok && replay.replayed).toBe(true);
      expect(success(replay)).toEqual(result);
      expect(success(await execute(f, command, request))).toEqual(result);
      expect(await state(f.db)).toEqual(before);
      const stored = (await f.db
        .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
        .get(capture.operation.operation_key)) as { result_json: string };
      expect(JSON.parse(stored.result_json).inputFingerprint).toBe(
        capture.operation.payload_hash.slice(7),
      );
    },
  );
  it("does not rerun stale version preconditions before its own cached success", async () => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.update"),
      capture = await f.capture("agent_run.update", request);
    const result = success(await execute(f, "agent_run.update", request, capture));
    await f.db
      .prepare("UPDATE tasks SET resource_version = resource_version + 1 WHERE id = ?")
      .run(f.task.id);
    expect(success(await execute(f, "agent_run.update", request, capture))).toEqual(result);
    const newRequest = { ...request, reference: f.reference() };
    expect(
      await execute(
        f,
        "agent_run.update",
        newRequest,
        await f.capture("agent_run.update", newRequest),
      ),
    ).toMatchObject({ ok: false, error: { code: "stale_version" } });
  });
  it("does not rerun child capacity before the twentieth child's cached success", async () => {
    const f = await captureFixture();
    for (let index = 0; index < 19; index++)
      await f.db
        .prepare(
          "INSERT INTO tasks (workspace_id,id,project_id,parent_task_id,state,priority,title,punchline,next_owner_type,resource_version,created_at) VALUES (?, ?, ?, ?, 'ready', 'P2', 'Synthetic child', 'Synthetic child', 'unassigned', 1, ?)",
        )
        .run(FIX.workspace, randomUlid(), FIX.projectA, f.task.id, LAUNCH_NOW);
    const request = await requestFor(f, "agent_run.proposal"),
      capture = await f.capture("agent_run.proposal", request);
    const result = success(await execute(f, "agent_run.proposal", request, capture));
    expect(success(await execute(f, "agent_run.proposal", request, capture))).toEqual(result);
    const overflow = { ...request, reference: f.reference() };
    expect(
      await execute(
        f,
        "agent_run.proposal",
        overflow,
        await f.capture("agent_run.proposal", overflow),
      ),
    ).toMatchObject({ ok: false, error: { code: "child_limit" } });
  });
  it("preserves whitespace, optional absence and literal Unicode separators in the digest", async () => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    const { canonicalLaunchJson } = await import("../src/launch-state.js");
    expect(capture.operation.payload_hash).toBe(
      `sha256:${runnerHash(canonicalLaunchJson(request))}`,
    );
    success(await execute(f, "agent_run.comment", request, capture));
    for (const body of [
      "Synthetic changed",
      (request as { body: string }).body.trim(),
      (request as { body: string }).body.replace("\u2028", "\\u2028"),
    ])
      expect(await execute(f, "agent_run.comment", { ...request, body }, capture)).toMatchObject({
        ok: false,
        error: { code: "capture_invalid" },
      });
    const progress = { ...f.bound(), summary: "Synthetic absent fields" };
    const proof = await f.capture("agent_run.progress", progress);
    expect(
      await execute(f, "agent_run.progress", { ...progress, percent: 0 }, proof),
    ).toMatchObject({ ok: false, error: { code: "capture_invalid" } });
  });
  it.each(["command", "actor", "epoch", "fingerprint", "result", "missing"])(
    "requires original confirmation %s evidence before a cached business reply",
    async (field) => {
      const f = await captureFixture(),
        request = await requestFor(f, "agent_run.comment"),
        capture = await f.capture("agent_run.comment", request);
      success(await execute(f, "agent_run.comment", request, capture));
      const key = agentCaptureConfirmationKey(
        f.confirmationRequest(capture.confirmation.confirmation_id),
      );
      const stored = (await f.db
        .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key = ?")
        .get(key)) as { result_json: string };
      const parsed = JSON.parse(stored.result_json);
      if (field === "missing")
        await f.db.prepare("DELETE FROM idempotency_records WHERE idempotency_key = ?").run(key);
      else if (field === "command")
        await f.db
          .prepare(
            "UPDATE idempotency_records SET command_name = 'agent_run.bound_authority' WHERE idempotency_key = ?",
          )
          .run(key);
      else {
        if (field === "actor") parsed.actorRunnerId = randomUlid();
        if (field === "epoch") parsed.authorizationEpoch++;
        if (field === "fingerprint") parsed.inputFingerprint = "0".repeat(64);
        if (field === "result") parsed.result.confirmed_at = "2026-09-12T12:00:01.000Z";
        await f.db
          .prepare("UPDATE idempotency_records SET result_json = ? WHERE idempotency_key = ?")
          .run(JSON.stringify(parsed), key);
      }
      const before = await state(f.db);
      expect(await execute(f, "agent_run.comment", request, capture)).toMatchObject({
        ok: false,
        error: { code: "capture_invalid" },
      });
      expect(await state(f.db)).toEqual(before);
    },
  );
  it.each(["requester", "runner-grant", "session", "execution", "lease"])(
    "rechecks current %s authority before cached outcomes",
    async (change) => {
      const f = await captureFixture(),
        request = await requestFor(f, "agent_run.comment"),
        capture = await f.capture("agent_run.comment", request);
      success(await execute(f, "agent_run.comment", request, capture));
      if (change === "requester")
        await f.db
          .prepare("DELETE FROM runner_launch_grants WHERE human_id = ? AND runner_id = ?")
          .run(FIX.member, f.runner);
      if (change === "runner-grant")
        await f.db
          .prepare("UPDATE runners SET grant_epoch = grant_epoch + 1 WHERE id = ?")
          .run(f.runner);
      if (change === "session")
        await f.db
          .prepare("UPDATE provider_sessions SET state = 'ended', ended_at = ? WHERE id = ?")
          .run(LAUNCH_NOW, f.binding.provider_session_id);
      if (change === "execution")
        await f.db
          .prepare(
            "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
          )
          .run(LAUNCH_NOW, f.final.run_execution_id);
      if (change === "lease")
        await f.db
          .prepare("UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?")
          .run(LAUNCH_NOW, f.final.run_execution_id);
      const before = await state(f.db);
      expect(await execute(f, "agent_run.comment", request, capture)).toMatchObject({ ok: false });
      expect(await state(f.db)).toEqual(before);
    },
  );
  it("allows ordinary token renewal without replacing historical capture epoch or expiry", async () => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    const oldEpoch = capture.confirmation.runner_token_epoch;
    f.principal.tokenEpoch = 2;
    f.principal.authExpiresAt = "2026-09-12T12:06:00.000Z";
    const claims: RunnerTokenClaims = {
      ...f.claims,
      token_epoch: 2,
      exp: Date.parse(f.principal.authExpiresAt) / 1000,
    };
    await f.db.prepare("UPDATE runners SET token_epoch = 2 WHERE id = ?").run(f.runner);
    await f.db
      .prepare("UPDATE runner_tokens SET claims_json = ?, expires_at = ? WHERE id = ?")
      .run(JSON.stringify(claims), f.principal.authExpiresAt, f.principal.tokenId);
    success(await execute(f, "agent_run.comment", request, capture));
    expect(capture.confirmation.runner_token_epoch).toBe(oldEpoch);
  });
  it.each(["workspace", "project", "repository"] as const)(
    "requires exact current %s policy generation before confirmation or cached business outcomes",
    async (tier) => {
      const f = await captureFixture(),
        request = await requestFor(f, "agent_run.comment"),
        confirmationRequest = f.confirmationRequest();
      const confirmation = success(await f.confirm(confirmationRequest)),
        capture = await f.capture("agent_run.comment", request, confirmation);
      success(await execute(f, "agent_run.comment", request, capture));
      await f.advancePolicy(tier);
      const before = await state(f.db);
      expect(await f.confirm(confirmationRequest)).toMatchObject({
        ok: false,
        error: { code: "policy_rejected" },
      });
      expect(await execute(f, "agent_run.comment", request, capture)).toMatchObject({
        ok: false,
        error: { code: "policy_rejected" },
      });
      expect(await state(f.db)).toEqual(before);
    },
  );
  it("rejects a replacement enrollment key rather than accepting row-supplied capture authority", async () => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    const replacement = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const key = await crypto.subtle.exportKey("jwk", replacement.publicKey);
    await f.db
      .prepare("UPDATE runners SET public_key_json = ? WHERE id = ?")
      .run(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }), f.runner);
    const before = await state(f.db);
    expect(await execute(f, "agent_run.comment", request, capture)).toMatchObject({
      ok: false,
      error: { code: "capture_invalid" },
    });
    expect(await state(f.db)).toEqual(before);
  });
  it.each([
    "workspace_id",
    "project_id",
    "source_task_id",
    "run_id",
    "run_execution_id",
    "runner_id",
    "checkout_id",
    "requesting_human_id",
    "runner_owner_human_id",
    "assignment_generation",
    "fencing_generation",
    "requesting_human_authorization_epoch",
    "runner_owner_authorization_epoch",
    "runner_authorization_epoch",
    "runner_grant_epoch",
    "snapshot_generation",
    "workspace_policy_version",
    "project_policy_version",
    "repository_config_version",
  ] as const)("checks independently signed confirmation scope %s", async (field) => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    const previous = capture.confirmation[field];
    const confirmation = {
      ...capture.confirmation,
      [field]: typeof previous === "number" ? previous + 1 : randomUlid(),
    };
    expect(
      await execute(f, "agent_run.comment", request, await reSign(f, capture, { confirmation })),
    ).toMatchObject({ ok: false, error: { code: "capture_invalid" } });
  });
  it("rejects bad signatures, unknown capture/input fields and online-only mode", async () => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    const before = await state(f.db);
    for (const bad of [
      {
        ...capture,
        signature: `${capture.signature[0] === "A" ? "B" : "A"}${capture.signature.slice(1)}`,
      },
      { ...capture, public_key_json: {} },
      await reSign(f, capture, {
        admission_mode: "online_only",
        admitted_permission: { allowed_tools: [], max_pending_age_seconds: 0 },
        intent_expires_at: null,
      }),
    ])
      expect(await execute(f, "agent_run.comment", request, bad as AgentWorkCapture)).toMatchObject(
        { ok: false, error: { code: "capture_invalid" } },
      );
    expect(
      await f.hub.execute(agentRunCommentCommand as HubCommand<unknown, unknown>, {
        workspaceId: FIX.workspace,
        actorRunnerId: f.runner,
        authorizationEpoch: 1,
        idempotencyKey: capture.operation.operation_key,
        input: { principal: f.principal, request, replayCapture: capture, arbitrary: true },
      }),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(await state(f.db)).toEqual(before);
  });
  it.each([
    { captured_at: "2026-09-12T11:59:59.999Z" },
    { captured_at: "2026-09-12T12:00:45.000Z", intent_expires_at: "2026-09-12T12:05:45.000Z" },
    { captured_at: "2026-09-12T12:00:00.001Z", intent_expires_at: "2026-09-12T12:05:00.001Z" },
    { intent_expires_at: "2026-09-12T12:05:00.001Z" },
  ])(
    "rejects independently signed invalid capture time $captured_at/$intent_expires_at",
    async (changes) => {
      const f = await captureFixture(),
        request = await requestFor(f, "agent_run.comment"),
        capture = await f.capture("agent_run.comment", request);
      expect(
        await execute(f, "agent_run.comment", request, await reSign(f, capture, changes)),
      ).toMatchObject({ ok: false, error: { code: "capture_invalid" } });
    },
  );
  it("stops at intent expiry even with freshly renewed current authority and a cached effect", async () => {
    const f = await captureFixture(),
      request = await requestFor(f, "agent_run.comment"),
      capture = await f.capture("agent_run.comment", request);
    success(await execute(f, "agent_run.comment", request, capture));
    vi.setSystemTime(new Date(capture.intent_expires_at!));
    // Current credentials remain valid beyond capture expiry; neither renewal resets admission.
    f.principal.authExpiresAt = "2026-09-12T12:06:00.000Z";
    await f.db
      .prepare("UPDATE runner_tokens SET expires_at = ?, claims_json = ? WHERE id = ?")
      .run(
        f.principal.authExpiresAt,
        JSON.stringify({ ...f.claims, exp: Date.parse(f.principal.authExpiresAt) / 1000 }),
        f.principal.tokenId,
      );
    await f.refresh(new Date().toISOString());
    await f.renew(new Date().toISOString());
    const before = await state(f.db);
    expect(await execute(f, "agent_run.comment", request, capture)).toMatchObject({
      ok: false,
      error: { code: "intent_expired" },
    });
    expect(await state(f.db)).toEqual(before);
  });
  it("projects only bounded safe receipts, not private business payload or capture signature", async () => {
    const f = await captureFixture(),
      request = { ...f.bound(), body: "private-capture-canary" },
      capture = await f.capture("agent_run.comment", request);
    success(await execute(f, "agent_run.comment", request, capture));
    for (const table of ["semantic_events", "audit_events", "outbox_records"]) {
      const rows = JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all());
      expect(rows).not.toContain(request.body);
      expect(rows).not.toContain(capture.signature);
      expect(rows).not.toContain(f.binding.observed_session_id);
    }
  });
});
