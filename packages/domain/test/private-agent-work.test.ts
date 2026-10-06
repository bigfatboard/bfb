// ABOUTME: Verifies current requesting-human task access for local-agent reads and intentional writes.
// ABOUTME: Synthetic policies exercise grant levels, revocation and pending replay without enabling private creation.

import type { AgentWorkCapture, AgentWorkRequest } from "@bfb/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRunAuthorityCommand,
  agentRunContextCommand,
  agentRunTaskCommand,
  agentWorkKey,
  type AgentWorkInput,
} from "../src/agent-work.js";
import {
  agentBoundAuthorityCommand,
  agentRunCommentCommand,
  agentRunProgressCommand,
  agentRunProposalCommand,
  agentRunUpdateCommand,
} from "../src/agent-sessions.js";
import { FIX } from "../src/fixtures.js";
import type { HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { addContextCommand } from "../src/work-commands.js";
import { captureFixture } from "./agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "./launch-fixture.js";

type Fixture = Awaited<ReturnType<typeof captureFixture>>;
const reads = {
  authority: agentRunAuthorityCommand,
  context: agentRunContextCommand,
  task: agentRunTaskCommand,
};
function read(f: Fixture, action: keyof typeof reads, request = f.reference()) {
  return f.hub.execute(reads[action] as HubCommand<AgentWorkInput, unknown>, {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: 1,
    idempotencyKey: agentWorkKey(action, request),
    input: { principal: f.principal, request },
  });
}
function operation<T extends { reference: AgentWorkRequest }>(
  f: Fixture,
  action: string,
  request: T,
  replayCapture?: AgentWorkCapture,
) {
  return {
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: 1,
    idempotencyKey: agentWorkKey(action, request.reference),
    input: {
      principal: f.principal,
      request,
      ...(replayCapture ? { replayCapture } : {}),
    },
  };
}
async function makePrivate(f: Fixture, permission?: "read" | "contribute" | "edit") {
  await f.db
    .prepare(
      `INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, f.task.id, FIX.owner, LAUNCH_NOW);
  if (!permission) return undefined;
  const id = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, id, f.task.id, FIX.member, permission, LAUNCH_NOW);
  return id;
}
async function revoke(f: Fixture, grantId: string) {
  await f.db
    .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE workspace_id = ? AND id = ?")
    .run(LAUNCH_NOW, FIX.workspace, grantId);
}
async function effects(f: Fixture) {
  return f.db
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM comments) AS comments,
       (SELECT COUNT(*) FROM tasks) AS tasks,
       (SELECT COUNT(*) FROM agent_work_effects) AS effects,
       (SELECT COUNT(*) FROM task_context_deliveries) AS deliveries,
       (SELECT COUNT(*) FROM idempotency_records) AS receipts`,
    )
    .get();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => vi.useRealTimers());

describe("private local-agent parent authority", () => {
  it("a read grant delivers task and agent context, never human-only notes", async () => {
    const f = await captureFixture();
    await makePrivate(f, "read");
    for (const audience of ["agent", "human"] as const) {
      success(
        await f.human(addContextCommand, {
          taskId: f.task.id,
          kind: "note",
          audience,
          body: `SYNTHETIC_PRIVATE_${audience.toUpperCase()}_CANARY`,
        }),
      );
    }
    expect(await read(f, "task")).toMatchObject({ ok: true, result: { id: f.task.id } });
    const context = await read(f, "context");
    expect(context.ok).toBe(true);
    expect(JSON.stringify(context)).toContain("SYNTHETIC_PRIVATE_AGENT_CANARY");
    expect(JSON.stringify(context)).not.toContain("SYNTHETIC_PRIVATE_HUMAN_CANARY");
  });

  it("runner ownership never substitutes for the requesting human's private access", async () => {
    const f = await captureFixture();
    await makePrivate(f);
    const before = await effects(f);
    for (const action of ["authority", "task", "context"] as const) {
      expect(await read(f, action)).toMatchObject({ ok: false, error: { code: "revoked" } });
    }
    expect(
      await f.hub.execute(agentBoundAuthorityCommand, operation(f, "bound-authority", f.bound())),
    ).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(await effects(f)).toEqual(before);
  });

  it.each(["authority", "task", "context"] as const)(
    "revocation fences a cached %s response",
    async (action) => {
      const f = await captureFixture();
      const grant = (await makePrivate(f, "read"))!;
      const request = f.reference();
      expect((await read(f, action, request)).ok).toBe(true);
      await revoke(f, grant);
      const before = await effects(f);
      expect(await read(f, action, request)).toMatchObject({
        ok: false,
        error: { code: "revoked" },
      });
      expect(await effects(f)).toEqual(before);
    },
  );

  it.each(["read", "contribute", "edit"] as const)(
    "%s grants intersect with each intentional write's permission",
    async (permission) => {
      const f = await captureFixture();
      await makePrivate(f, permission);
      const version = (await f.db
        .prepare("SELECT resource_version FROM tasks WHERE workspace_id = ? AND id = ?")
        .get(FIX.workspace, f.task.id)) as { resource_version: number };
      const comment = await f.hub.execute(
        agentRunCommentCommand,
        operation(f, "comment", { ...f.bound(), body: "Synthetic private comment" }),
      );
      const progress = await f.hub.execute(
        agentRunProgressCommand,
        operation(f, "progress", { ...f.bound(), summary: "Synthetic private progress" }),
      );
      const update = await f.hub.execute(
        agentRunUpdateCommand,
        operation(f, "update", {
          ...f.bound(),
          expected_version: version.resource_version,
          punchline: "Synthetic explicit edit",
        }),
      );
      expect(comment.ok).toBe(permission !== "read");
      expect(progress.ok).toBe(permission !== "read");
      expect(update.ok).toBe(permission === "edit");
    },
  );

  it("downgrading access fences a cached write without revoking current reads", async () => {
    const f = await captureFixture();
    const grant = (await makePrivate(f, "contribute"))!;
    const request = { ...f.bound(), body: "Synthetic committed private comment" };
    const envelope = operation(f, "comment", request);
    expect((await f.hub.execute(agentRunCommentCommand, envelope)).ok).toBe(true);
    await revoke(f, grant);
    await f.db
      .prepare(
        `INSERT INTO task_human_grants
         (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
         VALUES (?, ?, ?, ?, 1, 'read', ?)`,
      )
      .run(FIX.workspace, randomUlid(), f.task.id, FIX.member, LAUNCH_NOW);
    const before = await effects(f);
    expect(await f.hub.execute(agentRunCommentCommand, envelope)).toMatchObject({
      ok: false,
      error: { code: "revoked" },
    });
    expect(await effects(f)).toEqual(before);
    expect((await read(f, "task")).ok).toBe(true);
  });

  it("a captured pending write cannot outlive its sponsor's task grant", async () => {
    const f = await captureFixture();
    const grant = (await makePrivate(f, "contribute"))!;
    const request = { ...f.bound(), body: "Synthetic pending private comment" };
    const capture = await f.capture("agent_run.comment", request);
    await revoke(f, grant);
    const before = await effects(f);
    expect(
      await f.hub.execute(agentRunCommentCommand, operation(f, "comment", request, capture)),
    ).toMatchObject({ ok: false, error: { code: "revoked" } });
    expect(await effects(f)).toEqual(before);
  });

  it.each([false, true])(
    "private proposals fail closed until inheritance/publication (%s)",
    async (child) => {
      const f = await captureFixture();
      await makePrivate(f, "edit");
      const request = {
        ...f.bound(),
        title: "Synthetic private proposal must not become shared",
        ...(child ? { parent_task_id: f.task.id } : {}),
      };
      const before = await effects(f);
      expect(
        await f.hub.execute(agentRunProposalCommand, operation(f, "proposal", request)),
      ).toMatchObject({ ok: false });
      expect(await effects(f)).toEqual(before);
    },
  );
});
