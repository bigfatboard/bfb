// ABOUTME: Proves offline policy defaults preserve historical configuration and snapshot bytes.
// ABOUTME: Exercises the immediate previous-head upgrade, fresh schema and bounded SQL columns.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { adaptBetterSqlite3, applyMigrationsForVerification, schemaSnapshot } from "@bfb/db";
import { afterEach, describe, expect, it } from "vitest";

import { FIX, seedSyntheticWorkspace } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { createProjectCommand, getProjectPolicy } from "../src/projects.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";

const directory = fileURLToPath(new URL("../../../migrations/d1", import.meta.url));
const head = "0039_offline_agent_policy";
const tables = [
  "workspace_policies",
  "workspace_policy_versions",
  "project_policies",
  "project_policy_versions",
  "repository_configs",
  "repository_config_versions",
] as const;
const rawDatabases: Database.Database[] = [];

function database(previous = false) {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  rawDatabases.push(raw);
  const migrated = applyMigrationsForVerification(
    raw,
    directory,
    previous ? { stopBeforeId: head } : {},
  );
  expect(migrated.head).toBe(previous ? "0038_agent_work_authority" : head);
  return raw;
}

afterEach(() => {
  for (const raw of rawDatabases.splice(0)) raw.close();
});

function ordinaryColumns(raw: Database.Database, table: string) {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((row) => row.name)
    .filter((name) => !name.startsWith("offline_agent_"));
}

describe("offline policy migration", () => {
  it("preserves populated 0038 rows and immutable snapshot hashes while denying every historical policy", async () => {
    const raw = database(true),
      db = adaptBetterSqlite3(raw),
      hub = new WorkspaceHub(db);
    await seedSyntheticWorkspace(db);
    async function human<I, R>(command: HubCommand<I, R>, input: I): Promise<R> {
      const result = await hub.execute(command, {
        workspaceId: FIX.workspace,
        idempotencyKey: `offline-migration-${command.name}`,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        now: "2026-10-06T00:00:00.000Z",
        input,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) throw Error(result.error.code);
      return result.result;
    }
    const task = await human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic historical run",
      priority: "P2",
    });
    const run = await human(createRunCommand, {
      taskId: task.id,
      expectedTaskVersion: 1,
      agentProfileId: FIX.profileCodex,
      workspacePolicyVersion: 1,
      projectPolicyVersion: 1,
      repositoryConfigVersion: 1,
      agentProfileVersion: 1,
    });
    const before = tables.map((table) => ({
      table,
      columns: ordinaryColumns(raw, table),
      rows: raw.prepare(`SELECT * FROM ${table}`).all(),
    }));
    const snapshots = raw.prepare("SELECT * FROM run_configuration_snapshots").all();
    expect(run.snapshot.contentHash).toBe(
      `sha256:${createHash("sha256").update(run.snapshot.canonicalJson).digest("hex")}`,
    );
    expect(applyMigrationsForVerification(raw, directory).head).toBe(head);
    for (const { table, columns, rows } of before) {
      expect(raw.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()).toEqual(rows);
      for (const permission of raw
        .prepare(
          `SELECT offline_agent_tools_json, offline_agent_max_pending_age_seconds FROM ${table}`,
        )
        .all()) {
        expect(permission).toEqual({
          offline_agent_tools_json: "[]",
          offline_agent_max_pending_age_seconds: 0,
        });
      }
    }
    expect(raw.prepare("SELECT * FROM run_configuration_snapshots").all()).toEqual(snapshots);
    expect(schemaSnapshot(raw)).toEqual(schemaSnapshot(database()));
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    for (const table of tables.filter((table) => table.endsWith("versions"))) {
      expect(() =>
        raw.prepare(`UPDATE ${table} SET offline_agent_max_pending_age_seconds = 1`).run(),
      ).toThrow(/immutable/);
    }
  });

  it("keeps new projects denied even when their workspace permits offline work", async () => {
    const raw = database(),
      db = adaptBetterSqlite3(raw);
    await seedSyntheticWorkspace(db);
    raw
      .prepare(
        "UPDATE workspace_policies SET offline_agent_tools_json = '[\"bfb_add_comment\"]', offline_agent_max_pending_age_seconds = 300",
      )
      .run();
    const result = await new WorkspaceHub(db).execute(createProjectCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "offline-new-project",
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      input: {
        name: "Synthetic denied project",
        slug: "offline-denied",
        tint: "#AABBCC",
        accessMode: "restricted",
        repositoryHost: "github.com",
        hostedRepositoryId: "offline-denied",
        repositorySubpath: ".",
      },
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw Error(result.error.code);
    expect((await getProjectPolicy(db, FIX.workspace, result.result.id)).offlineAgentWork).toEqual({
      allowed_tools: [],
      max_pending_age_seconds: 0,
    });
    for (const table of [
      "project_policy_versions",
      "repository_configs",
      "repository_config_versions",
    ]) {
      expect(
        raw
          .prepare(
            `SELECT offline_agent_tools_json, offline_agent_max_pending_age_seconds FROM ${table} WHERE project_id = ?`,
          )
          .get(result.result.id),
      ).toEqual({ offline_agent_tools_json: "[]", offline_agent_max_pending_age_seconds: 0 });
    }
    expect(
      raw
        .prepare("SELECT canonical_json, content_hash FROM repository_configs WHERE project_id = ?")
        .get(result.result.id),
    ).toEqual({
      canonical_json: "{}",
      content_hash: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    });
  });

  it("rejects malformed arrays and inconsistent SQL age bounds", async () => {
    const raw = database();
    await seedSyntheticWorkspace(adaptBetterSqlite3(raw));
    for (const table of ["workspace_policies", "project_policies", "repository_configs"]) {
      for (const [tools, age] of [
        ["{}", 0],
        ["[]", 1],
        ['["bfb_add_comment"]', 0],
        ['["bfb_add_comment"]', 301],
        ['["bfb_add_comment"]', 1.5],
      ]) {
        expect(() =>
          raw
            .prepare(
              `UPDATE ${table} SET offline_agent_tools_json = ?, offline_agent_max_pending_age_seconds = ?`,
            )
            .run(tools, age),
        ).toThrow();
      }
    }
  });
});
