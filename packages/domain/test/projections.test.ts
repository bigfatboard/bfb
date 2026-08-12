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
    const blocked = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "projection-p0",
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
    const fixtures = [
      {
        key: "projection-p0-due",
        title: "Due P0 for owner",
        priority: "P0" as const,
        ownerType: "human" as const,
        ownerId: FIX.owner,
        dueAt: "2026-08-07T09:00:00Z",
      },
      {
        key: "projection-p1-due",
        title: "Due P1 for owner",
        priority: "P1" as const,
        ownerType: "human" as const,
        ownerId: FIX.owner,
        dueAt: "2026-08-07T08:00:00Z",
      },
      {
        key: "projection-other-human",
        title: "Blocked for another human",
        priority: "P0" as const,
        ownerType: "human" as const,
        ownerId: FIX.member,
        dueAt: "2026-08-07T07:00:00Z",
      },
      {
        key: "projection-agent-owner",
        title: "Due for agent",
        priority: "P0" as const,
        ownerType: "agent_profile" as const,
        ownerId: FIX.profileCodex,
        dueAt: "2026-08-07T07:00:00Z",
      },
      {
        key: "projection-unblocked-undued",
        title: "High priority but not due",
        priority: "P0" as const,
        ownerType: "human" as const,
        ownerId: FIX.owner,
      },
    ];
    for (const fixture of fixtures) {
      await hub.execute(createTaskCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: fixture.key,
        authorizationEpoch: 1,
        actorHumanId: FIX.owner,
        input: {
          projectId: FIX.projectA,
          title: fixture.title,
          priority: fixture.priority,
          nextOwnerType: fixture.ownerType,
          nextOwnerId: fixture.ownerId,
          ...(fixture.dueAt ? { dueAt: fixture.dueAt } : {}),
        },
      });
    }
    const passCandidate = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "projection-pass-candidate",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      input: {
        projectId: FIX.projectA,
        title: "Pass candidate",
        priority: "P2",
        nextOwnerType: "agent_profile",
        nextOwnerId: FIX.profileCodex,
        nextActionReason: "Configured for Codex",
      },
    });
    expect(passCandidate.ok).toBe(true);
    if (!passCandidate.ok) {
      return;
    }
    await db
      .prepare(
        `INSERT INTO runs
         (workspace_id, id, project_id, task_id, requested_by_human_id,
          agent_profile_id, result_state, activity, resource_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', 1, ?)`,
      )
      .run(
        FIX.workspace,
        FIX.runDelegable,
        FIX.projectA,
        passCandidate.result.id,
        FIX.owner,
        FIX.profileCodex,
        "2026-08-07T11:00:00Z",
      );
    const enabledLanes = await buildProjectLanes(db, FIX.workspace, [FIX.projectA]);
    const enabledPassCandidate = enabledLanes
      .flatMap((lane) => lane.tasks)
      .find((task) => task.title === "Pass candidate");
    expect(enabledPassCandidate?.passToAgentProfileId).toBe(FIX.profileCodex);
    expect(enabledPassCandidate?.latestEvent?.kind).toBe("task.create");
    expect(enabledPassCandidate?.runSummary).toEqual({ resultState: "open", activity: "unknown" });
    await db
      .prepare(`UPDATE workspace_policies SET allow_pass_to_agent = 0 WHERE workspace_id = ?`)
      .run(FIX.workspace);
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) {
      return;
    }
    await db
      .prepare(`UPDATE tasks SET state = 'blocked' WHERE workspace_id = ? AND id = ?`)
      .run(FIX.workspace, blocked.result.id);
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "projection-p2",
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
    expect(
      lanes.flatMap((lane) => lane.tasks).find((task) => task.title === "Pass candidate")
        ?.passToAgentProfileId,
    ).toBeUndefined();

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
    expect(deck.map((item) => item.title)).toEqual([
      "Due P0 for owner",
      "Blocked for owner",
      "Due P1 for owner",
    ]);
    expect(deck.some((item) => item.title === "Blocked for another human")).toBe(false);
    expect(deck.some((item) => item.title === "Due for agent")).toBe(false);
    expect(deck.some((item) => item.title === "High priority but not due")).toBe(false);
    expect(unavailableAgentWorkCopy()).toBe("Agent work unavailable");
  });

  it("finds urgent attention beyond the first task page", async () => {
    const db = await openDomainDb();
    const insert = db.prepare(
      `INSERT INTO tasks (
        workspace_id, id, project_id, title, state, priority,
        next_owner_type, next_owner_id, punchline, resource_version,
        created_by_human_id, created_at
      ) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (let index = 0; index < 50; index++) {
      await insert.run(
        FIX.workspace,
        `000000000000000000000000${String(index).padStart(2, "0")}`,
        FIX.projectA,
        `Filler ${index}`,
        "P3",
        "unassigned",
        null,
        "Not urgent",
        FIX.owner,
        "2026-08-07T07:00:00Z",
      );
    }
    await insert.run(
      FIX.workspace,
      "07ZZZZZZZZZZZZZZZZZZZZZZZZ",
      FIX.projectA,
      "Urgent after page one",
      "P0",
      "human",
      FIX.owner,
      "Needs owner now",
      FIX.owner,
      "2026-08-07T08:00:00Z",
    );
    await db
      .prepare(`UPDATE tasks SET due_at = ? WHERE workspace_id = ? AND id = ?`)
      .run("2026-08-07T09:00:00Z", FIX.workspace, "07ZZZZZZZZZZZZZZZZZZZZZZZZ");

    const deck = await buildNeedsNowDeck(
      db,
      FIX.workspace,
      FIX.owner,
      [FIX.projectA],
      "2026-08-07T12:00:00Z",
    );
    expect(deck.map((item) => item.title)).toContain("Urgent after page one");
  });
});
