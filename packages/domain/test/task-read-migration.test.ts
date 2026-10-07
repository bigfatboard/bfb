// ABOUTME: Verifies shared-only historical task reads and fail-closed privacy schema transitions.
// ABOUTME: Simulated interleavings ensure migration during a legacy read cannot return newly private content.

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { getTask } from "../src/work-commands.js";
import { seedHistoricalTask } from "./historical-task-fixture.js";

const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
const now = "2026-10-06T12:00:00.000Z";

async function historicalFixture() {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, directory, { stopBeforeId: "0045_private_task_authority" });
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db);
  const task = await seedHistoricalTask(db, {
    workspaceId: FIX.workspace,
    projectId: FIX.projectA,
    humanId: FIX.member,
    title: "Synthetic historical task",
    now,
  });
  const makePrivate = () => {
    applyMigrationsForVerification(raw, directory);
    raw
      .prepare(
        `INSERT INTO task_privacy (workspace_id, task_id, owner_human_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, task.id, FIX.member, now);
  };
  return { raw, db, taskId: task.id, makePrivate };
}

it("reads shared historical rows but never caches schema absence across migration", async () => {
  const f = await historicalFixture();
  try {
    expect(await getTask(f.db, FIX.workspace, f.taskId)).toMatchObject({ id: f.taskId });
    f.makePrivate();
    expect(await getTask(f.db, FIX.workspace, f.taskId)).toBeUndefined();
    expect(
      await getTask(f.db, FIX.workspace, f.taskId, {
        workspaceId: FIX.workspace,
        humanId: FIX.member,
        authorizationEpoch: 1,
      }),
    ).toMatchObject({ id: f.taskId });
  } finally {
    f.raw.close();
  }
});

it("never falls back for explicit human authority on unsupported historical schemas", async () => {
  const f = await historicalFixture();
  try {
    await expect(
      getTask(f.db, FIX.workspace, f.taskId, {
        workspaceId: FIX.workspace,
        humanId: FIX.owner,
        authorizationEpoch: 1,
      }),
    ).rejects.toThrow(/no such table/);
  } finally {
    f.raw.close();
  }
});

for (const point of ["before_legacy_read", "after_legacy_read"] as const) {
  it(`discards a legacy result when migration lands ${point}`, async () => {
    const f = await historicalFixture();
    let migrated = false;
    const interleaved: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...params) {
            const row = await statement.get(...params);
            const isCatalog = sql.includes("FROM sqlite_master");
            const isLegacy = sql.includes("task.parent_task_id, task.title");
            if (!migrated && (point === "before_legacy_read" ? isCatalog : isLegacy)) {
              f.makePrivate();
              migrated = true;
            }
            return row;
          },
        };
      },
    };
    try {
      expect(await getTask(interleaved, FIX.workspace, f.taskId)).toBeUndefined();
      expect(migrated).toBe(true);
    } finally {
      f.raw.close();
    }
  });
}
