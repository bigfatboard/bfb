// ABOUTME: Verifies current assignment authority before new and cached local-agent work outcomes.
// ABOUTME: Exercises actual WorkspaceHub ordering, item delivery receipts, bounded replies and safe audit projections.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import {
  decodeWireDocument,
  type AgentWorkRequest,
  type AgentSessionBindRequest,
  type AgentBoundRequest,
  type AgentCommentRequest,
  type LaunchFinalRequest,
  type CheckoutLeaseObservation,
} from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentRunAuthorityCommand,
  agentRunContextCommand,
  agentRunTaskCommand,
  agentWorkKey,
  type AgentWorkInput,
} from "../src/agent-work.js";
import { FIX } from "../src/fixtures.js";
import {
  agentSessionBindKey,
  bindAgentSessionCommand,
  agentBoundAuthorityCommand,
  agentRunCommentCommand,
} from "../src/agent-sessions.js";
import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { WorkspaceHub, type CommandRequest, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { authorizeLaunchCommand, claimLaunchCommand } from "../src/launches.js";
import { createRunControlCommand, claimRunControlCommand } from "../src/run-controls.js";
import { runnerHash } from "../src/runner-crypto.js";
import { assertCurrentRunnerPrincipal, type RunnerPrincipal } from "../src/runners.js";
import { addContextCommand, type RunContextResult } from "../src/work-commands.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";
import { openMigratedDomainDb } from "./helpers.js";

type Action = "authority" | "context" | "task";
const actions: Action[] = ["authority", "context", "task"];
const commands = {
  authority: agentRunAuthorityCommand,
  context: agentRunContextCommand,
  task: agentRunTaskCommand,
};
function command(action: Action): HubCommand<AgentWorkInput, unknown> {
  return commands[action] as HubCommand<AgentWorkInput, unknown>;
}

async function fixture(database?: SqlDatabase) {
  const f = await launchFixture(database);
  await f.db
    .prepare(
      `INSERT INTO runner_launch_grants
    (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, f.runner, FIX.member, LAUNCH_NOW);
  const claimed = await f.claim(FIX.member);
  expect(
    success(
      await f.native(authorizeLaunchCommand, {
        principal: f.principal,
        authorization: claimed.final,
      }),
    ),
  ).toMatchObject({ decision: "authorized" });
  function envelope(
    action: Action,
    requestId = randomUlid(),
    changes: Partial<AgentWorkRequest> = {},
  ): CommandRequest<AgentWorkInput> {
    const request: AgentWorkRequest = {
      schema_version: 1,
      run_execution_id: claimed.final.run_execution_id,
      assignment_generation: claimed.final.assignment_generation,
      request_id: requestId,
      ...changes,
    };
    return {
      workspaceId: FIX.workspace,
      actorRunnerId: f.runner,
      authorizationEpoch: 1,
      // A caller cannot keep a lease alive with a stale supplied timestamp.
      now: LAUNCH_NOW,
      idempotencyKey: agentWorkKey(action, request),
      input: { principal: f.principal, request },
    };
  }
  const execute = (action: Action, request = envelope(action)) =>
    f.hub.execute(command(action), request);
  return { ...f, ...claimed, envelope, execute };
}

async function effects(db: SqlDatabase) {
  return db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM task_context_deliveries) AS deliveries,
    (SELECT COUNT(*) FROM semantic_events) AS events,
    (SELECT COUNT(*) FROM audit_events) AS audits,
    (SELECT COUNT(*) FROM outbox_records) AS outbox,
    (SELECT COUNT(*) FROM idempotency_records) AS idempotency,
    (SELECT cursor FROM workspace_cursors WHERE workspace_id = ?) AS cursor`,
    )
    .get(FIX.workspace);
}

function failingReads(db: SqlDatabase, pattern: RegExp): SqlDatabase {
  return {
    prepare(sql) {
      if (pattern.test(sql)) throw new Error("synthetic-private-d1-failure");
      return db.prepare(sql);
    },
    withTransaction(fn) {
      return db.withTransaction((tx) => fn(failingReads(tx, pattern)));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

function leaseObservation(final: LaunchFinalRequest, sequence = 1): CheckoutLeaseObservation {
  return {
    schema_version: 1,
    run_execution_id: final.run_execution_id,
    assignment_generation: final.assignment_generation,
    fencing_generation: final.fencing_generation,
    sequence,
    observed_at: LAUNCH_NOW,
    operation: "renew",
    supervisor: final.supervisor,
    local_lock_id: final.local_lock_id,
    owned_group_id: 1235,
    owned_group_start_identity: "123456:2000",
    supervisor_state: "verified",
    group_state: "live",
    lock_state: "held",
    descendants_state: "contained",
    recovery_local: false,
  };
}
type AgentFixture = Awaited<ReturnType<typeof fixture>>;
function operation<T extends { reference: AgentWorkRequest }>(
  f: AgentFixture,
  action: string,
  request: T,
) {
  return {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: 1,
    now: LAUNCH_NOW,
    idempotencyKey:
      action === "session-bind"
        ? agentSessionBindKey(request.reference)
        : agentWorkKey(action, request.reference),
    input: { principal: f.principal, request },
  };
}
async function sessionFixture(database?: SqlDatabase) {
  const f = await fixture(database);
  success(
    await f.native(observeCheckoutLeaseCommand, {
      principal: f.principal,
      observation: leaseObservation(f.final),
    }),
  );
  const request: AgentSessionBindRequest = {
    reference: f.envelope("authority").input.request,
    observation: {
      provider: "fake",
      observed_session_id: "synthetic-agent-conversation",
      observed_at: LAUNCH_NOW,
    },
  };
  const bind = () => f.hub.execute(bindAgentSessionCommand, operation(f, "session-bind", request));
  const result = success(await bind());
  function bound(requestId = randomUlid()): AgentBoundRequest {
    return { reference: f.envelope("authority", requestId).input.request, binding: result.binding };
  }
  function comment(
    requestId = randomUlid(),
    body = "Synthetic private agent comment",
  ): AgentCommentRequest {
    return { ...bound(requestId), body };
  }
  return { ...f, request, result, bind, bound, comment };
}
async function agentEffects(db: SqlDatabase) {
  return {
    ...((await effects(db)) as object),
    ...((await db
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM provider_sessions) AS sessions,
    (SELECT COUNT(*) FROM execution_session_bindings) AS bindings,
    (SELECT COUNT(*) FROM comments) AS comments,
    (SELECT COUNT(*) FROM agent_work_effects) AS effects`,
      )
      .get()) as object),
  };
}

// Executes the real adapter's staged statements as one underlying SQLite transaction.
// Late failure proves command effects roll back, while adaptD1 enforces no read-after-write.
function stagedD1(db: SqlDatabase) {
  const statements = new Map<D1StatementLike, { sql: string; params: unknown[] }>();
  let failure: RegExp | undefined;
  const batches: string[][] = [];
  const binding: D1Like = {
    prepare(sql) {
      const entry = { sql, params: [] as unknown[] };
      const statement: D1StatementLike = {
        bind(...params) {
          entry.params = params;
          return statement;
        },
        first: async () => (await db.prepare(sql).get(...entry.params)) ?? null,
        all: async () => ({ results: (await db.prepare(sql).all(...entry.params)) as unknown[] }),
        run: async () => ({
          meta: (await db.prepare(sql).run(...entry.params)) as { changes: number },
        }),
      };
      statements.set(statement, entry);
      return statement;
    },
    async batch(pending) {
      const entries = pending.map((statement) => statements.get(statement)!);
      batches.push(entries.map((entry) => entry.sql));
      return db.withTransaction(async (tx) => {
        const results = [];
        for (const entry of entries) {
          const result = await tx.prepare(entry.sql).run(...entry.params);
          if (failure?.test(entry.sql)) throw new Error("synthetic-private-batch-failure");
          results.push({ meta: result as { changes: number } });
        }
        return results;
      });
    },
  };
  return {
    db: adaptD1(binding),
    batches,
    fail(pattern?: RegExp) {
      failure = pattern;
    },
  };
}

describe("canonical agent sessions and comments", () => {
  it("binds one assignment identity across request IDs without changing the pinned provider", async () => {
    const f = await sessionFixture(),
      before = await agentEffects(f.db);
    await f.db
      .prepare("UPDATE agent_profiles SET provider = 'codex' WHERE id = ?")
      .run(f.profile.id);
    const repeated = {
      ...f.request,
      reference: { ...f.request.reference, request_id: "other-bind-request" },
    };
    expect(agentSessionBindKey(repeated.reference)).toBe(agentSessionBindKey(f.request.reference));
    expect(agentSessionBindKey({ ...repeated.reference, assignment_generation: 2 })).not.toBe(
      agentSessionBindKey(f.request.reference),
    );
    const outcome = await f.hub.execute(
      bindAgentSessionCommand,
      operation(f, "session-bind", repeated),
    );
    expect(outcome.ok && outcome.replayed).toBe(true);
    expect(success(outcome)).toEqual(f.result);
    expect(await agentEffects(f.db)).toEqual(before);
    expect(f.result.origin).toEqual({
      run_id: f.launch.run_id,
      run_execution_id: f.final.run_execution_id,
      assignment_generation: 1,
      provider_session_id: f.result.binding.provider_session_id,
    });
  });

  it.each(["provider", "identity", "time"] as const)(
    "rejects a changed binding %s under the same assignment",
    async (field) => {
      const f = await sessionFixture(),
        before = await agentEffects(f.db);
      const observation = {
        ...f.request.observation,
        ...(field === "provider"
          ? { provider: "codex" as const }
          : field === "identity"
            ? { observed_session_id: "competing-conversation" }
            : { observed_at: "2026-09-12T12:00:01.000Z" }),
      };
      expect(
        await f.hub.execute(
          bindAgentSessionCommand,
          operation(f, "session-bind", { ...f.request, observation }),
        ),
      ).toMatchObject({ ok: false, error: { code: "session_conflict" } });
      expect(await agentEffects(f.db)).toEqual(before);
    },
  );

  it.each(["requested", "observed", "ambiguous", "ended", "wrong provider"] as const)(
    "handles a pre-existing %s canonical session without a heuristic merge",
    async (state) => {
      const f = await fixture();
      success(
        await f.native(observeCheckoutLeaseCommand, {
          principal: f.principal,
          observation: leaseObservation(f.final),
        }),
      );
      const session = randomUlid(),
        observed = "synthetic-existing-conversation";
      await f.db
        .prepare(
          `INSERT INTO provider_sessions (workspace_id,id,run_id,execution_id,provider,
        requested_session_id,observed_session_id,state,started_at,ended_at) VALUES (?,?,?,?,?,'requested-vendor-id',?,?,?,?)`,
        )
        .run(
          FIX.workspace,
          session,
          f.launch.run_id,
          f.final.run_execution_id,
          state === "wrong provider" ? "codex" : "fake",
          state === "requested" ? null : observed,
          state === "ended" ? "ended" : "active",
          LAUNCH_NOW,
          state === "ended" ? LAUNCH_NOW : null,
        );
      if (state === "ambiguous")
        await f.db
          .prepare(
            `INSERT INTO provider_sessions
        (workspace_id,id,run_id,execution_id,provider,state,started_at) VALUES (?,?,?,?,'fake','active',?)`,
          )
          .run(FIX.workspace, randomUlid(), f.launch.run_id, f.final.run_execution_id, LAUNCH_NOW);
      const before = await agentEffects(f.db);
      const request: AgentSessionBindRequest = {
        reference: f.envelope("authority").input.request,
        observation: { provider: "fake", observed_session_id: observed, observed_at: LAUNCH_NOW },
      };
      const result = await f.hub.execute(
        bindAgentSessionCommand,
        operation(f, "session-bind", request),
      );
      if (["ambiguous", "ended", "wrong provider"].includes(state)) {
        expect(result).toMatchObject({ ok: false, error: { code: "session_conflict" } });
        expect(await agentEffects(f.db)).toEqual(before);
      } else {
        expect(success(result).binding.provider_session_id).toBe(session);
        expect(
          await f.db
            .prepare(
              "SELECT requested_session_id, observed_session_id, execution_id FROM provider_sessions WHERE id = ?",
            )
            .get(session),
        ).toEqual({
          requested_session_id: "requested-vendor-id",
          observed_session_id: observed,
          execution_id: f.final.run_execution_id,
        });
      }
    },
  );

  it("bootstrap reads cannot create a canonical binding and an unattached execution cannot bind", async () => {
    const f = await fixture();
    for (const action of actions) success(await f.execute(action));
    expect(
      await f.db.prepare("SELECT COUNT(*) AS count FROM execution_session_bindings").get(),
    ).toEqual({ count: 0 });
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM provider_sessions").get()).toEqual({
      count: 0,
    });
    const request: AgentSessionBindRequest = {
      reference: f.envelope("authority").input.request,
      observation: {
        provider: "fake",
        observed_session_id: "synthetic-unattached",
        observed_at: LAUNCH_NOW,
      },
    };
    const before = await agentEffects(f.db);
    expect(
      await f.hub.execute(bindAgentSessionCommand, operation(f, "session-bind", request)),
    ).toMatchObject({ ok: false, error: { code: "session_not_bound" } });
    expect(await agentEffects(f.db)).toEqual(before);
  });

  it("commits one run-attributed comment, preserves creator fields and emits only safe origin receipts", async () => {
    const f = await sessionFixture(),
      request = f.comment();
    const creator = await f.db
      .prepare("SELECT created_by_human_id, created_by_delegation_id FROM tasks WHERE id = ?")
      .get(f.task.id);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        f.hub.execute(agentRunCommentCommand, operation(f, "comment", request)),
      ),
    );
    const result = success(outcomes[0]!);
    expect(outcomes.filter((outcome) => outcome.ok && !outcome.replayed)).toHaveLength(1);
    for (const outcome of outcomes) expect(success(outcome)).toEqual(result);
    expect(result.origin).toEqual(f.result.origin);
    expect(
      await f.db
        .prepare(
          "SELECT body, kind, author_human_id, author_delegation_id FROM comments WHERE id = ?",
        )
        .get(result.id),
    ).toEqual({
      body: request.body,
      kind: "discussion",
      author_human_id: null,
      author_delegation_id: null,
    });
    expect(
      await f.db
        .prepare(
          `SELECT operation_key,run_id,execution_id,assignment_generation,provider_session_id,
      source_task_id,target_task_id,comment_id,kind FROM agent_work_effects`,
        )
        .get(),
    ).toEqual({
      operation_key: agentWorkKey("comment", request.reference),
      run_id: f.launch.run_id,
      execution_id: f.final.run_execution_id,
      assignment_generation: 1,
      provider_session_id: f.result.binding.provider_session_id,
      source_task_id: f.task.id,
      target_task_id: f.task.id,
      comment_id: result.id,
      kind: "comment.add",
    });
    expect(
      await f.db
        .prepare("SELECT created_by_human_id, created_by_delegation_id FROM tasks WHERE id = ?")
        .get(f.task.id),
    ).toEqual(creator);
    for (const [table, column] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = (await f.db
        .prepare(`SELECT payload_json FROM ${table} WHERE ${column} = 'agent_run.comment'`)
        .all()) as { payload_json: string }[];
      expect(rows).toHaveLength(1);
      const receipt = JSON.parse(rows[0]!.payload_json);
      expect(receipt.actor.runnerId).toBe(f.runner);
      expect(receipt.result.origin).toEqual(result.origin);
      expect(rows[0]!.payload_json).not.toContain(request.body);
      expect(rows[0]!.payload_json).not.toContain(f.principal.tokenId);
      expect(rows[0]!.payload_json).not.toContain(f.request.observation.observed_session_id);
    }
  });

  it("recovers a committed result after local cache loss while rejecting changed payload and session", async () => {
    const f = await sessionFixture(),
      request = f.comment("lost-comment-response");
    const original = success(
      await f.hub.execute(agentRunCommentCommand, operation(f, "comment", request)),
    );
    const restarted = new WorkspaceHub(f.db),
      before = await agentEffects(f.db);
    const outcome = await restarted.execute(
      agentRunCommentCommand,
      operation(f, "comment", request),
    );
    expect(outcome.ok && outcome.replayed).toBe(true);
    expect(success(outcome)).toEqual(original);
    expect(
      await restarted.execute(
        agentRunCommentCommand,
        operation(f, "comment", { ...request, body: "Changed content" }),
      ),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(
      await restarted.execute(
        agentRunCommentCommand,
        operation(f, "comment", {
          ...request,
          binding: { ...request.binding, provider_session_id: randomUlid() },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: "session_conflict" } });
    expect(await agentEffects(f.db)).toEqual(before);
  });

  it.each([
    [
      "requester grant",
      "UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?",
      "revoked",
    ],
    ["runner grant epoch", "UPDATE runners SET grant_epoch = 2 WHERE id = ?", "revoked"],
    ["runner token epoch", "UPDATE runners SET token_epoch = 2 WHERE id = ?", "revoked"],
    [
      "execution end",
      "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
      "assignment_ended",
    ],
    [
      "terminal result",
      "UPDATE runs SET result_state = 'accepted' WHERE id = ?",
      "capability_closed",
    ],
    [
      "session end",
      "UPDATE provider_sessions SET state = 'ended', ended_at = ? WHERE id = ?",
      "capability_closed",
    ],
    [
      "lease expiry",
      "UPDATE checkout_leases SET expires_at = ? WHERE execution_id = ?",
      "capability_closed",
    ],
  ] as const)(
    "rechecks %s before fresh and cached binding, bound authority and comments",
    async (name, sql, code) => {
      const f = await sessionFixture(),
        bound = f.bound(),
        comment = f.comment();
      success(
        await f.hub.execute(agentBoundAuthorityCommand, operation(f, "bound-authority", bound)),
      );
      success(await f.hub.execute(agentRunCommentCommand, operation(f, "comment", comment)));
      const target = name.startsWith("runner")
        ? f.runner
        : name.startsWith("requester")
          ? FIX.member
          : name === "terminal result"
            ? f.launch.run_id
            : name === "session end"
              ? f.result.binding.provider_session_id
              : f.final.run_execution_id;
      await f.db.prepare(sql).run(...(sql.includes("= ? WHERE") ? [LAUNCH_NOW, target] : [target]));
      const before = await agentEffects(f.db);
      expect(await f.bind()).toMatchObject({ ok: false, error: { code } });
      for (const request of [bound, f.bound()])
        expect(
          await f.hub.execute(agentBoundAuthorityCommand, operation(f, "bound-authority", request)),
        ).toMatchObject({ ok: false, error: { code } });
      for (const request of [comment, f.comment()])
        expect(
          await f.hub.execute(agentRunCommentCommand, operation(f, "comment", request)),
        ).toMatchObject({ ok: false, error: { code } });
      expect(await agentEffects(f.db)).toEqual(before);
    },
  );

  it("uses post-FIFO time before returning a cached comment", async () => {
    const f = await sessionFixture(),
      request = f.comment();
    success(await f.hub.execute(agentRunCommentCommand, operation(f, "comment", request)));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pause: HubCommand<null, null> = {
      name: "test.agent_comment_pause",
      async run() {
        entered();
        await blocked;
        return null;
      },
    };
    const earlier = f.human(pause, null);
    await started;
    const queued = f.hub.execute(agentRunCommentCommand, operation(f, "comment", request));
    vi.setSystemTime(new Date(Date.parse(LAUNCH_NOW) + 46_000));
    release();
    success(await earlier);
    expect(await queued).toMatchObject({ ok: false, error: { code: "capability_closed" } });
  });

  it("rolls back a new canonical session with its binding after a late D1 batch failure", async () => {
    const staged = stagedD1(await openMigratedDomainDb()),
      f = await fixture(staged.db);
    success(
      await f.native(observeCheckoutLeaseCommand, {
        principal: f.principal,
        observation: leaseObservation(f.final),
      }),
    );
    const request: AgentSessionBindRequest = {
      reference: f.envelope("authority").input.request,
      observation: {
        provider: "fake",
        observed_session_id: "synthetic-atomic-conversation",
        observed_at: LAUNCH_NOW,
      },
    };
    const before = await agentEffects(f.db);
    staged.fail(/INSERT INTO execution_session_bindings/u);
    expect(
      await f.hub.execute(bindAgentSessionCommand, operation(f, "session-bind", request)),
    ).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(await agentEffects(f.db)).toEqual(before);
    staged.fail();
    success(await f.hub.execute(bindAgentSessionCommand, operation(f, "session-bind", request)));
    expect(
      staged.batches.at(-1)?.some((sql) => sql.includes("INSERT INTO provider_sessions")),
    ).toBe(true);
    expect(
      staged.batches.at(-1)?.some((sql) => sql.includes("INSERT INTO execution_session_bindings")),
    ).toBe(true);
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM provider_sessions").get()).toEqual({
      count: 1,
    });
    expect(
      await f.db.prepare("SELECT COUNT(*) AS count FROM execution_session_bindings").get(),
    ).toEqual({ count: 1 });
  });

  it("keeps preparation read-only and comment provenance atomic under a late D1 batch failure", async () => {
    const staged = stagedD1(await openMigratedDomainDb()),
      f = await sessionFixture(staged.db);
    const before = await agentEffects(f.db),
      request = f.comment();
    staged.fail(/INSERT INTO agent_work_effects/u);
    expect(
      await f.hub.execute(agentRunCommentCommand, operation(f, "comment", request)),
    ).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(await agentEffects(f.db)).toEqual(before);
    staged.fail();
    success(await f.hub.execute(agentRunCommentCommand, operation(f, "comment", request)));
    expect(staged.batches.at(-1)?.some((sql) => sql.includes("INSERT INTO comments"))).toBe(true);
    expect(
      staged.batches.at(-1)?.some((sql) => sql.includes("INSERT INTO agent_work_effects")),
    ).toBe(true);
    expect(await f.db.prepare("SELECT COUNT(*) AS count FROM comments").get()).toEqual({
      count: 1,
    });
  });

  it.each(["binding", "bound authority", "comment"] as const)(
    "keeps a transient %s database fault retryable without effects",
    async (action) => {
      const f = await sessionFixture(),
        before = await agentEffects(f.db);
      const hub = new WorkspaceHub(failingReads(f.db, /FROM execution_session_bindings/u));
      const outcome =
        action === "binding"
          ? await hub.execute(bindAgentSessionCommand, operation(f, "session-bind", f.request))
          : action === "bound authority"
            ? await hub.execute(
                agentBoundAuthorityCommand,
                operation(f, "bound-authority", f.bound()),
              )
            : await hub.execute(agentRunCommentCommand, operation(f, "comment", f.comment()));
      expect(outcome).toMatchObject({ ok: false, error: { code: "command_failed" } });
      expect(JSON.stringify(outcome)).not.toContain("synthetic-private");
      expect(await agentEffects(f.db)).toEqual(before);
    },
  );

  it("keeps the same canonical conversation through two actual resume associations", async () => {
    const f = await sessionFixture(),
      canonical = f.result.binding.provider_session_id,
      originatingExecution = f.final.run_execution_id;
    let final = f.final;
    for (const generation of [2, 3]) {
      success(
        await f.native(observeCheckoutLeaseCommand, {
          principal: f.principal,
          observation: {
            ...leaseObservation(final, 2),
            operation: "release",
            supervisor_state: "gone",
            group_state: "gone",
            lock_state: "gone",
            descendants_state: "gone",
          },
        }),
      );
      const control = success(
        await f.human(createRunControlCommand, {
          schema_version: 1,
          idempotency_key: randomUlid(),
          runner_id: f.runner,
          run_execution_id: final.run_execution_id,
          assignment_generation: final.assignment_generation,
          action: "resume",
        }),
      );
      const claimedControl = success(
        await f.native(claimRunControlCommand, {
          principal: f.principal,
          claim: {
            schema_version: 1,
            idempotency_key: randomUlid(),
            control_id: control.control_id,
            run_execution_id: final.run_execution_id,
            assignment_generation: final.assignment_generation,
            action: "resume",
          },
        }),
      );
      const resumed = success(
        await f.native(claimLaunchCommand, {
          principal: f.principal,
          claim: {
            schema_version: 1,
            launch_id: claimedControl.resume_launch_id!,
            runner_id: f.runner,
            idempotency_key: randomUlid(),
            claimed_at: LAUNCH_NOW,
          },
        }),
      );
      expect(resumed.state).toBe("claimed");
      if (resumed.state !== "claimed") throw new Error("resume did not claim");
      expect(resumed.claim.specification.resume_session).toEqual({
        provider_session_id: canonical,
        observed_session_id: f.request.observation.observed_session_id,
      });
      const spec = resumed.claim.specification;
      final = {
        ...final,
        launch_id: claimedControl.resume_launch_id!,
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
          observation: leaseObservation(final),
        }),
      );
      const request: AgentSessionBindRequest = {
        ...f.request,
        reference: {
          ...f.request.reference,
          run_execution_id: final.run_execution_id,
          assignment_generation: generation,
          request_id: randomUlid(),
        },
      };
      expect(
        await f.hub.execute(
          bindAgentSessionCommand,
          operation(f, "session-bind", {
            ...request,
            observation: {
              ...request.observation,
              observed_session_id: "wrong-resume-conversation",
            },
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "session_conflict" } });
      expect(
        success(await f.hub.execute(bindAgentSessionCommand, operation(f, "session-bind", request)))
          .binding.provider_session_id,
      ).toBe(canonical);
    }
    expect(await f.db.prepare("SELECT id, execution_id FROM provider_sessions").all()).toEqual([
      { id: canonical, execution_id: originatingExecution },
    ]);
    expect(
      await f.db
        .prepare(
          "SELECT assignment_generation, provider_session_id FROM execution_session_bindings ORDER BY assignment_generation",
        )
        .all(),
    ).toEqual(
      [1, 2, 3].map((assignment_generation) => ({
        assignment_generation,
        provider_session_id: canonical,
      })),
    );
  });
});

describe("local-agent assignment authority", () => {
  it.each([
    ["authority", "agent:b08fbc6f24ce5d81c771699cbbecb5ed483cffeee8a2e2edbde37814ec16a7e8"],
    ["context", "agent:d6ee798be9350662045b52a5e9224c5301612b59c74262e94eb6aeb97f197dd8"],
    ["task", "agent:9f1decf217d49a3060105c80f6031d8b9b6425b8cd959f553a333d805609a9d7"],
  ] as const)("preserves the committed %s read identity hash", (action, expected) => {
    const reference: AgentWorkRequest = {
      schema_version: 1,
      run_execution_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      assignment_generation: 7,
      request_id: "historical-read-identity",
    };
    expect(agentWorkKey(action, reference)).toBe(expected);
    // Wire validation still rejects extra fields; operation identity is deliberately
    // independent of write payloads and session references carried by later commands.
    expect(
      agentWorkKey(action, {
        ...reference,
        body: "excluded",
        binding: "excluded",
      } as AgentWorkRequest),
    ).toBe(expected);
  });

  it.each([
    ["runner revoked", "UPDATE runners SET revoked_at = ? WHERE id = ?", "revoked"],
    [
      "runner grant epoch",
      "UPDATE runners SET grant_epoch = grant_epoch + 1 WHERE id = ?",
      "revoked",
    ],
    [
      "runner authorization epoch",
      "UPDATE runners SET authorization_epoch = authorization_epoch + 1 WHERE id = ?",
      "revoked",
    ],
    [
      "runner token epoch",
      "UPDATE runners SET token_epoch = token_epoch + 1 WHERE id = ?",
      "revoked",
    ],
    [
      "requester revoked",
      "UPDATE workspace_authorization_epochs SET revoked_at = ? WHERE human_id = ?",
      "revoked",
    ],
    [
      "requester launch grant",
      "UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?",
      "revoked",
    ],
    [
      "requester reviewer role",
      "UPDATE workspace_members SET role = 'reviewer' WHERE human_id = ?",
      "revoked",
    ],
    ["runner project grant", "DELETE FROM runner_project_grants WHERE runner_id = ?", "revoked"],
    [
      "execution ended",
      "UPDATE run_executions SET state = 'ended', end_reason = 'process_exit', ended_at = ? WHERE id = ?",
      "assignment_ended",
    ],
    [
      "accepted result",
      "UPDATE runs SET result_state = 'accepted' WHERE id = ?",
      "capability_closed",
    ],
    ["failed result", "UPDATE runs SET result_state = 'failed' WHERE id = ?", "capability_closed"],
    [
      "cancelled result",
      "UPDATE runs SET result_state = 'cancelled' WHERE id = ?",
      "capability_closed",
    ],
    ["missing lease", "DELETE FROM checkout_leases WHERE execution_id = ?", "capability_closed"],
    [
      "released lease",
      "UPDATE checkout_leases SET state = 'released', released_at = ? WHERE execution_id = ?",
      "capability_closed",
    ],
    [
      "unknown containment",
      "UPDATE checkout_leases SET state = 'containment_unknown', containment_reason = 'identity_ambiguous' WHERE execution_id = ?",
      "capability_closed",
    ],
  ] as const)(
    "rejects fresh and cached authority/context/task requests after %s",
    async (reason, sql, code) => {
      const f = await fixture();
      const cached = actions.map((action) => [action, f.envelope(action)] as const);
      for (const [action, request] of cached) success(await f.execute(action, request));
      const target = reason.startsWith("runner")
        ? f.runner
        : reason.startsWith("requester")
          ? FIX.member
          : reason.includes("result")
            ? f.launch.run_id
            : f.final.run_execution_id;
      const parameters = sql.includes("= ? WHERE") ? [LAUNCH_NOW, target] : [target];
      await f.db.prepare(sql).run(...parameters);
      const before = await effects(f.db);
      for (const [action, request] of cached) {
        expect(await f.execute(action, request)).toMatchObject({ ok: false, error: { code } });
        expect(await f.execute(action)).toMatchObject({ ok: false, error: { code } });
      }
      expect(await effects(f.db)).toEqual(before);
    },
  );

  it.each(["requester epoch", "requester project grant"] as const)(
    "rechecks the %s independently of runner ownership",
    async (reason) => {
      const f = await fixture(),
        request = f.envelope("context");
      success(await f.execute("context", request));
      if (reason === "requester epoch") {
        await f.db
          .prepare(`UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?`)
          .run(FIX.member);
        await f.db
          .prepare(
            `UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?`,
          )
          .run(FIX.member);
      } else {
        await f.db
          .prepare(`UPDATE projects SET access_mode = 'restricted' WHERE id = ?`)
          .run(FIX.projectA);
        await f.db
          .prepare(`DELETE FROM project_access WHERE project_id = ? AND human_id = ?`)
          .run(FIX.projectA, FIX.member);
      }
      expect(await f.execute("context", request)).toMatchObject({
        ok: false,
        error: { code: "revoked" },
      });
    },
  );

  it("does not revive an assignment with a fresh token after its runner grant epoch changes", async () => {
    const f = await fixture(),
      request = f.envelope("context");
    success(await f.execute("context", request));
    const tokenId = randomUlid();
    const stored = (await f.db
      .prepare(`SELECT claims_json FROM runner_tokens WHERE id = ?`)
      .get(f.principal.tokenId)) as { claims_json: string };
    const claims = { ...JSON.parse(stored.claims_json), jti: tokenId, grant_epoch: 2 };
    await f.db.prepare(`UPDATE runners SET grant_epoch = 2 WHERE id = ?`).run(f.runner);
    await f.db
      .prepare(
        `INSERT INTO runner_tokens
      (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        f.runner,
        tokenId,
        runnerHash("synthetic-new-grant-token"),
        JSON.stringify(claims),
        f.principal.authExpiresAt,
      );
    const currentPrincipal = { ...f.principal, grantEpoch: 2, tokenId };
    expect(await assertCurrentRunnerPrincipal(f.db, currentPrincipal, LAUNCH_NOW)).toMatchObject({
      grantEpoch: 2,
      tokenId,
    });
    expect(
      await f.execute("context", {
        ...request,
        input: { ...request.input, principal: currentPrincipal },
      }),
    ).toMatchObject({ ok: false, error: { code: "revoked" } });
  });

  it("uses time observed after FIFO wait before replaying a cached result", async () => {
    const f = await fixture(),
      request = f.envelope("authority");
    success(await f.execute("authority", request));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pause: HubCommand<null, null> = {
      name: "test.agent_pause",
      async run() {
        entered();
        await blocked;
        return null;
      },
    };
    const earlier = f.human(pause, null);
    await started;
    const queued = f.execute("authority", request);
    vi.setSystemTime(new Date(Date.parse(LAUNCH_NOW) + 46_000));
    release();
    success(await earlier);
    expect(await queued).toMatchObject({ ok: false, error: { code: "capability_closed" } });
  });

  it("orders a requester grant removal before a queued cached context reply", async () => {
    const f = await fixture(),
      request = f.envelope("context");
    success(await f.execute("context", request));
    const revoke: HubCommand<null, null> = {
      name: "test.agent_revoke",
      async run(_input, ctx) {
        await ctx.db
          .prepare(`UPDATE runner_launch_grants SET revoked_at = ? WHERE human_id = ?`)
          .run(ctx.now, FIX.member);
        return null;
      },
    };
    const removed = f.human(revoke, null),
      repeated = f.execute("context", request);
    success(await removed);
    expect(await repeated).toMatchObject({ ok: false, error: { code: "revoked" } });
  });

  it.each(["context", "task", "authority"] as const)(
    "rejects changed retry input for a cached %s command",
    async (action) => {
      const f = await fixture(),
        request = f.envelope(action);
      success(await f.execute(action, request));
      const before = await effects(f.db);
      const changed = {
        ...request,
        input: {
          ...request.input,
          request: {
            ...request.input.request,
            request_id: randomUlid(),
          },
        },
      };
      expect(await f.execute(action, changed)).toMatchObject({
        ok: false,
        error: { code: "request_rejected" },
      });
      expect(await effects(f.db)).toEqual(before);
    },
  );

  it("rejects a command collision and derives bounded keys from execution, generation, tool and request ID", async () => {
    const f = await fixture(),
      request = f.envelope("task");
    success(await f.execute("task", request));
    expect(await f.execute("context", request)).toMatchObject({
      ok: false,
      error: { code: "idempotency_command_mismatch" },
    });
    const body = request.input.request,
      key = agentWorkKey("task", body);
    expect(key).toMatch(/^[A-Za-z0-9._:~-]{8,128}$/u);
    for (const other of [
      agentWorkKey("context", body),
      agentWorkKey("task", { ...body, run_execution_id: randomUlid() }),
      agentWorkKey("task", { ...body, assignment_generation: body.assignment_generation + 1 }),
      agentWorkKey("task", { ...body, request_id: randomUlid() }),
    ])
      expect(other).not.toBe(key);
  });

  it("rejects foreign execution references, wrong generations and claimed boundary fields without writes", async () => {
    const f = await fixture(),
      before = await effects(f.db);
    for (const action of actions) {
      expect(
        await f.execute(
          action,
          f.envelope(action, randomUlid(), { run_execution_id: randomUlid() }),
        ),
      ).toMatchObject({ ok: false, error: { code: "boundary_escape" } });
      expect(
        await f.execute(action, f.envelope(action, randomUlid(), { assignment_generation: 2 })),
      ).toMatchObject({ ok: false, error: { code: "boundary_escape" } });
      const request = f.envelope(action);
      Object.assign(request.input.request, { task_id: FIX.taskDelegable, provider_pid: 1234 });
      expect(await f.execute(action, request)).toMatchObject({
        ok: false,
        error: { code: "request_rejected" },
      });
    }
    expect(await effects(f.db)).toEqual(before);
  });

  it("does not let another currently enrolled runner read the assignment", async () => {
    const f = await fixture(),
      runner = randomUlid(),
      tokenId = randomUlid(),
      thumbprint = "synthetic-other-runner-thumbprint";
    await f.db
      .prepare(
        `INSERT INTO runners
      (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
      SELECT workspace_id, ?, owner_human_id, 'Synthetic other runner', public_key_json, ?, token_epoch, enrolled_at
      FROM runners WHERE id = ?`,
      )
      .run(runner, thumbprint, f.runner);
    const stored = (await f.db
      .prepare(`SELECT claims_json FROM runner_tokens WHERE id = ?`)
      .get(f.principal.tokenId)) as { claims_json: string };
    const claims = {
      ...JSON.parse(stored.claims_json),
      sub: runner,
      jti: tokenId,
      cnf: { jkt: thumbprint },
    };
    await f.db
      .prepare(
        `INSERT INTO runner_tokens
      (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        runner,
        tokenId,
        runnerHash("synthetic-other-token"),
        JSON.stringify(claims),
        f.principal.authExpiresAt,
      );
    const principal: RunnerPrincipal = {
      ...f.principal,
      runnerId: runner,
      tokenId,
      keyThumbprint: thumbprint,
    };
    const request = f.envelope("context");
    expect(
      await f.execute("context", {
        ...request,
        actorRunnerId: runner,
        input: { ...request.input, principal },
      }),
    ).toMatchObject({ ok: false, error: { code: "boundary_escape" } });
  });

  it("rejects human, delegation and system actor substitution for runner work", async () => {
    const f = await fixture(),
      before = await effects(f.db);
    for (const actors of [
      { actorHumanId: FIX.owner },
      { actorHumanId: FIX.owner, actorDelegationId: randomUlid() },
      { actorSystemId: f.launch.run_id },
    ]) {
      const request = f.envelope("context");
      delete request.actorRunnerId;
      expect((await f.execute("context", { ...request, ...actors })).ok).toBe(false);
    }
    expect(await effects(f.db)).toEqual(before);
  });

  it.each([/FROM runners WHERE/u, /FROM workspace_members AS membership/u])(
    "keeps an infrastructure failure retryable instead of inventing revocation (%s)",
    async (pattern) => {
      const f = await fixture(),
        before = await effects(f.db);
      const hub = new WorkspaceHub(failingReads(f.db, pattern));
      const outcome = await hub.execute(agentRunContextCommand, f.envelope("context"));
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(JSON.stringify(outcome)).not.toContain("synthetic-private-d1-failure");
      expect(await effects(f.db)).toEqual(before);
    },
  );
});

describe("local-agent item-aligned context", () => {
  it("returns actual ordered per-item delivery rows, excludes human context and deduplicates concurrent retries", async () => {
    const f = await fixture();
    for (const [audience, body] of [
      ["human", "Synthetic private human note"],
      ["agent", "Synthetic brief"],
      ["both", "Synthetic shared constraint"],
    ] as const) {
      success(
        await f.human(addContextCommand, { taskId: f.task.id, kind: "brief", audience, body }),
      );
    }
    const request = f.envelope("context");
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => f.execute("context", request)),
    );
    const result = success(outcomes[0]!) as RunContextResult;
    expect(result.context.map((item) => item.audience)).toEqual(["agent", "both"]);
    expect(result.context.map((item) => item.version)).toEqual([2, 3]);
    expect(result.deliveries).toHaveLength(result.context.length);
    expect(decodeWireDocument("agent-context-result", Buffer.from(JSON.stringify(result))).ok).toBe(
      true,
    );
    expect(result).not.toHaveProperty("delivery");
    const committed = await f.db
      .prepare(
        `SELECT id, context_version, content_hash, delivered_at, run_id
      FROM task_context_deliveries WHERE task_id = ? ORDER BY context_version`,
      )
      .all(f.task.id);
    expect(result.deliveries).toEqual(committed);
    result.context.forEach((item, index) =>
      expect(result.deliveries[index]).toMatchObject({
        context_version: item.version,
        content_hash: item.content_hash,
        run_id: f.launch.run_id,
      }),
    );
    for (const outcome of outcomes) expect(success(outcome)).toEqual(result);
    expect(outcomes.filter((outcome) => outcome.ok && !outcome.replayed)).toHaveLength(1);
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "decision",
        audience: "agent",
        body: "Synthetic later decision",
      }),
    );
    expect(success(await f.execute("context", request))).toEqual(result);
    expect(
      await f.db
        .prepare(`SELECT COUNT(*) AS count FROM task_context_deliveries WHERE task_id = ?`)
        .get(f.task.id),
    ).toEqual({ count: 2 });
  });

  it("returns two empty arrays without inventing a delivery", async () => {
    const f = await fixture();
    expect(success(await f.execute("context"))).toEqual({ context: [], deliveries: [] });
    expect(
      await f.db.prepare(`SELECT COUNT(*) AS count FROM task_context_deliveries`).get(),
    ).toEqual({ count: 0 });
  });

  it("rejects a context whose Go-escaped reply exceeds the bound before any canonical writes", async () => {
    const f = await fixture(),
      body = "<>&\u2028\u2029".repeat(2100);
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "brief",
        audience: "agent",
        body,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify({ body }))).toBeLessThan(61_440);
    const before = await effects(f.db);
    const prepare = f.db.prepare.bind(f.db),
      staged: string[] = [];
    vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      return {
        ...statement,
        async run(...params: unknown[]) {
          staged.push(sql);
          return statement.run(...params);
        },
      };
    });
    expect(await f.execute("context")).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    expect(await effects(f.db)).toEqual(before);
    expect(staged).toEqual([]);
  });

  it("keeps private task/context text in responses and idempotency, not event/audit/outbox receipts", async () => {
    const f = await fixture(),
      body = "Synthetic A01 private context canary",
      title = "Synthetic A01 private title canary";
    await f.db
      .prepare(`UPDATE tasks SET title = ?, punchline = ? WHERE id = ?`)
      .run(title, "Synthetic private punchline", f.task.id);
    success(
      await f.human(addContextCommand, {
        taskId: f.task.id,
        kind: "brief",
        audience: "agent",
        body,
      }),
    );
    const context = success(await f.execute("context")) as RunContextResult;
    expect(context.context[0]?.body).toBe(body);
    expect(success(await f.execute("task"))).toMatchObject({ title });
    for (const [table, kindColumn] of [
      ["semantic_events", "kind"],
      ["audit_events", "action"],
      ["outbox_records", "kind"],
    ] as const) {
      const rows = (await f.db
        .prepare(
          `SELECT payload_json FROM ${table} WHERE ${kindColumn} IN ('agent_run.context', 'agent_run.task')`,
        )
        .all()) as { payload_json: string }[];
      expect(rows).toHaveLength(2);
      const receipts = rows.map((row) => row.payload_json).join("\n");
      expect(receipts).not.toContain(body);
      expect(receipts).not.toContain(title);
      expect(receipts).not.toContain("Synthetic private punchline");
      expect(receipts).not.toContain(f.principal.tokenId);
      expect(receipts).toContain(context.deliveries[0]!.id);
    }
    const stored = (await f.db
      .prepare(
        `SELECT result_json FROM idempotency_records WHERE command_name = 'agent_run.context'`,
      )
      .get()) as { result_json: string };
    expect(stored.result_json).toContain(body);
  });
});
