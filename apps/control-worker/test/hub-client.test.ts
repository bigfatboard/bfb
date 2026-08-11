// ABOUTME: Proves workspace mutations serialize through the Durable Object-shaped hub client.
// ABOUTME: Uses createTestWorkspaceHubNamespace so FIFO is not process-local request construction.

import { describe, expect, it, vi } from "vitest";

import { createTaskCommand, randomUlid } from "@bfb/domain";
import { createAuthorizationContext } from "@bfb/db";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";

import { createTestWorkspaceHubNamespace, executeWorkspaceCommand } from "../src/hub-client.js";

function authorization(workspaceId = FIX.workspace, jurisdiction: "eu" | "us" | "global" = "eu") {
  return createAuthorizationContext({
    workspaceId,
    principalId: FIX.owner,
    authorizationEpoch: 1,
    jurisdiction,
  });
}

describe("workspace hub durable object client", () => {
  it("routes concurrent commands through one DO stub lane per workspace", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const jurisdiction = vi.fn(() => ns);
    Object.assign(ns, { jurisdiction });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        executeWorkspaceCommand(
          { db, authorization: authorization(), workspaceHubNs: ns },
          createTaskCommand,
          {
            workspaceId: FIX.workspace,
            idempotencyKey: `do-lane-${n}`,
            authorizationEpoch: 1,
            actorHumanId: FIX.owner,
            now: "2026-08-07T12:00:00Z",
            input: {
              projectId: FIX.projectA,
              title: `DO task ${n}`,
              priority: "P2",
            },
          },
        ),
      ),
    );
    expect(jurisdiction).toHaveBeenCalledTimes(5);
    expect(jurisdiction).toHaveBeenCalledWith("eu");
    expect(results.every((result) => result.ok)).toBe(true);
    const cursors = results.map((result) => (result.ok ? result.cursor : -1)).sort((a, b) => a - b);
    expect(cursors).toEqual([1, 2, 3, 4, 5]);
  });

  it("uses the raw namespace for global placement", async () => {
    const db = await openDomainDb();
    const workspaceId = randomUlid();
    const projectId = randomUlid();
    await db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, 'global-workspace', 'global', '2026-08-07T12:00:00Z', 1)`,
      )
      .run(workspaceId);
    await db
      .prepare(
        `INSERT INTO workspace_members
         (workspace_id, human_id, role, authorization_epoch, created_at)
         VALUES (?, ?, 'owner', 1, '2026-08-07T12:00:00Z')`,
      )
      .run(workspaceId, FIX.owner);
    await db
      .prepare(
        `INSERT INTO workspace_authorization_epochs
         (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
         VALUES (?, ?, 1, NULL, '2026-08-07T12:00:00Z')`,
      )
      .run(workspaceId, FIX.owner);
    await db
      .prepare(
        `INSERT INTO projects
         (workspace_id, id, name, slug, tint, resource_version, created_at)
         VALUES (?, ?, 'Global project', 'global-project', '#abcdef', 1, '2026-08-07T12:00:00Z')`,
      )
      .run(workspaceId, projectId);
    await db
      .prepare(
        `INSERT INTO project_access (workspace_id, project_id, human_id)
         VALUES (?, ?, ?)`,
      )
      .run(workspaceId, projectId, FIX.owner);
    const ns = createTestWorkspaceHubNamespace(db);
    const jurisdiction = vi.fn(() => ns);
    Object.assign(ns, { jurisdiction });
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(workspaceId, "global"), workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId,
        idempotencyKey: "global-placement",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: {
          projectId,
          title: "Global placement task",
          priority: "P2",
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(jurisdiction).not.toHaveBeenCalled();
  });

  it("rejects a resolver jurisdiction that differs from the persisted workspace", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const jurisdiction = vi.fn(() => ns);
    Object.assign(ns, { jurisdiction });
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(FIX.workspace, "global"), workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId: FIX.workspace,
        idempotencyKey: "wrong-jurisdiction",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: {
          projectId: FIX.projectA,
          title: "Must not reach another hub namespace",
          priority: "P2",
        },
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("workspace_jurisdiction_mismatch");
    }
    expect(jurisdiction).not.toHaveBeenCalled();
  });

  it("rejects workspace id mismatch against the hub jurisdiction scope", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(), workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId: "01JBFB0OTHERWORKSPACE000000",
        idempotencyKey: "mismatch",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: {
          projectId: FIX.projectA,
          title: "wrong workspace",
          priority: "P2",
        },
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("workspace_mismatch");
    }
  });

  it("rejects a stale command epoch before addressing the Durable Object", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const get = vi.fn(ns.get.bind(ns));
    Object.assign(ns, { get });
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(), workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId: FIX.workspace,
        idempotencyKey: "stale-authority",
        authorizationEpoch: 2,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: { projectId: FIX.projectA, title: "stale", priority: "P2" },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "stale_authorization" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an actor that differs from the resolved authorization principal", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const get = vi.fn(ns.get.bind(ns));
    Object.assign(ns, { get });
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(), workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId: FIX.workspace,
        idempotencyKey: "wrong-actor-key",
        authorizationEpoch: 1,
        actorHumanId: FIX.member,
        now: "2026-08-07T12:00:00Z",
        input: { projectId: FIX.projectA, title: "wrong actor", priority: "P2" },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "command_authority_mismatch" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("does not fall back to process-local execution after a Durable Object failure", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    Object.assign(ns, {
      get() {
        return {
          async fetch() {
            throw new Error("synthetic DO failure");
          },
        };
      },
    });
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(), workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId: FIX.workspace,
        idempotencyKey: "do-failure-key",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: { projectId: FIX.projectA, title: "must not run", priority: "P2" },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "hub_rpc_failed" } });
    const tasks = (await db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get()) as {
      count: number;
    };
    expect(tasks.count).toBe(0);
  });

  it("does not treat a malformed Durable Object binding as a local-test fallback", async () => {
    const db = await openDomainDb();
    const outcome = await executeWorkspaceCommand(
      {
        db,
        authorization: authorization(),
        workspaceHubNs: {} as DurableObjectNamespace,
      },
      createTaskCommand,
      {
        workspaceId: FIX.workspace,
        idempotencyKey: "bad-binding-key",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: { projectId: FIX.projectA, title: "must not run", priority: "P2" },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "hub_binding_invalid" } });
    const tasks = (await db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get()) as {
      count: number;
    };
    expect(tasks.count).toBe(0);
  });

  it("rejects an authorization context for a workspace that does not exist", async () => {
    const db = await openDomainDb();
    const workspaceId = randomUlid();
    const outcome = await executeWorkspaceCommand(
      { db, authorization: authorization(workspaceId), workspaceHubNs: undefined },
      createTaskCommand,
      {
        workspaceId,
        idempotencyKey: "missing-workspace",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: { projectId: FIX.projectA, title: "missing", priority: "P2" },
      },
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: "workspace_not_found" } });
  });
});
