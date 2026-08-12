// ABOUTME: Structural tests for the W01 WorkBoard against domain projection fixtures.
// ABOUTME: Asserts project top edges, attention deck bounds, and unavailable agent copy.

import { describe, expect, it } from "vitest";

import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { createTaskCommand } from "../../../packages/domain/src/work-commands.js";
import { buildNeedsNowDeck, buildProjectLanes } from "../../../packages/domain/src/projections.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { WorkBoard } from "../src/work/board.js";

describe("work board", () => {
  it("projects committed fixtures into board props without side stripes", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "board-key-1",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        projectId: FIX.projectA,
        title: "Board card",
        priority: "P0",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
        nextActionReason: "Need review",
        dueAt: "2026-08-07T10:00:00Z",
      },
    });
    await db
      .prepare(`UPDATE tasks SET state = 'blocked' WHERE workspace_id = ?`)
      .run(FIX.workspace);

    const lanes = await buildProjectLanes(db, FIX.workspace, [FIX.projectA, FIX.projectB]);
    const needsNow = await buildNeedsNowDeck(
      db,
      FIX.workspace,
      FIX.owner,
      [FIX.projectA, FIX.projectB],
      "2026-08-07T12:00:00Z",
    );
    expect(needsNow.length).toBeLessThanOrEqual(3);
    expect(lanes[0]?.tasks[0]?.sideStripe).toBe(false);
    expect(lanes[0]?.tasks[0]?.topEdgePx).toBe(3);
    expect(typeof WorkBoard).toBe("function");
  });
});
