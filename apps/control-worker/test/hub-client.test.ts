// ABOUTME: Proves workspace mutations serialize through the Durable Object-shaped hub client.
// ABOUTME: Uses createTestWorkspaceHubNamespace so FIFO is not process-local request construction.

import { describe, expect, it, vi } from "vitest";

import { createTaskCommand } from "@bfb/domain";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";

import { createTestWorkspaceHubNamespace, executeWorkspaceCommand } from "../src/hub-client.js";

describe("workspace hub durable object client", () => {
  it("routes concurrent commands through one DO stub lane per workspace", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const jurisdiction = vi.fn(() => ns);
    Object.assign(ns, { jurisdiction });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        executeWorkspaceCommand(
          { db, workspaceId: FIX.workspace, jurisdiction: "eu", workspaceHubNs: ns },
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
    const ns = createTestWorkspaceHubNamespace(db);
    const jurisdiction = vi.fn(() => ns);
    Object.assign(ns, { jurisdiction });
    const outcome = await executeWorkspaceCommand(
      { db, workspaceId: FIX.workspace, jurisdiction: "global", workspaceHubNs: ns },
      createTaskCommand,
      {
        workspaceId: FIX.workspace,
        idempotencyKey: "global-placement",
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        now: "2026-08-07T12:00:00Z",
        input: {
          projectId: FIX.projectA,
          title: "Global placement task",
          priority: "P2",
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(jurisdiction).not.toHaveBeenCalled();
  });

  it("rejects workspace id mismatch against the hub jurisdiction scope", async () => {
    const db = await openDomainDb();
    const ns = createTestWorkspaceHubNamespace(db);
    const outcome = await executeWorkspaceCommand(
      { db, workspaceId: FIX.workspace, jurisdiction: "eu", workspaceHubNs: ns },
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
});
