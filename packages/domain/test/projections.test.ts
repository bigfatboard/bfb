// ABOUTME: Verifies W01/C08 board projections: project lanes and Needs Now deck bounds.
// ABOUTME: Builds cards from committed fixtures without inventing live agent state.

import { describe, expect, it } from "vitest";

import { WorkspaceHub } from "../src/hub.js";
import { createTaskCommand } from "../src/work-commands.js";
import {
  buildNeedsNowDeck,
  buildProjectLanes,
  unavailableAgentWorkCopy,
} from "../src/projections.js";
import { FIX } from "../src/fixtures.js";
import { openDomainDb } from "./helpers.js";

describe("work surface projections", () => {
  it("builds project lanes without side stripes and a bounded attention deck", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "p0",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        projectId: FIX.projectA,
        title: "Blocked for owner",
        priority: "P0",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
        nextActionReason: "Need owner decision",
        dueAt: "2026-08-07T10:00:00Z",
      },
    });
    // mark blocked
    await db
      .prepare(`UPDATE tasks SET state = 'blocked' WHERE workspace_id = ?`)
      .run(FIX.workspace);
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "p2",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        projectId: FIX.projectB,
        title: "Later work",
        priority: "P2",
        nextOwnerType: "human",
        nextOwnerId: FIX.owner,
        dueAt: "2026-08-07T10:00:00Z",
      },
    });

    const lanes = await buildProjectLanes(db, FIX.workspace, [FIX.projectA, FIX.projectB]);
    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.tasks[0]?.sideStripe).toBe(false);
    expect(lanes[0]?.tasks[0]?.topEdgePx).toBe(3);
    expect(lanes[0]?.tasks[0]?.nowLabel).toBe("NOW");

    const deck = await buildNeedsNowDeck(
      db,
      FIX.workspace,
      FIX.owner,
      [FIX.projectA, FIX.projectB],
      "2026-08-07T12:00:00Z",
    );
    expect(deck.length).toBeLessThanOrEqual(3);
    expect(deck.every((item) => item.priority === "P0" || item.priority === "P1")).toBe(true);
    expect(deck.some((item) => item.title === "Later work")).toBe(false);
    expect(unavailableAgentWorkCopy()).toBe("Agent work unavailable");
  });
});
