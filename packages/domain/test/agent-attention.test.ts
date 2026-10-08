// ABOUTME: Verifies online attention authority, fresh current-run reads and original provenance.
// ABOUTME: Exercises actual Hub cache fences, human authorization and atomic private-safe effects.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import type {
  AgentAttentionRequest,
  AgentAttentionReadRequest,
  CheckoutLeaseObservation,
} from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgentAttention } from "../src/agent-attention.js";
import {
  requestAttentionCommand,
  answerAttentionCommand,
  resolveAttentionCommand,
} from "../src/attention.js";
import { agentWorkKey } from "../src/agent-work.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { authorizeLaunchCommand, claimLaunchCommand } from "../src/launches.js";
import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { createRunControlCommand, claimRunControlCommand } from "../src/run-controls.js";
import { bindAgentSessionCommand } from "../src/agent-sessions.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";
import { openMigratedDomainDb } from "./helpers.js";
import { claimAnotherAttentionRun } from "./attention-fixture.js";
import { submitResultCommand } from "../src/results.js";
import { readLaunch, reauthorizeLaunch } from "../src/launch-state.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

type Fixture = Awaited<ReturnType<typeof captureFixture>>;
function request(f: Fixture, id = randomUlid()): AgentAttentionRequest {
  return {
    ...f.bound(id),
    kind: "clarification",
    question: "Synthetic private question <>&",
    blocking: true,
  };
}
function operation(f: Fixture, body: AgentAttentionRequest) {
  return {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: 1,
    idempotencyKey: agentWorkKey("attention-request", body.reference),
    input: { principal: f.principal, request: body },
  };
}
function read(f: Fixture, id: string, binding = true) {
  const body: AgentAttentionReadRequest = {
    reference: f.reference(),
    attention_id: id,
    ...(binding ? { binding: f.binding } : {}),
  };
  return readAgentAttention(f.db, FIX.workspace, { principal: f.principal, request: body });
}
async function human(
  f: Fixture,
  command: HubCommand<any, any>,
  input: unknown,
  key = randomUlid(),
  actor = FIX.owner,
) {
  return f.hub.execute(command, {
    workspaceId: FIX.workspace,
    actorHumanId: actor,
    authorizationEpoch: 1,
    idempotencyKey: key,
    input,
  });
}
async function effects(db: SqlDatabase) {
  return db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM attention_requests) requests,
    (SELECT COUNT(*) FROM attention_observations) observations,
    (SELECT COUNT(*) FROM idempotency_records) outcomes,
    (SELECT COUNT(*) FROM workspace_cursors) cursors`,
    )
    .get();
}

describe("authenticated agent attention", () => {
  it("creates, reads and exactly retries review attention after an explicit result submission", async () => {
    const f = await captureFixture(undefined, false),
      original = request(f),
      originalRecord = success(
        await f.hub.execute(requestAttentionCommand, operation(f, original)),
      );
    const submitted = success(
      await f.human(submitResultCommand, { runId: f.launch.run_id, summary: "Synthetic result" }),
    );
    expect(submitted).toMatchObject({ runResultState: "submitted", taskState: "review" });
    const state = await f.db
      .prepare("SELECT result_state, resource_version FROM runs WHERE id = ?")
      .get(f.launch.run_id);
    const task = await f.db
      .prepare("SELECT state, resource_version FROM tasks WHERE id = ?")
      .get(f.task.id);
    expect(success(await f.hub.execute(requestAttentionCommand, operation(f, original)))).toEqual(
      originalRecord,
    );
    const review = { ...request(f), kind: "review" as const },
      record = success(await f.hub.execute(requestAttentionCommand, operation(f, review))),
      before = await effects(f.db);
    expect(success(await f.hub.execute(requestAttentionCommand, operation(f, review)))).toEqual(
      record,
    );
    expect((await read(f, record.id, false)).attention.state).toBe("open");
    expect(await effects(f.db)).toEqual(before);
    success(
      await human(f, answerAttentionCommand, {
        attentionId: record.id,
        expectedVersion: 1,
        answer: "Synthetic review answer",
      }),
    );
    expect((await read(f, record.id)).attention).toMatchObject({
      state: "answered",
      answer: "Synthetic review answer",
      resource_version: 2,
    });
    expect(
      await f.db
        .prepare("SELECT result_state, resource_version FROM runs WHERE id = ?")
        .get(f.launch.run_id),
    ).toEqual(state);
    expect(
      await f.db.prepare("SELECT state, resource_version FROM tasks WHERE id = ?").get(f.task.id),
    ).toEqual(task);
    // Attention authority must not expand the existing launch/capture eligibility.
    await expect(
      reauthorizeLaunch(
        {
          db: f.db,
          workspaceId: FIX.workspace,
          actorRunnerId: f.runner,
          authorizationEpoch: 1,
          now: LAUNCH_NOW,
          cursorBase: 0,
        },
        await readLaunch(f.db, FIX.workspace, f.launch.launch_id),
      ),
    ).rejects.toMatchObject({ code: "request_rejected" });
    expect(await f.confirm()).toMatchObject({ ok: false, error: { code: "policy_rejected" } });
  });

  it("recovers one canonical request by exact identity, not changed payload or binding", async () => {
    const f = await captureFixture(undefined, false),
      body = request(f);
    const first = success(await f.hub.execute(requestAttentionCommand, operation(f, body)));
    const before = await effects(f.db);
    expect(success(await f.hub.execute(requestAttentionCommand, operation(f, body)))).toEqual(
      first,
    );
    for (const changed of [
      { ...body, question: body.question + " " },
      { ...body, blocking: false },
      { ...body, reference_kind: "artifact", reference_id: "opaque" },
    ])
      expect(await f.hub.execute(requestAttentionCommand, operation(f, changed))).toMatchObject({
        ok: false,
        error: { code: "request_rejected" },
      });
    expect(
      await f.hub.execute(
        requestAttentionCommand,
        operation(f, { ...body, binding: { ...body.binding, provider_session_id: randomUlid() } }),
      ),
    ).toMatchObject({ ok: false, error: { code: "session_conflict" } });
    expect(await effects(f.db)).toEqual(before);
  });

  it("reads answer and resolution freshly with the same request ID without read outcomes", async () => {
    const f = await captureFixture(undefined, false),
      record = success(await f.hub.execute(requestAttentionCommand, operation(f, request(f))));
    const body = { reference: f.reference(), attention_id: record.id },
      input = { principal: f.principal, request: body };
    const before = await effects(f.db);
    expect((await readAgentAttention(f.db, FIX.workspace, input)).attention.state).toBe("open");
    expect(await effects(f.db)).toEqual(before);
    success(
      await human(f, answerAttentionCommand, {
        attentionId: record.id,
        expectedVersion: 1,
        answer: "Synthetic private answer",
      }),
    );
    const answered = await readAgentAttention(f.db, FIX.workspace, input);
    expect(answered.authority_binding).toEqual(f.binding);
    expect(answered.attention).toMatchObject({
      state: "answered",
      answer: "Synthetic private answer",
      resource_version: 2,
    });
    success(
      await human(f, resolveAttentionCommand, { attentionId: record.id, expectedVersion: 2 }),
    );
    expect((await readAgentAttention(f.db, FIX.workspace, input)).attention.state).toBe("resolved");
  });

  it("hides missing and another run's record within the same project uniformly", async () => {
    const f = await captureFixture(undefined, false);
    const other = await claimAnotherAttentionRun(f),
      body = { ...request(f), ...other };
    const foreign = success(await f.hub.execute(requestAttentionCommand, operation(f, body)));
    await expect(read(f, randomUlid())).rejects.toMatchObject({ code: "not_found" });
    await expect(read(f, foreign.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it.each(
    [
      "requester",
      "runner",
      "execution",
      "accepted",
      "failed",
      "cancelled",
      "lease",
      "session",
      "workspace policy",
      "project policy",
      "repository policy",
      "profile",
    ].flatMap((fault) => ["open", "submitted"].map((state) => ({ fault, state }))),
  )(
    "rechecks $fault with a $state result before cached request and optional-binding private read",
    async ({ fault, state }) => {
      const f = await captureFixture(undefined, false),
        body = request(f);
      if (state === "submitted")
        success(
          await f.human(submitResultCommand, {
            runId: f.launch.run_id,
            summary: "Synthetic result before review",
          }),
        );
      const record = success(await f.hub.execute(requestAttentionCommand, operation(f, body))),
        before = await effects(f.db);
      if (fault === "requester")
        await f.db.prepare("DELETE FROM runner_launch_grants WHERE human_id = ?").run(FIX.member);
      if (fault === "runner")
        await f.db
          .prepare("UPDATE runners SET grant_epoch = grant_epoch + 1 WHERE id = ?")
          .run(f.runner);
      if (fault === "execution")
        await f.db
          .prepare(
            "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
          )
          .run(LAUNCH_NOW, f.final.run_execution_id);
      if (["accepted", "failed", "cancelled"].includes(fault))
        await f.db
          .prepare("UPDATE runs SET result_state = ? WHERE id = ?")
          .run(fault, record.run_id);
      if (fault === "lease")
        await f.db
          .prepare("UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?")
          .run(LAUNCH_NOW, f.final.run_execution_id);
      if (fault === "session")
        await f.db
          .prepare("UPDATE provider_sessions SET state = 'ended', ended_at = ? WHERE id = ?")
          .run(LAUNCH_NOW, f.binding.provider_session_id);
      if (fault.endsWith("policy"))
        await f.advancePolicy(fault.split(" ")[0] as "workspace" | "project" | "repository");
      if (fault === "profile")
        await f.db
          .prepare("UPDATE agent_profiles SET resource_version = resource_version + 1 WHERE id = ?")
          .run(f.start.agent_profile_id);
      expect(await f.hub.execute(requestAttentionCommand, operation(f, body))).toMatchObject({
        ok: false,
      });
      await expect(read(f, record.id, false)).rejects.toHaveProperty("code");
      // Policy updates add their own audit outcomes; attention effects stay intact.
      expect(await f.db.prepare("SELECT COUNT(*) n FROM attention_observations").get()).toEqual({
        n: 1,
      });
      if (!fault.endsWith("policy")) expect(await effects(f.db)).toEqual(before);
    },
  );

  it("allows truly unbound provisional reads without creating canonical state", async () => {
    const f = await launchFixture(),
      claimed = await f.claim();
    success(
      await f.native(authorizeLaunchCommand, {
        principal: f.principal,
        authorization: claimed.final,
      }),
    );
    await expect(
      readAgentAttention(f.db, FIX.workspace, {
        principal: f.principal,
        request: {
          reference: {
            schema_version: 1,
            run_execution_id: claimed.final.run_execution_id,
            assignment_generation: 1,
            request_id: randomUlid(),
          },
          attention_id: randomUlid(),
        },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await f.db.prepare("SELECT COUNT(*) n FROM provider_sessions").get()).toEqual({ n: 0 });
    expect(await f.db.prepare("SELECT COUNT(*) n FROM execution_session_bindings").get()).toEqual({
      n: 0,
    });
  });

  it("keeps original provenance through an actual resume and validates the new caller binding", async () => {
    const f = await captureFixture(undefined, false),
      record = success(await f.hub.execute(requestAttentionCommand, operation(f, request(f))));
    const observation: CheckoutLeaseObservation = {
      schema_version: 1,
      run_execution_id: f.final.run_execution_id,
      assignment_generation: 1,
      fencing_generation: f.final.fencing_generation,
      sequence: 2,
      observed_at: LAUNCH_NOW,
      operation: "release",
      supervisor: f.final.supervisor,
      local_lock_id: f.final.local_lock_id,
      owned_group_id: 1235,
      owned_group_start_identity: "123456:2000",
      supervisor_state: "gone",
      group_state: "gone",
      lock_state: "gone",
      descendants_state: "gone",
      recovery_local: false,
    };
    success(await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation }));
    const control = success(
      await f.human(createRunControlCommand, {
        schema_version: 1,
        idempotency_key: randomUlid(),
        runner_id: f.runner,
        run_execution_id: f.final.run_execution_id,
        assignment_generation: 1,
        action: "resume",
      }),
    );
    const controlClaim = success(
      await f.native(claimRunControlCommand, {
        principal: f.principal,
        claim: {
          schema_version: 1,
          idempotency_key: randomUlid(),
          control_id: control.control_id,
          run_execution_id: f.final.run_execution_id,
          assignment_generation: 1,
          action: "resume",
        },
      }),
    );
    const resumed = success(
      await f.native(claimLaunchCommand, {
        principal: f.principal,
        claim: {
          schema_version: 1,
          launch_id: controlClaim.resume_launch_id!,
          runner_id: f.runner,
          idempotency_key: randomUlid(),
          claimed_at: LAUNCH_NOW,
        },
      }),
    );
    if (resumed.state !== "claimed") throw new Error("resume was not claimed");
    const spec = resumed.claim.specification,
      final = {
        ...f.final,
        launch_id: spec.launch_id,
        run_execution_id: spec.run_execution_id,
        assignment_generation: spec.assignment_generation,
        fencing_generation: resumed.claim.fencing_generation,
        config_snapshot_id: spec.config_snapshot_id,
        config_snapshot_hash: spec.config_snapshot_hash,
        repository_config_hash: resumed.claim.snapshot.repository_config_hash,
        physical_worktree_hash: resumed.claim.snapshot.physical_worktree_hash,
        local_lock_id: randomUlid(),
      };
    success(
      await f.native(authorizeLaunchCommand, { principal: f.principal, authorization: final }),
    );
    success(
      await f.native(observeCheckoutLeaseCommand, {
        principal: f.principal,
        observation: {
          ...observation,
          run_execution_id: final.run_execution_id,
          assignment_generation: 2,
          fencing_generation: final.fencing_generation,
          sequence: 1,
          operation: "renew",
          supervisor: final.supervisor,
          local_lock_id: final.local_lock_id,
          supervisor_state: "verified",
          group_state: "live",
          lock_state: "held",
          descendants_state: "contained",
        },
      }),
    );
    const reference = {
      ...f.reference(),
      run_execution_id: final.run_execution_id,
      assignment_generation: 2,
    };
    const provisional = await readAgentAttention(f.db, FIX.workspace, {
      principal: f.principal,
      request: { reference, attention_id: record.id },
    });
    expect(provisional.authority_binding).toBeNull();
    expect(await f.db.prepare("SELECT COUNT(*) n FROM execution_session_bindings").get()).toEqual({
      n: 1,
    });
    const binding = success(
      await f.native(bindAgentSessionCommand, {
        principal: f.principal,
        request: {
          reference,
          observation: {
            provider: "fake",
            observed_session_id: f.binding.observed_session_id,
            observed_at: LAUNCH_NOW,
          },
        },
      }),
    ).binding;
    const result = await readAgentAttention(f.db, FIX.workspace, {
      principal: f.principal,
      request: { reference, attention_id: record.id, binding },
    });
    expect(result.origin).toEqual({
      run_id: record.run_id,
      run_execution_id: record.run_execution_id,
      assignment_generation: 1,
    });
    expect(result.authority_binding).toEqual(binding);
    expect(final.run_execution_id).not.toBe(record.run_execution_id);
  });
});

describe("human attention cached authority and private receipts", () => {
  it.each(["epoch", "membership", "role"])(
    "rechecks human %s before a cached private answer",
    async (fault) => {
      const f = await captureFixture(undefined, false),
        body = { ...request(f), kind: "credential" as const };
      // Keep the original owner while exercising revocation of a second owner.
      await f.db
        .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
        .run(FIX.member);
      const record = success(await f.hub.execute(requestAttentionCommand, operation(f, body)));
      const input = {
          attentionId: record.id,
          expectedVersion: 1,
          answer: "Synthetic owner answer",
        },
        key = randomUlid();
      success(await human(f, answerAttentionCommand, input, key, FIX.member));
      if (fault === "epoch") await bumpMemberEpoch(f.db, FIX.workspace, FIX.member, LAUNCH_NOW);
      if (fault === "membership") {
        await f.db.prepare("DELETE FROM project_access WHERE human_id=?").run(FIX.member);
        await f.db.prepare("DELETE FROM workspace_members WHERE human_id=?").run(FIX.member);
      }
      if (fault === "role")
        await f.db
          .prepare("UPDATE workspace_members SET role='member' WHERE human_id=?")
          .run(FIX.member);
      expect(await human(f, answerAttentionCommand, input, key, FIX.member)).toMatchObject({
        ok: false,
      });
    },
  );
  it.each(["answer", "resolve"] as const)(
    "checks project/role/epoch before cached %s",
    async (action) => {
      const f = await captureFixture(undefined, false),
        record = success(await f.hub.execute(requestAttentionCommand, operation(f, request(f))));
      const answerInput = {
        attentionId: record.id,
        expectedVersion: 1,
        answer: "Synthetic human private answer",
      };
      const key = randomUlid();
      success(
        await human(
          f,
          answerAttentionCommand,
          answerInput,
          action === "answer" ? key : randomUlid(),
          FIX.reviewer,
        ),
      );
      const input =
          action === "answer" ? answerInput : { attentionId: record.id, expectedVersion: 2 },
        command = action === "answer" ? answerAttentionCommand : resolveAttentionCommand;
      if (action === "resolve") success(await human(f, command, input, key, FIX.reviewer));
      expect((await human(f, command, input, key, FIX.reviewer)).ok).toBe(true);
      await f.db.prepare("DELETE FROM project_access WHERE human_id = ?").run(FIX.reviewer);
      expect(await human(f, command, input, key, FIX.reviewer)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    },
  );

  it("binds changed human input and excludes both private bodies from all event receipts", async () => {
    const f = await captureFixture(undefined, false),
      body = { ...request(f), question: "PRIVATE_QUESTION_CANARY" };
    const record = success(await f.hub.execute(requestAttentionCommand, operation(f, body)));
    const input = { attentionId: record.id, expectedVersion: 1, answer: "PRIVATE_ANSWER_CANARY" },
      key = randomUlid();
    success(await human(f, answerAttentionCommand, input, key));
    expect(
      await human(f, answerAttentionCommand, { ...input, answer: "different" }, key),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    success(
      await human(f, resolveAttentionCommand, { attentionId: record.id, expectedVersion: 2 }),
    );
    for (const table of ["audit_events", "semantic_events", "outbox_records"]) {
      const rows = JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all());
      expect(rows).not.toContain("PRIVATE_QUESTION_CANARY");
      expect(rows).not.toContain("PRIVATE_ANSWER_CANARY");
    }
    expect(
      JSON.stringify(
        await f.db
          .prepare(
            "SELECT result_json FROM idempotency_records WHERE command_name = 'attention.answer'",
          )
          .all(),
      ),
    ).toContain("PRIVATE_ANSWER_CANARY");
  });
});

it("rolls back every staged attention row when its final D1 batch fails", async () => {
  const db = await openMigratedDomainDb(),
    f = await captureFixture(db, false),
    entries = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
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
    batch: async (pending) =>
      db.withTransaction(async (tx) => {
        for (const item of pending) {
          const entry = entries.get(item)!;
          await tx.prepare(entry.sql).run(...entry.params);
          if (/INSERT INTO idempotency_records/.test(entry.sql))
            throw new Error("synthetic private batch failure");
        }
        return [];
      }),
  };
  const before = await effects(db);
  expect(
    await new WorkspaceHub(adaptD1(binding)).execute(
      requestAttentionCommand,
      operation(f, request(f)),
    ),
  ).toMatchObject({ ok: false });
  expect(await effects(db)).toEqual(before);
});
