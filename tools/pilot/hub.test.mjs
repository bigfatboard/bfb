// ABOUTME: Exercises explicit pilot jurisdiction routing through the stock Hub in disposable Workerd.
// ABOUTME: Synthetic tenants prove real D1 project effects and retries without real pilot credentials.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { adaptD1, createAuthorizationContext } from "../../packages/db/dist/index.js";
import {
  createProjectCommand,
  listProjectsPage,
  loadPrincipal,
  randomUlid,
} from "../../packages/domain/dist/index.js";
import {
  validateControlEnv,
  workspaceNamespaceForJurisdiction,
} from "../../apps/control-worker/dist/env.js";
import { executeWorkspaceCommand } from "../../apps/control-worker/dist/hub-client.js";

const require = createRequire(new URL("../../apps/control-worker/package.json", import.meta.url));
const { createTestHarness } = require("wrangler");
const root = fileURLToPath(new URL("../../", import.meta.url));

test(
  "local EU project create/retry/read uses the real Hub; default routing still fails closed",
  { timeout: 60_000 },
  async () => {
    const server = createTestHarness({
      root,
      workers: [{ configPath: "tools/projects/wrangler-hub.toml" }],
    });
    try {
      await server.listen();
      const worker = server.getWorker("bfb-projects-hub");
      await worker.applyD1Migrations("DB");
      const env = await worker.getEnv();
      const db = adaptD1(env.DB);
      const workspaceId = randomUlid(),
        humanId = randomUlid();
      const now = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version) VALUES (?, 'pilot-hub-synthetic', 'eu', ?, 1)",
        )
        .run(workspaceId, now);
      await db
        .prepare(
          "INSERT INTO humans (id, email, display_name, created_at) VALUES (?, 'pilot-hub@synthetic.test', 'Synthetic owner', ?)",
        )
        .run(humanId, now);
      await db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, human_id, role, authorization_epoch, created_at) VALUES (?, ?, 'owner', 1, ?)",
        )
        .run(workspaceId, humanId, now);
      await db
        .prepare(
          "INSERT INTO workspace_authorization_epochs (workspace_id, human_id, authorization_epoch, revoked_at, updated_at) VALUES (?, ?, 1, NULL, ?)",
        )
        .run(workspaceId, humanId, now);
      const authorization = createAuthorizationContext({
        workspaceId,
        principalId: humanId,
        authorizationEpoch: 1,
        jurisdiction: "eu",
      });
      const request = {
        workspaceId,
        actorHumanId: humanId,
        authorizationEpoch: 1,
        idempotencyKey: "pilot-real-eu-project",
        now,
        input: {
          name: "Synthetic pilot project",
          slug: "pilot-hub-project",
          tint: "#336699",
          accessMode: "restricted",
          repositoryHost: "github.com",
          hostedRepositoryId: "synthetic-pilot-repository",
          repositorySubpath: ".",
        },
      };

      assert.throws(
        () => env.WORKSPACE_HUB.jurisdiction("eu"),
        /Jurisdiction restrictions are not implemented in workerd/,
      );
      const strict = await executeWorkspaceCommand(
        { db, authorization, workspaceHubNs: env.WORKSPACE_HUB },
        createProjectCommand,
        request,
      );
      assert.deepEqual(strict, {
        ok: false,
        error: { code: "hub_rpc_failed", message: "hub DO call failed" },
      });
      assert.equal(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM projects WHERE workspace_id = ?")
            .get(workspaceId)
        ).n,
        0,
      );

      // Unused resources here satisfy the production binding validator only; the DO and D1 are real.
      const validationInput = {
        ...env,
        ARTIFACTS: {},
        ASSETS: {},
        JOBS: {},
        JOBS_DLQ: {},
        APP_ORIGIN: "https://pilot.synthetic.test",
        ARTIFACT_ORIGIN: "https://artifacts.pilot.synthetic.test",
        LAUNCH_ORIGIN: "https://launch.pilot.synthetic.test",
        JURISDICTION: "eu",
        ENVIRONMENT: "local",
        LOCAL_HUB_JURISDICTION_EMULATION: "true",
      };
      const namespace = validateControlEnv(validationInput).bindings.WORKSPACE_HUB;
      const scopes = ["eu", "us", "global"].map((jurisdiction) =>
        workspaceNamespaceForJurisdiction(namespace, jurisdiction),
      );
      assert.equal(new Set(scopes.map((scope) => String(scope.idFromName(workspaceId)))).size, 3);
      const created = await executeWorkspaceCommand(
        { db, authorization, workspaceHubNs: namespace },
        createProjectCommand,
        request,
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      // Re-normalization simulates a fresh Worker invocation using the same physical namespace.
      const retried = await executeWorkspaceCommand(
        {
          db,
          authorization,
          workspaceHubNs: validateControlEnv(validationInput).bindings.WORKSPACE_HUB,
        },
        createProjectCommand,
        request,
      );
      assert.equal(retried.ok, true, JSON.stringify(retried));
      assert.equal(retried.replayed, true);
      assert.deepEqual(retried.result, created.result);
      const principal = await loadPrincipal(db, workspaceId, humanId);
      const projects = await listProjectsPage(db, principal);
      assert.equal(projects.projects.length, 1);
      assert.equal(projects.projects[0].id, created.result.id);
      assert.equal(
        (
          await db
            .prepare(
              "SELECT COUNT(*) AS n FROM semantic_events WHERE workspace_id = ? AND kind = 'project.create'",
            )
            .get(workspaceId)
        ).n,
        1,
      );
      assert.equal(
        (
          await db
            .prepare("SELECT COUNT(*) AS n FROM idempotency_records WHERE workspace_id = ?")
            .get(workspaceId)
        ).n,
        1,
      );
      console.log("PILOT_LOCAL_EU_REAL_HUB_PROJECT_RETRY_READ_OK");
    } finally {
      await server.close();
    }
  },
);
