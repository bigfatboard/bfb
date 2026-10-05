// ABOUTME: Verifies current assignment authority before new and cached local-agent work outcomes.
// ABOUTME: Exercises actual WorkspaceHub ordering, item delivery receipts, bounded replies and safe audit projections.

import type { SqlDatabase } from "@bfb/db";
import { decodeWireDocument, type AgentWorkRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentRunAuthorityCommand,
  agentRunContextCommand,
  agentRunTaskCommand,
  agentWorkKey,
  type AgentWorkInput,
} from "../src/agent-work.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type CommandRequest, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { authorizeLaunchCommand } from "../src/launches.js";
import { runnerHash } from "../src/runner-crypto.js";
import { assertCurrentRunnerPrincipal, type RunnerPrincipal } from "../src/runners.js";
import { addContextCommand, type RunContextResult } from "../src/work-commands.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

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

async function fixture() {
  const f = await launchFixture();
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

describe("local-agent assignment authority", () => {
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
