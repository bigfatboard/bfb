// ABOUTME: Proves populated 0039 upgrades retain immutable policy and snapshot bytes.
// ABOUTME: Checks independent result deny defaults and strict relational age constraints.

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { adaptBetterSqlite3, applyMigrationsForVerification, schemaSnapshot } from "@bfb/db";
import { describe, expect, it } from "vitest";
import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { createRunCommand } from "../src/work-records.js";
import { seedHistoricalTask } from "./historical-task-fixture.js";

const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
const head = "0040_offline_result_policy";
const tables = [
  "workspace_policies",
  "workspace_policy_versions",
  "project_policies",
  "project_policy_versions",
  "repository_configs",
  "repository_config_versions",
];
describe("offline result migration", () => {
  it("upgrades populated immediate predecessor without rewriting history", async () => {
    const raw = new Database(":memory:"),
      fresh = new Database(":memory:");
    try {
      raw.pragma("foreign_keys=ON");
      fresh.pragma("foreign_keys=ON");
      expect(applyMigrationsForVerification(raw, directory, { stopBeforeId: head }).head).toBe(
        "0039_offline_agent_policy",
      );
      const db = adaptBetterSqlite3(raw);
      await seedSyntheticWorkspace(db);
      const hub = new WorkspaceHub(db);
      const task = await seedHistoricalTask(db, {
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        humanId: FIX.owner,
        title: "Synthetic historical task",
        now: "2026-10-06T00:00:00.000Z",
      });
      const run = await hub.execute(createRunCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: "result-migration-run",
        input: {
          taskId: task.id,
          expectedTaskVersion: 1,
          agentProfileId: FIX.profileCodex,
          workspacePolicyVersion: 1,
          projectPolicyVersion: 1,
          repositoryConfigVersion: 1,
          agentProfileVersion: 1,
        },
      });
      expect(run.ok).toBe(true);
      const before = tables.map((table) => ({
        table,
        rows: raw.prepare(`SELECT * FROM ${table}`).all(),
        columns: (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      }));
      const snapshots = raw.prepare("SELECT * FROM run_configuration_snapshots").all();
      expect(
        applyMigrationsForVerification(raw, directory, {
          stopBeforeId: "0041_measurement_sources",
        }).head,
      ).toBe(head);
      for (const { table, rows, columns } of before) {
        expect(raw.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()).toEqual(rows);
        expect(
          raw
            .prepare(
              `SELECT offline_result_allow_submit AS allow,offline_result_max_pending_age_seconds AS age FROM ${table}`,
            )
            .all(),
        ).toEqual(rows.map(() => ({ allow: 0, age: 0 })));
      }
      expect(raw.prepare("SELECT * FROM run_configuration_snapshots").all()).toEqual(snapshots);
      applyMigrationsForVerification(fresh, directory, {
        stopBeforeId: "0041_measurement_sources",
      });
      expect(schemaSnapshot(raw)).toEqual(schemaSnapshot(fresh));
      expect(raw.pragma("foreign_key_check")).toEqual([]);
      for (const table of tables.filter((table) => table.endsWith("versions")))
        expect(() =>
          raw
            .prepare(
              `UPDATE ${table} SET offline_result_allow_submit=1,offline_result_max_pending_age_seconds=1`,
            )
            .run(),
        ).toThrow(/immutable/);
      for (const [allow, age] of [
        [0, 1],
        [1, 0],
        [1, 301],
        [2, 1],
        [1, 1.5],
      ])
        expect(() =>
          raw
            .prepare(
              "UPDATE workspace_policies SET offline_result_allow_submit=?,offline_result_max_pending_age_seconds=?",
            )
            .run(allow, age),
        ).toThrow();
      raw
        .prepare(
          "UPDATE workspace_policies SET offline_result_allow_submit=1,offline_result_max_pending_age_seconds=300",
        )
        .run();
    } finally {
      raw.close();
      fresh.close();
    }
  });
});
