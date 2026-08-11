// ABOUTME: Proves C07 project mutations serialize across two Workerd isolates and one hub.
// ABOUTME: Real D1 retains one winner, immutable versions, events, audits, and idempotency.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like } from "@bfb/db";
import { randomUlid, type CommandOutcome, type ProjectRecord } from "@bfb/domain";
import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.projects.test";
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/projects/wrangler-a.toml" },
    { configPath: "tools/projects/wrangler-b.toml" },
    { configPath: "tools/projects/wrangler-hub.toml" },
  ],
});

interface HubEnv {
  DB: D1Like;
}

function request(
  workspaceId: string,
  humanId: string,
  commandName: string,
  idempotencyKey: string,
  input: unknown,
) {
  return {
    commandName,
    request: {
      workspaceId,
      idempotencyKey,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      now: "2026-08-12T08:00:00Z",
      input,
    },
  };
}

async function execute<TResult>(
  workerName: "bfb-projects-a" | "bfb-projects-b",
  workspaceId: string,
  body: unknown,
): Promise<CommandOutcome<TResult>> {
  const response = await server
    .getWorker(workerName)
    .fetch(`${origin}/workspaces/${workspaceId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as CommandOutcome<TResult>;
}

async function main(): Promise<void> {
  try {
    await server.listen();
    const hubWorker = server.getWorker("bfb-projects-hub");
    await hubWorker.applyD1Migrations("DB");
    const env = (await hubWorker.getEnv()) as unknown as HubEnv;
    const db = adaptD1(env.DB);
    const workspaceId = randomUlid();
    const humanId = randomUlid();
    await db
      .prepare(
        `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version)
         VALUES (?, 'c07-workerd', 'global', ?, 1)`,
      )
      .run(workspaceId, "2026-08-12T08:00:00Z");
    await db
      .prepare(`INSERT INTO humans (id, email, display_name, created_at) VALUES (?, ?, ?, ?) `)
      .run(humanId, "c07@synthetic.test", "C07 Owner", "2026-08-12T08:00:00Z");
    await db
      .prepare(
        `INSERT INTO workspace_members
         (workspace_id, human_id, role, authorization_epoch, created_at)
         VALUES (?, ?, 'owner', 1, ?)`,
      )
      .run(workspaceId, humanId, "2026-08-12T08:00:00Z");
    await db
      .prepare(
        `INSERT INTO workspace_authorization_epochs
         (workspace_id, human_id, authorization_epoch, revoked_at, updated_at)
         VALUES (?, ?, 1, NULL, ?)`,
      )
      .run(workspaceId, humanId, "2026-08-12T08:00:00Z");

    const created = await execute<ProjectRecord>(
      "bfb-projects-a",
      workspaceId,
      request(workspaceId, humanId, "project.create", "c07-workerd-create", {
        name: "C07 Workerd",
        slug: "c07-workerd",
        tint: "#336699",
        accessMode: "restricted",
        repositoryHost: "github.com",
        hostedRepositoryId: "987654321",
        repositorySubpath: "packages/control",
      }),
    );
    assert(created.ok);

    const projectId = created.result.id;
    const projectRacers = await Promise.all([
      execute<ProjectRecord>(
        "bfb-projects-a",
        workspaceId,
        request(workspaceId, humanId, "project.update", "c07-workerd-project-a", {
          projectId,
          expectedVersion: 1,
          tint: "#112233",
        }),
      ),
      execute<ProjectRecord>(
        "bfb-projects-b",
        workspaceId,
        request(workspaceId, humanId, "project.update", "c07-workerd-project-b", {
          projectId,
          expectedVersion: 1,
          tint: "#445566",
        }),
      ),
    ]);
    assert.equal(projectRacers.filter((outcome) => outcome.ok).length, 1);
    assert.equal(
      projectRacers.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version")
        .length,
      1,
    );

    const policyInput = {
      projectId,
      expectedVersion: 1,
      allowedProviders: ["codex"],
      allowAgentRootPropose: false,
      allowPassToAgent: false,
      allowRunOverrides: false,
    };
    const policyRacers = await Promise.all([
      execute(
        "bfb-projects-a",
        workspaceId,
        request(workspaceId, humanId, "project.policy.update", "c07-workerd-policy-a", policyInput),
      ),
      execute(
        "bfb-projects-b",
        workspaceId,
        request(workspaceId, humanId, "project.policy.update", "c07-workerd-policy-b", policyInput),
      ),
    ]);
    assert.equal(policyRacers.filter((outcome) => outcome.ok).length, 1);
    assert.equal(
      policyRacers.filter((outcome) => !outcome.ok && outcome.error.code === "stale_version")
        .length,
      1,
    );

    const committed = (await db
      .prepare(
        `SELECT
           (SELECT resource_version FROM projects WHERE workspace_id = ? AND id = ?) AS project_version,
           (SELECT resource_version FROM project_policies WHERE workspace_id = ? AND project_id = ?) AS policy_version,
           (SELECT COUNT(*) FROM project_policy_versions WHERE workspace_id = ? AND project_id = ?) AS policy_versions,
           (SELECT COUNT(*) FROM semantic_events WHERE workspace_id = ?) AS events,
           (SELECT COUNT(*) FROM audit_events WHERE workspace_id = ?) AS audits,
           (SELECT COUNT(*) FROM idempotency_records WHERE workspace_id = ?) AS idempotency,
           (SELECT cursor FROM workspace_cursors WHERE workspace_id = ?) AS cursor,
           (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS migration_head`,
      )
      .get(
        workspaceId,
        projectId,
        workspaceId,
        projectId,
        workspaceId,
        projectId,
        workspaceId,
        workspaceId,
        workspaceId,
        workspaceId,
      )) as {
      project_version: number;
      policy_version: number;
      policy_versions: number;
      events: number;
      audits: number;
      idempotency: number;
      cursor: number;
      migration_head: string;
    };
    assert.deepEqual(committed, {
      project_version: 2,
      policy_version: 2,
      policy_versions: 2,
      events: 3,
      audits: 3,
      idempotency: 3,
      cursor: 3,
      migration_head: "0011_project_policy_versions.sql",
    });
    await assert.rejects(
      db
        .prepare(
          `UPDATE project_policy_versions SET allowed_providers_json = '["grok"]'
           WHERE workspace_id = ? AND project_id = ? AND version = 1`,
        )
        .run(workspaceId, projectId),
      /immutable/,
    );
    console.log(
      JSON.stringify({
        workers: ["bfb-projects-a", "bfb-projects-b", "bfb-projects-hub"],
        projectRace: projectRacers.map((outcome) =>
          outcome.ok ? "committed" : outcome.error.code,
        ),
        policyRace: policyRacers.map((outcome) => (outcome.ok ? "committed" : outcome.error.code)),
        committed,
      }),
    );
    console.log("C07_D1_OK");
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
