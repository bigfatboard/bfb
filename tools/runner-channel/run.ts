// ABOUTME: Runs the signed native runner against actual local Worker, D1 and WorkspaceHub transports.
// ABOUTME: Seeds only synthetic identities and gives Go acceptance a disposable network endpoint.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, type D1Like } from "@bfb/db";
import { FIX, randomUlid, seedSyntheticWorkspace } from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const server = createTestHarness({
  root,
  workers: [{ configPath: "tools/runner-channel/wrangler.toml" }],
});
const key = "l08-synthetic-current-signing-key-84d1e9";
const sessionId = "l08-synthetic-session";
const sessionToken = "l08-synthetic-session-token";
const cookie = `__Host-bfb_session=${encodeURIComponent(`${sessionToken}.${createHmac("sha256", key).update(sessionToken).digest("base64")}`)}`;
const csrf = `2.${createHmac("sha256", key).update(`bfb-csrf:${sessionId}`).digest("hex")}`;

try {
  const { url } = await server.listen();
  const worker = server.getWorker();
  await worker.applyD1Migrations("DB");
  const env = (await worker.getEnv()) as unknown as { DB: D1Like };
  const db = adaptD1(env.DB);
  const now = new Date().toISOString();
  await seedSyntheticWorkspace(db, now, "global");
  const workspaceB = randomUlid();
  const projectB = randomUlid();
  await db
    .prepare(
      `INSERT INTO workspaces (id, slug, jurisdiction, created_at, resource_version) VALUES (?, 'channel-b', 'global', ?, 1)`,
    )
    .run(workspaceB, now);
  await db
    .prepare(
      `INSERT INTO workspace_members (workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'owner',1,?)`,
    )
    .run(workspaceB, FIX.owner, now);
  await db
    .prepare(
      `INSERT INTO workspace_authorization_epochs (workspace_id,human_id,authorization_epoch,revoked_at,updated_at) VALUES (?,?,1,NULL,?)`,
    )
    .run(workspaceB, FIX.owner, now);
  await db
    .prepare(
      `INSERT INTO projects (workspace_id,id,name,slug,tint,resource_version,created_at) VALUES (?,?,'Synthetic B','channel-b','#3B82F6',1,?)`,
    )
    .run(workspaceB, projectB, now);
  await db
    .prepare(`INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)`)
    .run(workspaceB, projectB, FIX.owner);
  await db
    .prepare(
      `INSERT INTO better_auth_users (id,name,email,email_verified,created_at,updated_at) VALUES ('l08-user','Synthetic Channel Owner','owner@synthetic.test',1,?,?)`,
    )
    .run(now, now);
  await db
    .prepare(`UPDATE humans SET better_auth_user_id = 'l08-user' WHERE id = ?`)
    .run(FIX.owner);
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,user_id) VALUES (?, '2027-09-12T00:00:00.000Z', ?, ?, ?, 'l08-user')`,
    )
    .run(sessionId, sessionToken, now, now);
  // A test-only HTTP callback permits deterministic hibernation without placing
  // an eviction endpoint in a deployed Worker. The child signals via stdout.
  const child = spawn(
    "go",
    ["test", "-race", "-count=1", "-v", "./internal/runner", "-run", "TestNativeWorkerChannel"],
    {
      cwd: root,
      env: {
        ...process.env,
        BFB_CHANNEL_TEST_URL: url.href,
        BFB_CHANNEL_TEST_WORKSPACE_A: FIX.workspace,
        BFB_CHANNEL_TEST_WORKSPACE_B: workspaceB,
        BFB_CHANNEL_TEST_PROJECT_A: FIX.projectA,
        BFB_CHANNEL_TEST_PROJECT_B: projectB,
        BFB_CHANNEL_TEST_PROJECT_DENIED: FIX.projectB,
        BFB_CHANNEL_TEST_COOKIE: cookie,
        BFB_CHANNEL_TEST_CSRF: csrf,
        BFB_CHANNEL_TEST_OWNER: FIX.owner,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let buffer = "";
  let eviction: Promise<void> | null = null;
  child.stdout.on("data", (data: Buffer) => {
    process.stdout.write(data);
    buffer += data.toString();
    if (!eviction && buffer.includes("L08_HIBERNATE_SYNTHETIC_WORKSPACE")) {
      eviction = worker.evictDurableObject("WorkspaceHub", {
        name: FIX.workspace,
        webSockets: "hibernate",
      });
    }
    buffer = buffer.slice(-1024);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (eviction) await eviction;
  assert.equal(code, 0, "native Worker channel acceptance failed");
  assert.ok(eviction, "hibernation fixture was not exercised");
  console.log("L08 native/Worker channel acceptance passed");
} finally {
  await server.close();
}
