// ABOUTME: Proves C04 public limits in two real Workerd isolates sharing one D1 database.
// ABOUTME: Bootstrap, invitation, role, and removal attempts retain only hashed dimensions.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestHarness } from "wrangler";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "https://bfb.workspace-authorization.test";
const server = createTestHarness({
  root: repoRoot,
  workers: [
    { configPath: "tools/workspace-authorization/wrangler-a.toml" },
    { configPath: "tools/workspace-authorization/wrangler-b.toml" },
  ],
});

interface WorkspaceAuthorizationEnv {
  DB: {
    prepare(sql: string): {
      first(): Promise<unknown>;
    };
  };
}

interface Surface {
  path: string;
  method: "GET" | "POST" | "DELETE";
  body: unknown;
}

function worker(index: number) {
  return server.getWorker(
    index % 2 === 0 ? "bfb-workspace-authorization-a" : "bfb-workspace-authorization-b",
  );
}

async function exerciseSurface(surface: Surface, ip: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1) {
    const headers = {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": ip,
    };
    const response =
      surface.method === "GET"
        ? await worker(index).fetch(origin + surface.path, { method: "GET", headers })
        : await worker(index).fetch(origin + surface.path, {
            method: surface.method,
            headers,
            body: JSON.stringify(surface.body),
          });
    statuses.push(response.status);
    const body = (await response.json()) as { error?: string; message?: string };
    assert.deepEqual(body, { error: "request_rejected", message: "request rejected" });
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(403));
  assert.equal(statuses[10], 429);
  return statuses;
}

async function main(): Promise<void> {
  try {
    await server.listen();
    const workerA = server.getWorker("bfb-workspace-authorization-a");
    const workerB = server.getWorker("bfb-workspace-authorization-b");
    await workerA.applyD1Migrations("DB");
    for (const selected of [workerA, workerB]) {
      const health = await selected.fetch(origin + "/healthz");
      assert.equal(health.status, 200, await health.clone().text());
    }

    const workspaceId = "01K2E2N5T8WORKSPACEAUTH00";
    const invitationId = "01K2E2N5T8INVITATIONC040";
    const humanId = "01K2E2N5T8MEMBERC04TEST0";
    const rawSecret = "raw-workspace-capability-c04";
    const surfaces: Surface[] = [
      { path: "/api/v1/workspace-access/bootstrap/start", method: "POST", body: {} },
      {
        path: `/api/v1/workspace-access/bootstrap/reauth?flow_id=${invitationId}`,
        method: "GET",
        body: null,
      },
      {
        path: "/api/v1/workspace-access/bootstrap/complete",
        method: "POST",
        body: { flow_id: rawSecret, bootstrap_secret: rawSecret, slug: "c04" },
      },
      {
        path: `/api/v1/workspace-access/workspaces/${workspaceId}/invitations`,
        method: "POST",
        body: { request_id: rawSecret, email: "c04@synthetic.test", role: "member" },
      },
      {
        path: `/api/v1/workspace-access/workspaces/${workspaceId}/invitations/${invitationId}/accept`,
        method: "POST",
        body: { secret: rawSecret },
      },
      {
        path: `/api/v1/workspace-access/workspaces/${workspaceId}/members/${humanId}/role`,
        method: "POST",
        body: { request_id: rawSecret, role: "reviewer" },
      },
      {
        path: `/api/v1/workspace-access/workspaces/${workspaceId}/members/${humanId}`,
        method: "DELETE",
        body: { request_id: rawSecret },
      },
    ];
    const results: Record<string, number[]> = {};
    for (const [index, surface] of surfaces.entries()) {
      results[`${surface.method}:${surface.path}`] = await exerciseSurface(
        surface,
        `192.0.2.${140 + index}`,
      );
    }

    const env = (await workerA.getEnv()) as unknown as WorkspaceAuthorizationEnv;
    const stored = (await env.DB.prepare(
      `SELECT COUNT(*) AS buckets, GROUP_CONCAT(bucket_key, ',') AS bucket_keys
       FROM rate_limit_buckets`,
    ).first()) as { buckets: number; bucket_keys: string } | null;
    assert(stored);
    assert.equal(stored.buckets, surfaces.length);
    for (const raw of ["192.0.2.", rawSecret, workspaceId, invitationId, humanId, "/api/"]) {
      assert(!stored.bucket_keys.includes(raw));
    }
    assert.match(
      stored.bucket_keys,
      new RegExp(`^[0-9a-f]{64}(,[0-9a-f]{64}){${surfaces.length - 1}}$`),
    );

    console.log(
      JSON.stringify({
        workers: ["bfb-workspace-authorization-a", "bfb-workspace-authorization-b"],
        abuseBuckets: stored.buckets,
        surfaces: results,
      }),
    );
    console.log("C04_D1_OK");
  } catch (error) {
    server.debug();
    throw error;
  } finally {
    await server.close();
  }
}

await main();
