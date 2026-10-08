// ABOUTME: Proves shared-only exact-parent content selection for operations activity and stuck work.
// ABOUTME: Synthetic privacy and authority races do not operate providers or certify aggregate diagnostics.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { startLaunchCommand } from "../src/launches.js";
import {
  collectWorkspaceHealth,
  filterOperationsStuckWork,
  listStuckLaunches,
  listStuckUploads,
  readActivityFeed,
} from "../src/operations.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

const NOW = "2026-09-12T13:00:00.000Z";
const access = (humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});

async function fixture() {
  const f = await launchFixture(undefined, { taskCreatorHumanId: FIX.member });
  const privateLaunch = (await f.claim()).launch;
  const shared = success(
    await f.human(
      createTaskCommand,
      { projectId: FIX.projectA, title: "Synthetic shared operations work", priority: "P2" },
      LAUNCH_NOW,
      FIX.member,
    ),
  );
  const checkout = randomUlid();
  await f.refresh(LAUNCH_NOW, {
    checkouts: [
      ...f.inventory().checkouts,
      {
        ...f.inventory().checkouts[0]!,
        checkout_id: checkout,
        physical_worktree_hash: `sha256:${"b".repeat(64)}`,
        label: "Synthetic operations second checkout",
        is_default: false,
      },
    ],
  });
  const sharedLaunch = success(
    await f.human(startLaunchCommand, {
      ...f.start,
      task_id: shared.id,
      checkout_id: checkout,
      idempotency_key: randomUlid(),
    }),
  );
  for (const [index, launch] of [privateLaunch, sharedLaunch, sharedLaunch].entries()) {
    const row = (await f.db
      .prepare(
        "SELECT execution_id, assignment_generation, run_id FROM launch_commands WHERE workspace_id = ? AND id = ?",
      )
      .get(FIX.workspace, launch.launch_id)) as {
      execution_id: string;
      assignment_generation: number;
      run_id: string;
    };
    const eventId = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO event_ledger
         (workspace_id, event_id, workspace_cursor, source_stream_id, source_sequence,
          run_execution_id, assignment_generation, project_id, task_id, run_id,
          actor_type, actor_id, source_type, source_id, source_provider, capture_origin,
          kind, occurred_at, received_at, payload_json)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'runner', ?, 'runner', ?, 'fake',
                 'runner_observed', 'heartbeat', ?, ?, '{}')`,
      )
      .run(
        FIX.workspace,
        eventId,
        100 + index,
        randomUlid(),
        row.execution_id,
        row.assignment_generation,
        FIX.projectA,
        index === 0 ? f.task.id : shared.id,
        row.run_id,
        f.runner,
        f.runner,
        LAUNCH_NOW,
        LAUNCH_NOW,
      );
  }
  const versions: string[] = [];
  for (const runId of [privateLaunch.run_id, sharedLaunch.run_id, null]) {
    const artifactId = randomUlid(),
      versionId = randomUlid();
    versions.push(versionId);
    await f.db
      .prepare(
        `INSERT INTO artifacts
         (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
         VALUES (?, ?, ?, 'log', 'log', ?, ?)`,
      )
      .run(FIX.workspace, artifactId, runId, FIX.member, LAUNCH_NOW);
    await f.db
      .prepare(
        `INSERT INTO artifact_versions
         (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, created_at)
         VALUES (?, ?, ?, 'uploading', 'log', 64, ?, ?)`,
      )
      .run(FIX.workspace, versionId, artifactId, "f".repeat(64), LAUNCH_NOW);
  }
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
  return { ...f, shared, privateLaunch, sharedLaunch, versions };
}

function beforeRead(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      return {
        ...statement,
        async all(...params) {
          if (!fired) {
            fired = true;
            await change();
          }
          return statement.all(...params);
        },
      };
    },
  };
}

async function rotate(db: SqlDatabase) {
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE workspace_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.owner);
}

describe("private operations content selectors", () => {
  it("holds both first and later public activity pages", async () => {
    const f = await fixture();
    await expect(
      readActivityFeed(f.db, FIX.workspace, { limit: 1, access: access() }),
    ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
    await expect(
      readActivityFeed(f.db, FIX.workspace, {
        limit: 1,
        afterCursor: 101,
        access: access(),
      }),
    ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
  });

  it.each([FIX.owner, FIX.member, FIX.reviewer])(
    "holds public activity for %s independently of private grants",
    async (humanId) => {
      const f = await fixture();
      await expect(
        readActivityFeed(f.db, FIX.workspace, { access: access(humanId) }),
      ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
    },
  );

  it("does not bypass the public activity hold without an access context", async () => {
    const f = await fixture();
    await expect(readActivityFeed(f.db, FIX.workspace)).rejects.toMatchObject({
      code: "request_rejected",
      message: "event feeds are unavailable",
    });
  });

  it("holds activity before the ledger query or a staged privacy change", async () => {
    const f = await fixture();
    const db = beforeRead(f.db, /FROM event_ledger/, async () => {
      await f.db
        .prepare(
          "INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(FIX.workspace, f.shared.id, FIX.member, NOW);
    });
    await expect(readActivityFeed(db, FIX.workspace, { access: access() })).rejects.toMatchObject({
      code: "request_rejected",
      message: "event feeds are unavailable",
    });
    expect(
      await f.db.prepare("SELECT task_id FROM task_privacy WHERE task_id=?").get(f.shared.id),
    ).toBeUndefined();
  });

  it("holds activity before the ledger query or a staged epoch change", async () => {
    const f = await fixture();
    const db = beforeRead(f.db, /FROM event_ledger/, () => rotate(f.db));
    await expect(readActivityFeed(db, FIX.workspace, { access: access() })).rejects.toMatchObject({
      code: "request_rejected",
      message: "event feeds are unavailable",
    });
    expect(
      await f.db
        .prepare("SELECT authorization_epoch FROM workspace_members WHERE human_id=?")
        .get(FIX.owner),
    ).toEqual({ authorization_epoch: 1 });
  });

  it("holds activity after project revocation independently of a stale transport list", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE projects SET access_mode = 'restricted' WHERE workspace_id = ? AND id = ?")
      .run(FIX.workspace, FIX.projectA);
    await f.db
      .prepare(
        "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
      )
      .run(FIX.workspace, FIX.projectA, FIX.owner);
    await expect(
      readActivityFeed(f.db, FIX.workspace, {
        access: access(),
        projectIds: [FIX.projectA],
      }),
    ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
  });

  it("filters private stuck uploads, retaining shared and run-free rows", async () => {
    const f = await fixture();
    const rows = await listStuckUploads(f.db, FIX.workspace, NOW, access());
    expect(rows.map((row) => row.version_id).sort()).toEqual(f.versions.slice(1).sort());
    expect(await listStuckUploads(f.db, FIX.workspace, NOW)).toEqual(rows);
  });

  it("checks epoch during stuck upload selection including run-free rows", async () => {
    const f = await fixture();
    const db = beforeRead(f.db, /FROM artifact_versions/, () => rotate(f.db));
    expect(await listStuckUploads(db, FIX.workspace, NOW, access())).toEqual([]);
  });

  it("does not widen stuck-work authority to a reviewer after a role change", async () => {
    const f = await fixture();
    await f.db
      .prepare(
        "UPDATE workspace_members SET role = 'reviewer' WHERE workspace_id = ? AND human_id = ?",
      )
      .run(FIX.workspace, FIX.member);
    expect(await listStuckUploads(f.db, FIX.workspace, NOW, access(FIX.member))).toEqual([]);
    expect(await listStuckLaunches(f.db, FIX.workspace, NOW, access(FIX.member))).toEqual([]);
  });

  it("does not let a foreign authority context authorize this workspace", async () => {
    const f = await fixture();
    const foreign = { ...access(), workspaceId: randomUlid() };
    await expect(readActivityFeed(f.db, FIX.workspace, { access: foreign })).rejects.toMatchObject({
      code: "request_rejected",
      message: "event feeds are unavailable",
    });
    expect(await listStuckUploads(f.db, FIX.workspace, NOW, foreign)).toEqual([]);
    expect(await listStuckLaunches(f.db, FIX.workspace, NOW, foreign)).toEqual([]);
  });

  it("filters private stuck launches without changing their lifecycle", async () => {
    const f = await fixture();
    const before = await f.db
      .prepare("SELECT state FROM launch_commands WHERE workspace_id = ? AND id = ?")
      .get(FIX.workspace, f.privateLaunch.launch_id);
    const rows = await listStuckLaunches(f.db, FIX.workspace, NOW, access());
    expect(rows.map((row) => row.command_id)).toEqual([f.sharedLaunch.launch_id]);
    expect(await listStuckLaunches(f.db, FIX.workspace, NOW)).toEqual(rows);
    expect(
      await f.db
        .prepare("SELECT state FROM launch_commands WHERE workspace_id = ? AND id = ?")
        .get(FIX.workspace, f.privateLaunch.launch_id),
    ).toEqual(before);
  });

  it("checks epoch in the actual stuck launch query", async () => {
    const f = await fixture();
    const db = beforeRead(f.db, /FROM launch_commands/, () => rotate(f.db));
    expect(await listStuckLaunches(db, FIX.workspace, NOW, access())).toEqual([]);
  });

  it("rechecks hydrated upload and launch lists together after an authority change", async () => {
    const f = await fixture();
    const work = {
      uploads: await listStuckUploads(f.db, FIX.workspace, NOW, access()),
      launches: await listStuckLaunches(f.db, FIX.workspace, NOW, access()),
    };
    expect(work.uploads).toHaveLength(2);
    expect(work.launches).toHaveLength(1);
    await rotate(f.db);
    await expect(
      filterOperationsStuckWork(f.db, FIX.workspace, NOW, work, access()),
    ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
  });

  it("does not return stale stuck identifiers from composite health hydration", async () => {
    const f = await fixture();
    const db = beforeRead(f.db, /SELECT id FROM runners/, () => rotate(f.db));
    await expect(collectWorkspaceHealth(db, FIX.workspace, NOW, access())).rejects.toMatchObject({
      code: "not_found",
      message: "operations scope not found",
    });
  });
});
