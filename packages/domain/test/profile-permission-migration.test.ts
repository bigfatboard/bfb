// ABOUTME: Proves the permission-mode migration preserves historical profile and snapshot contents.
// ABOUTME: Checks manual defaults, SQL combination constraints and immutable version history.

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { adaptBetterSqlite3, applyMigrationsForVerification } from "@bfb/db";
import { expect, it } from "vitest";
import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";

it("adds manual defaults at 0044 without rewriting populated history or snapshot hashes", async () => {
  const raw = new Database(":memory:");
  try {
    raw.pragma("foreign_keys = ON");
    const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
    expect(
      applyMigrationsForVerification(raw, directory, {
        stopBeforeId: "0044_agent_profile_permissions",
      }).head,
    ).toBe("0043_agent_artifact_publications");
    const db = adaptBetterSqlite3(raw);
    await seedSyntheticWorkspace(db);
    const hub = new WorkspaceHub(db);
    async function human<I, R>(command: HubCommand<I, R>, input: I): Promise<R> {
      const result = await hub.execute(command, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: command.name,
        now: "2026-10-06T00:00:00.000Z",
        input,
      });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) throw Error(result.error.code);
      return result.result;
    }
    const task = await human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic historical manual task",
      priority: "P2",
    });
    await human(createRunCommand, {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    });
    const tables = ["agent_profiles", "agent_profile_versions"];
    const prior = tables.map((table) => ({
      table,
      columns: (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (column) => column.name,
      ),
      rows: raw.prepare(`SELECT * FROM ${table}`).all(),
    }));
    const snapshots = raw.prepare("SELECT * FROM run_configuration_snapshots").all();
    expect(
      applyMigrationsForVerification(raw, directory, {
        stopBeforeId: "0045_private_task_authority",
      }).head,
    ).toBe("0044_agent_profile_permissions");
    for (const { table, columns, rows } of prior) {
      expect(raw.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()).toEqual(rows);
      expect(raw.prepare(`SELECT DISTINCT permission_mode FROM ${table}`).all()).toEqual([
        { permission_mode: "manual" },
      ]);
    }
    expect(raw.prepare("SELECT * FROM run_configuration_snapshots").all()).toEqual(snapshots);
    expect(() =>
      raw
        .prepare("UPDATE agent_profiles SET permission_mode = 'autonomous' WHERE id = ?")
        .run(FIX.profileCodex),
    ).toThrow(/CHECK/);
    expect(() =>
      raw
        .prepare("UPDATE agent_profiles SET permission_mode = 'unknown' WHERE id = ?")
        .run(FIX.profileCodex),
    ).toThrow(/CHECK/);
    expect(() =>
      raw.prepare("UPDATE agent_profile_versions SET permission_mode = 'manual'").run(),
    ).toThrow(/immutable/);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
  } finally {
    raw.close();
  }
});
