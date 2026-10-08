// ABOUTME: Proves bounded private artifact uploads and views against disposable native Workers, D1 and R2.
// ABOUTME: Genuine synthetic browser sessions and witnessed authority loss retain history without live execution.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  ARTIFACT_GRANT_TTL_MS,
  VIEW_GRANT_TTL_MS,
  artifactObjectKey,
  FIX,
  mintUploadGrantSecret,
  mintViewGrantSecret,
  mintViewNonce,
  randomUlid,
  seedSyntheticWorkspace,
  type TaskRecord,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { canonicalSnapshot, type ArtifactPrivacyEffects } from "./artifact.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appOrigin = "https://bfb.artifact-privacy.test",
  artifactOrigin = "https://artifacts.artifact-privacy.test";
const now = new Date(Math.floor(Date.now() / 1_000) * 1_000).toISOString();
const signing = "c11-artifact-privacy-synthetic-signing-key-ec682c";
const controlName = "c11-privacy-control",
  hubName = "c11-privacy-hub",
  bytesName = "c11-privacy-bytes";
const namespace = { name: "WORKSPACE_HUB", class_name: "WorkspaceHub" };
const vars = {
  ENVIRONMENT: "local",
  ARTIFACT_VIEWER_ENABLED: "true",
  APP_ORIGIN: appOrigin,
  ARTIFACT_ORIGIN: artifactOrigin,
};
const database = {
  binding: "DB",
  database_name: "bfb-c11-artifact-privacy",
  database_id: "00000000-0000-4000-8000-000000000311",
  migrations_dir: resolve(root, "migrations/d1"),
};
const base = {
  compatibility_date: "2026-08-08",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [database],
};
const r2 = [{ binding: "ARTIFACTS", bucket_name: "bfb-c11-artifact-privacy" }];
const server = createTestHarness({
  root,
  workers: [
    {
      config: {
        ...base,
        name: controlName,
        main: resolve(root, "tools/artifact-viewer/control.ts"),
        vars: {
          ...vars,
          JURISDICTION: "global",
          LAUNCH_ORIGIN: "https://launch.artifact-privacy.test",
          BETTER_AUTH_SECRETS: `2:${signing},1:c11-artifact-privacy-previous-synthetic-signing-key`,
          GITHUB_CLIENT_ID: "c11-synthetic-github-client",
          GITHUB_CLIENT_SECRET: "c11-synthetic-github-secret",
          AUTH_ABUSE_SECRET: "c11-artifact-privacy-synthetic-auth-abuse-key-ec682c",
        },
        r2_buckets: r2,
        queues: {
          producers: [
            { binding: "JOBS", queue: "c11-artifact-privacy-jobs" },
            { binding: "JOBS_DLQ", queue: "c11-artifact-privacy-dlq" },
          ],
        },
        // Control validation requires a Fetcher, but API-only proof never requests assets.
        services: [{ binding: "ASSETS", service: bytesName }],
        durable_objects: {
          bindings: [{ ...namespace, script_name: hubName }],
        },
      },
    },
    {
      config: {
        ...base,
        name: hubName,
        main: resolve(root, "apps/control-worker/src/index.ts"),
        durable_objects: { bindings: [namespace] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
    {
      config: {
        ...base,
        name: bytesName,
        main: resolve(root, "tools/artifact-privacy/artifact.ts"),
        vars: {
          ...vars,
          UPLOAD_ABUSE_SECRET: "c11-artifact-privacy-synthetic-upload-abuse-key-ec682c",
        },
        r2_buckets: r2,
      },
    },
  ],
});
const bounds = { maximum_bindings: 0, maximum_statement_bytes: 0, maximum_batch_statements: 0 };
const checks: Array<{ check: string; outcome: "passed" | "failed" }> = [];
const failures: Array<{ check: string; phase: string; error_name: string }> = [];
async function check(name: string, operation: (phase: (name: string) => void) => Promise<void>) {
  let phase = "fixture";
  try {
    await operation((name) => {
      phase = name;
    });
    checks.push({ check: name, outcome: "passed" });
  } catch (error) {
    checks.push({ check: name, outcome: "failed" });
    failures.push({
      check: name,
      phase,
      error_name: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
type Session = { cookie: string; csrf: string };
function session(human: "owner" | "member" | "reviewer"): Session {
  const id = `c11-artifact-privacy-${human}-session`,
    token = `c11-artifact-privacy-${human}-synthetic-token`;
  return {
    cookie: `__Host-bfb_session=${encodeURIComponent(`${token}.${createHmac("sha256", signing).update(token).digest("base64")}`)}`,
    csrf: `2.${createHmac("sha256", signing).update(`bfb-csrf:${id}`).digest("hex")}`,
  };
}
const owner = session("owner"),
  member = session("member"),
  reviewer = session("reviewer");
let address = 30;
const ip = () => `192.0.2.${address++}`;
function browser(path: string, body: unknown, auth = owner) {
  return server.getWorker(controlName).fetch(appOrigin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip(),
      "x-v02-test-time": now,
      cookie: auth.cookie,
      origin: appOrigin,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": auth.csrf,
    },
    body: JSON.stringify(body),
  });
}
const workspacePath = `/api/v1/workspaces/${FIX.workspace}`;
type Publication = {
  artifact_id: string;
  version_id: string;
  upload_grant: { grant_id: string; secret: string };
};
type View = { view_id: string; secret: string; nonce: string };
type Fixture = { runId: string; taskId: string; taskGrantId: string | null };
type Probe = {
  scope: string;
  seam?: "before" | "get" | "body" | "put" | "receipt";
  taskGrantId?: string;
  versionId?: string;
  projectAccessLoss?: boolean;
  expiryMode?: "live" | "expired";
};
type NativeResponse = Awaited<ReturnType<typeof server.fetch>>;
function probeHeaders(probe?: Probe): Record<string, string> {
  return probe
    ? {
        "x-c11-scope": probe.scope,
        ...(probe.seam ? { "x-c11-seam": probe.seam } : {}),
        ...(probe.taskGrantId ? { "x-c11-task-grant": probe.taskGrantId } : {}),
        ...(probe.versionId ? { "x-c11-version": probe.versionId } : {}),
        ...(probe.projectAccessLoss ? { "x-c11-project-access-loss": "1" } : {}),
        ...(probe.expiryMode ? { "x-c11-expiry-mode": probe.expiryMode } : {}),
      }
    : {};
}
function upload(publication: Publication, bytes: Uint8Array, probe?: Probe) {
  return server
    .getWorker(bytesName)
    .fetch(`${artifactOrigin}/upload/${publication.upload_grant.grant_id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${publication.upload_grant.secret}`,
        "cf-connecting-ip": ip(),
        "x-v02-test-time": now,
        ...probeHeaders(probe),
      },
      body: bytes as unknown as never,
    });
}
function redeem(view: View, probe?: Probe) {
  return server.getWorker(bytesName).fetch(`${artifactOrigin}/view/${view.view_id}/redeem`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip(),
      "x-v02-test-time": now,
      ...probeHeaders(probe),
    },
    body: new URLSearchParams({ view_secret: view.secret, view_nonce: view.nonce }).toString(),
  });
}
async function denied(response: NativeResponse, status = 403) {
  assert.equal(response.status, status);
  assert.deepEqual(
    await response.json(),
    status === 409
      ? { error: "upload_conflict" }
      : { error: "request_rejected", message: "request rejected" },
  );
  assert(response.headers.get("cache-control")?.includes("no-store"));
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("set-cookie"), null);
}
function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function body(label: string) {
  return new TextEncoder().encode(
    `<!doctype html><html><body>SYNTHETIC_PRIVATE_ARTIFACT_${label}</body></html>`,
  );
}

try {
  await server.listen();
  const control = server.getWorker(controlName);
  await control.applyD1Migrations("DB");
  const binding = ((await control.getEnv()) as unknown as { DB: D1Like }).DB;
  const db = adaptD1(binding);
  const bucket = (
    (await server.getWorker(bytesName).getEnv()) as unknown as {
      ARTIFACTS: R2Bucket;
    }
  ).ARTIFACTS;
  await seedSyntheticWorkspace(db, now, "global");
  for (const [name, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const userId = `c11-artifact-privacy-${name}-user`,
      id = `c11-artifact-privacy-${name}-session`;
    await db
      .prepare(
        "INSERT INTO better_auth_users (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)",
      )
      .run(userId, `Synthetic ${name}`, `${name}@artifact-privacy.synthetic.test`, now, now);
    await db.prepare("UPDATE humans SET better_auth_user_id=? WHERE id=?").run(userId, humanId);
    await db
      .prepare(
        "INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        new Date(Date.parse(now) + 365 * 86_400_000).toISOString(),
        `c11-artifact-privacy-${name}-synthetic-token`,
        now,
        now,
        userId,
      );
  }
  const snapshot = () => canonicalSnapshot(binding);
  async function fk() {
    assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  }
  async function fixture(
    permission: "read" | "contribute" | "none" | "shared",
    granteeHumanId: string = FIX.owner,
  ): Promise<Fixture> {
    const taskResponse = await browser(
      `${workspacePath}/tasks`,
      {
        project_id: FIX.projectA,
        title: "Synthetic artifact privacy parent",
        priority: "P2",
        request_id: randomUlid(),
      },
      member,
    );
    assert.equal(taskResponse.status, 200);
    const task = (await taskResponse.json()) as { ok: boolean; result: TaskRecord };
    assert.equal(task.ok, true);
    const runResponse = await browser(
      `${workspacePath}/tasks/${task.result.id}/runs`,
      {
        expected_task_version: task.result.resource_version,
        agent_profile_id: FIX.profileCodex,
        workspace_policy_version: 1,
        project_policy_version: 1,
        repository_config_version: 1,
        agent_profile_version: 1,
        request_id: randomUlid(),
      },
      member,
    );
    assert.equal(runResponse.status, 200);
    const created = (await runResponse.json()) as { ok: boolean; result: { run: { id: string } } };
    assert.equal(created.ok, true);
    let taskGrantId: string | null = null;
    if (permission !== "shared") {
      // Dormant fixture policy does not expose private creation or sharing in the product.
      await db
        .prepare(
          "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
        )
        .run(FIX.workspace, task.result.id, FIX.member, now);
      if (permission !== "none") {
        taskGrantId = randomUlid();
        await db
          .prepare(
            `INSERT INTO task_human_grants
          (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)`,
          )
          .run(FIX.workspace, taskGrantId, task.result.id, granteeHumanId, permission, now);
      }
    }
    await fk();
    return { taskId: task.result.id, runId: created.result.run.id, taskGrantId };
  }
  async function create(bytes: Uint8Array, runId: string | null, auth = owner) {
    const response = await browser(
      `${workspacePath}/artifacts`,
      {
        run_id: runId,
        format: "html",
        role: "review",
        declared_size: bytes.length,
        expected_digest: digest(bytes),
      },
      auth,
    );
    assert.equal(response.status, 201);
    return (await response.json()) as Publication;
  }
  async function finalize(publication: Publication, bytes: Uint8Array, auth = owner) {
    const response = await browser(
      `${workspacePath}/artifacts/${publication.version_id}/finalize`,
      { content_hash: digest(bytes), size: bytes.length },
      auth,
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { state: string }).state, "available");
  }
  async function view(publication: Publication, auth = owner) {
    const response = await browser(
      `${workspacePath}/artifacts/${publication.version_id}/views`,
      {},
      auth,
    );
    assert.equal(response.status, 201);
    return (await response.json()) as View;
  }
  async function observations(probe: Probe) {
    const response = await server
      .getWorker(bytesName)
      .fetch(`${artifactOrigin}/__c11/effects/${probe.scope}`);
    assert.equal(response.status, 200);
    const value = (await response.json()) as ArtifactPrivacyEffects;
    assert(value && value.fk_clean);
    bounds.maximum_bindings = Math.max(bounds.maximum_bindings, value.maximum_bindings);
    bounds.maximum_statement_bytes = Math.max(
      bounds.maximum_statement_bytes,
      value.maximum_statement_bytes,
    );
    bounds.maximum_batch_statements = Math.max(
      bounds.maximum_batch_statements,
      value.maximum_batch_statements,
    );
    assert(bounds.maximum_bindings <= 100 && bounds.maximum_statement_bytes <= 100_000);
    if (probe.seam) {
      assert(value.revoked && value.canonical_unchanged);
      assert.equal(value.project_access_removed, probe.projectAccessLoss === true);
      assert.deepEqual(
        await db
          .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, probe.taskGrantId),
        { revoked_at: probe.projectAccessLoss ? null : now },
      );
    }
    return value;
  }
  async function publicationFacts(
    publication: Publication,
    bytes: Uint8Array,
    runId: string | null,
    exists: boolean,
  ) {
    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      runId,
      role: "review",
      versionId: publication.version_id,
      contentHash: digest(bytes),
    });
    for (const table of ["artifact_upload_receipts", "artifact_upload_receipt_sources"])
      assert.equal(
        (
          await db
            .prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND version_id=?`)
            .all(FIX.workspace, publication.version_id)
        ).length,
        exists ? 1 : 0,
      );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT * FROM artifact_audit_outbox WHERE workspace_id=? AND version_id=? AND action='artifact.upload_verified'",
          )
          .all(FIX.workspace, publication.version_id)
      ).length,
      exists ? 1 : 0,
    );
    assert.equal(
      (
        await db
          .prepare("SELECT * FROM artifact_objects WHERE workspace_id=? AND r2_key=?")
          .all(FIX.workspace, key)
      ).length,
      exists ? 1 : 0,
    );
    return key;
  }
  async function assertReplay(call: () => Promise<NativeResponse>) {
    const before = await snapshot();
    await denied(await call());
    assert.deepEqual(await snapshot(), before);
    await fk();
  }
  async function reviewerViewFacts(issued: View, publication: Publication, f: Fixture) {
    assert.deepEqual(
      await db
        .prepare(
          `SELECT view.human_id, view.authorization_epoch, view.consumed_at, task.id AS task_id,
            task.project_id, member.role, task_grant.permission, task_grant.revoked_at
           FROM artifact_view_grants AS view
           JOIN artifact_versions AS version ON version.workspace_id=view.workspace_id AND version.id=view.version_id
           JOIN artifacts AS artifact ON artifact.workspace_id=version.workspace_id AND artifact.id=version.artifact_id
           JOIN runs AS run ON run.workspace_id=artifact.workspace_id AND run.id=artifact.run_id
           JOIN tasks AS task ON task.workspace_id=run.workspace_id AND task.id=run.task_id AND task.project_id=run.project_id
           JOIN workspace_members AS member ON member.workspace_id=view.workspace_id AND member.human_id=view.human_id
           JOIN task_human_grants AS task_grant ON task_grant.workspace_id=task.workspace_id AND task_grant.task_id=task.id
             AND task_grant.human_id=view.human_id AND task_grant.authorization_epoch=view.authorization_epoch
           WHERE view.workspace_id=? AND view.id=? AND view.version_id=? AND task_grant.id=? AND run.id=?`,
        )
        .get(FIX.workspace, issued.view_id, publication.version_id, f.taskGrantId, f.runId),
      {
        human_id: FIX.reviewer,
        authorization_epoch: 1,
        consumed_at: now,
        task_id: f.taskId,
        project_id: FIX.projectA,
        role: "reviewer",
        permission: "read",
        revoked_at: null,
      },
    );
    assert.equal(
      (
        await db
          .prepare(
            "SELECT id FROM artifact_audit_outbox WHERE workspace_id=? AND version_id=? AND grant_id=? AND action='artifact.view_redeemed'",
          )
          .all(FIX.workspace, publication.version_id, issued.view_id)
      ).length,
      1,
    );
  }

  async function shortGrantWindow(ttl: number, mode: "live" | "expired") {
    const clock = (await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at")
      .get(mode === "live" ? "+5 seconds" : "+2 seconds")) as { expires_at: string };
    // Historical short-deadline fixtures are inserted once, before the request.
    // They retain the production TTL distance; no immutable grant is rewritten.
    return {
      expiresAt: clock.expires_at,
      createdAt: new Date(Date.parse(clock.expires_at) - ttl).toISOString(),
    };
  }
  async function timedUpload(publication: Publication, mode: "live" | "expired") {
    const secret = mintUploadGrantSecret(),
      id = randomUlid(),
      window = await shortGrantWindow(ARTIFACT_GRANT_TTL_MS, mode);
    await db
      .prepare(
        `INSERT INTO artifact_upload_grants
         (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,
          format,declared_size,expected_digest,expires_at,consumed_at,created_at)
         SELECT workspace_id,?,version_id,?,human_id,authorization_epoch,run_id,
          format,declared_size,expected_digest,?,NULL,? FROM artifact_upload_grants
         WHERE workspace_id=? AND id=? AND consumed_at IS NULL AND human_id=?`,
      )
      .run(
        id,
        secret.secretHash,
        window.expiresAt,
        window.createdAt,
        FIX.workspace,
        publication.upload_grant.grant_id,
        FIX.owner,
      );
    return {
      ...window,
      publication: { ...publication, upload_grant: { grant_id: id, secret: secret.secret } },
    };
  }
  async function timedView(issued: View, mode: "live" | "expired") {
    const secret = mintViewGrantSecret(),
      nonce = mintViewNonce(),
      id = randomUlid(),
      window = await shortGrantWindow(VIEW_GRANT_TTL_MS, mode);
    await db
      .prepare(
        `INSERT INTO artifact_view_grants
         (workspace_id,id,version_id,grant_hash,view_nonce_hash,human_id,session_hash,
          authorization_epoch,content_hash,expires_at,consumed_at,created_at)
         SELECT workspace_id,?,version_id,?,?,human_id,session_hash,
          authorization_epoch,content_hash,?,NULL,? FROM artifact_view_grants
         WHERE workspace_id=? AND id=? AND consumed_at IS NULL AND human_id=?`,
      )
      .run(
        id,
        secret.secretHash,
        digest(new TextEncoder().encode(nonce)),
        window.expiresAt,
        window.createdAt,
        FIX.workspace,
        issued.view_id,
        FIX.owner,
      );
    return { ...window, view: { view_id: id, secret: secret.secret, nonce } };
  }

  await check("healthy_private_shared_runfree_convergence_and_one_use", async (phase) => {
    for (const [label, permission, uploader, reader] of [
      ["creator", "none", member, member],
      ["contributor", "contribute", owner, owner],
      ["recipient", "read", member, owner],
      ["shared", "shared", owner, owner],
    ] as const) {
      phase(`healthy_${label}`);
      const f = await fixture(permission),
        bytes = body(label),
        publication = await create(bytes, f.runId, uploader);
      const probe = { scope: randomUlid() },
        response = await upload(publication, bytes, probe);
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { version_id: string }).version_id,
        publication.version_id,
      );
      const uploadEffects = await observations(probe);
      assert.equal(uploadEffects.put_calls, 1);
      assert(uploadEffects.native_put_stored);
      await publicationFacts(publication, bytes, f.runId, true);
      await assertReplay(() => upload(publication, bytes));
      await finalize(publication, bytes, uploader);
      const issued = await view(publication, reader),
        readProbe = { scope: randomUlid() };
      const opened = await redeem(issued, readProbe);
      assert.equal(opened.status, 200);
      assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), bytes);
      const reads = await observations(readProbe);
      assert.equal(reads.get_calls, 1);
      assert.equal(reads.array_buffer_reads, 1);
      await assertReplay(() => redeem(issued));
      if (label === "creator") {
        const before = await snapshot();
        await denied(
          await browser(`${workspacePath}/artifacts/${publication.version_id}/views`, {}, owner),
        );
        assert.deepEqual(await snapshot(), before);
      }
    }
    phase("healthy_runfree_same_content_receipt_convergence");
    const bytes = body("runfree-convergence"),
      publication = await create(bytes, null);
    const secondGrant = await browser(
      `${workspacePath}/artifacts/${publication.version_id}/grants`,
      {},
    );
    assert.equal(secondGrant.status, 201);
    const second = {
      ...publication,
      upload_grant: (await secondGrant.json()) as Publication["upload_grant"],
    };
    const first = await upload(publication, bytes);
    assert.equal(first.status, 200);
    await first.arrayBuffer();
    const probe = { scope: randomUlid() },
      converged = await upload(second, bytes, probe);
    assert.equal(converged.status, 200);
    assert.equal(((await converged.json()) as { deduplicated: boolean }).deduplicated, true);
    assert.equal((await observations(probe)).native_put_stored, false);
    await publicationFacts(publication, bytes, null, true);
    await assertReplay(() => upload(second, bytes));
    await finalize(publication, bytes);
    const issued = await view(publication),
      opened = await redeem(issued);
    assert.equal(opened.status, 200);
    assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), bytes);
    await fk();
  });
  await check("private_view_before_consume_after_native_get_and_body", async (phase) => {
    for (const seam of ["before", "get", "body"] as const) {
      phase(`view_${seam}`);
      const f = await fixture("read"),
        bytes = body(`view-${seam}`),
        publication = await create(bytes, f.runId, member);
      const uploaded = await upload(publication, bytes);
      assert.equal(uploaded.status, 200);
      await uploaded.arrayBuffer();
      await finalize(publication, bytes, member);
      const issued = await view(publication),
        probe: Probe = { scope: randomUlid(), seam, taskGrantId: f.taskGrantId! };
      await denied(await redeem(issued, probe));
      const effects = await observations(probe);
      assert.equal(effects.consume_committed, seam !== "before");
      assert.equal(effects.get_calls, seam === "before" ? 0 : 1);
      assert.equal(effects.array_buffer_reads, seam === "before" ? 0 : 1);
      await assertReplay(() => redeem(issued));
      await publicationFacts(publication, bytes, f.runId, true);
    }
  });
  await check("private_upload_before_consume_and_after_native_put", async (phase) => {
    for (const seam of ["before", "put"] as const) {
      phase(`upload_${seam}`);
      const f = await fixture("contribute"),
        bytes = body(`upload-${seam}`),
        publication = await create(bytes, f.runId);
      const probe: Probe = { scope: randomUlid(), seam, taskGrantId: f.taskGrantId! };
      await denied(await upload(publication, bytes, probe), seam === "before" ? 403 : 409);
      const effects = await observations(probe);
      assert.equal(effects.consume_committed, seam !== "before");
      assert.equal(effects.body_reads, seam === "before" ? 0 : 1);
      assert.equal(effects.put_calls, seam === "before" ? 0 : 1);
      assert.equal(effects.native_put_stored, seam !== "before");
      const key = await publicationFacts(publication, bytes, f.runId, false),
        object = await bucket.get(key);
      if (seam === "before") assert.equal(object, null);
      else {
        assert(object);
        assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
      }
      assert.deepEqual(
        await db
          .prepare("SELECT state FROM artifact_versions WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, publication.version_id),
        { state: "uploading" },
      );
      await assertReplay(() => upload(publication, bytes));
    }
  });
  await check(
    "private_upload_reply_withheld_after_successful_native_receipt_commit",
    async (phase) => {
      const f = await fixture("contribute"),
        bytes = body("receipt-committed"),
        publication = await create(bytes, f.runId);
      phase("successful_receipt_batch_then_independent_revoke");
      const probe: Probe = {
        scope: randomUlid(),
        seam: "receipt",
        taskGrantId: f.taskGrantId!,
        versionId: publication.version_id,
      };
      await denied(await upload(publication, bytes, probe));
      const effects = await observations(probe);
      assert(
        effects.consume_committed &&
          effects.receipt_committed &&
          effects.committed_history_preserved,
      );
      assert.equal(effects.put_calls, 1);
      assert(effects.native_put_stored);
      const key = await publicationFacts(publication, bytes, f.runId, true),
        object = await bucket.get(key);
      assert(object);
      assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
      assert.deepEqual(
        await db
          .prepare("SELECT state FROM artifact_versions WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, publication.version_id),
        { state: "uploading" },
      );
      await assertReplay(() => upload(publication, bytes));
    },
  );
  await check("healthy_named_reviewer_private_read_and_one_use", async (phase) => {
    const f = await fixture("read", FIX.reviewer),
      bytes = body("reviewer-read"),
      publication = await create(bytes, f.runId, member);
    const uploaded = await upload(publication, bytes);
    assert.equal(uploaded.status, 200);
    await uploaded.arrayBuffer();
    await finalize(publication, bytes, member);
    phase("reviewer_cookie_csrf_view_issue_and_native_bytes");
    const issued = await view(publication, reviewer),
      probe = { scope: randomUlid() },
      response = await redeem(issued, probe);
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const effects = await observations(probe);
    assert.equal(effects.get_calls, 1);
    assert.equal(effects.array_buffer_reads, 1);
    await reviewerViewFacts(issued, publication, f);
    await publicationFacts(publication, bytes, f.runId, true);
    await assertReplay(() => redeem(issued));
  });
  await check("private_view_restricted_project_loss_after_native_get_and_body", async (phase) => {
    const waveFailures: Array<{ seam: string; error: unknown }> = [];
    for (const seam of ["get", "body"] as const) {
      try {
        phase(`restricted_project_${seam}`);
        // Each independent wave starts readable; an earlier denied view cannot mask the next seam.
        await db
          .prepare(
            "INSERT OR IGNORE INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)",
          )
          .run(FIX.workspace, FIX.projectA, FIX.reviewer);
        const f = await fixture("read", FIX.reviewer),
          bytes = body(`restricted-project-${seam}`),
          publication = await create(bytes, f.runId, member);
        const uploaded = await upload(publication, bytes);
        assert.equal(uploaded.status, 200);
        await uploaded.arrayBuffer();
        await finalize(publication, bytes, member);
        const issued = await view(publication, reviewer),
          probe: Probe = {
            scope: randomUlid(),
            seam,
            taskGrantId: f.taskGrantId!,
            projectAccessLoss: true,
          };
        await denied(await redeem(issued, probe));
        const effects = await observations(probe);
        assert(effects.consume_committed && effects.project_access_removed);
        assert.equal(effects.get_calls, 1);
        assert.equal(effects.array_buffer_reads, 1);
        assert.equal(
          await db
            .prepare(
              "SELECT 1 FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .get(FIX.workspace, FIX.projectA, FIX.reviewer),
          null,
        );
        await reviewerViewFacts(issued, publication, f);
        const retained = await snapshot();
        const key = await publicationFacts(publication, bytes, f.runId, true),
          object = await bucket.get(key);
        assert(object);
        assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
        await assertReplay(() => redeem(issued));
        assert.deepEqual(await snapshot(), retained);
        await fk();
      } catch (error) {
        waveFailures.push({ seam, error });
      }
    }
    if (waveFailures.length) {
      phase(`restricted_project_${waveFailures[0]!.seam}`);
      throw waveFailures[0]!.error;
    }
  });
  for (const family of ["upload", "view"] as const) {
    for (const mode of ["live", "expired"] as const) {
      await check(
        `human_${family}_grant_${mode === "live" ? "delayed_live_completion_after_ttl" : "natural_expiry_before_native_batch"}`,
        async (phase) => {
          const f = await fixture("contribute"),
            bytes = body(`grant-clock-${family}-${mode}`),
            publication = await create(bytes, f.runId);
          if (family === "view") {
            const uploaded = await upload(publication, bytes);
            assert.equal(uploaded.status, 200);
            await uploaded.arrayBuffer();
            await finalize(publication, bytes);
          }
          const timed =
            family === "upload"
              ? await timedUpload(publication, mode)
              : await timedView(await view(publication), mode);
          const timedPublication = "publication" in timed ? timed.publication : null;
          const timedIssued = "view" in timed ? timed.view : null;
          const grantId = timedPublication?.upload_grant.grant_id ?? timedIssued!.view_id;
          const table = family === "upload" ? "artifact_upload_grants" : "artifact_view_grants";
          const storedGrant = (await db
            .prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`)
            .get(FIX.workspace, grantId)) as Record<string, unknown>;
          assert(storedGrant);
          assert.equal(
            Date.parse(timed.expiresAt) - Date.parse(timed.createdAt),
            family === "upload" ? ARTIFACT_GRANT_TTL_MS : VIEW_GRANT_TTL_MS,
          );
          assert.equal(storedGrant.consumed_at, null);
          const before = await snapshot(),
            probe: Probe = { scope: randomUlid(), expiryMode: mode };
          phase("native_prepared_bound_unchanged_live_arrival_then_clock_delay");
          const response = timedPublication
            ? await upload(timedPublication, bytes, probe)
            : await redeem(timedIssued!, probe);
          const effects = await observations(probe);
          assert(
            effects.expiry_prepared_bound &&
              effects.expiry_arrival_live &&
              effects.expiry_delay_unchanged &&
              effects.expiry_batch_forwarded,
          );
          assert.equal(effects.expiry_deadline, timed.expiresAt);
          assert.equal(effects.expiry_delay_ms, 2_200);
          assert(Date.parse(effects.expiry_arrival_at!) < Date.parse(timed.expiresAt));
          assert.equal(effects.expiry_before_batch_expired, mode === "expired");
          assert(
            Date.parse(effects.expiry_before_batch_at!) >= Date.parse(effects.expiry_arrival_at!),
          );
          if (mode === "expired") {
            phase("uniform_expired_denial_before_body_storage_and_complete_rollback");
            await denied(response);
            assert(effects.expiry_batch_rolled_back && effects.canonical_unchanged);
            assert.equal(effects.consume_committed, false);
            assert.equal(effects.put_calls, 0);
            assert.equal(effects.get_calls, 0);
            assert.equal(effects.array_buffer_reads, 0);
            if (family === "upload") assert.equal(effects.body_reads, 0);
            assert.deepEqual(await snapshot(), before);
            assert.deepEqual(
              await db
                .prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`)
                .get(FIX.workspace, grantId),
              storedGrant,
            );
            if (family === "upload") {
              const key = await publicationFacts(publication, bytes, f.runId, false);
              assert.equal(await bucket.get(key), null);
            } else await publicationFacts(publication, bytes, f.runId, true);
          } else {
            phase("successful_consumption_then_completion_after_unchanged_deadline");
            assert.equal(response.status, 200);
            assert(effects.consume_committed && effects.expiry_completion_after_ttl);
            assert(Date.parse(effects.expiry_completion_at!) >= Date.parse(timed.expiresAt));
            assert.equal(effects.expiry_batch_rolled_back, false);
            assert.deepEqual(
              await db
                .prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`)
                .get(FIX.workspace, grantId),
              { ...storedGrant, consumed_at: now },
            );
            const action =
              family === "upload" ? "artifact.grant_consumed" : "artifact.view_redeemed";
            assert.deepEqual(
              await db
                .prepare(
                  "SELECT action,created_at FROM artifact_audit_outbox WHERE workspace_id=? AND version_id=? AND grant_id=? AND action=?",
                )
                .all(FIX.workspace, publication.version_id, grantId, action),
              [{ action, created_at: now }],
            );
            if (timedPublication) {
              assert.equal(
                ((await response.json()) as { version_id: string }).version_id,
                publication.version_id,
              );
              assert.equal(effects.body_reads, 1);
              assert.equal(effects.put_calls, 1);
              assert(effects.native_put_stored);
              await publicationFacts(publication, bytes, f.runId, true);
              assert.deepEqual(
                await db
                  .prepare(
                    "SELECT consumed_at FROM artifact_upload_consumptions WHERE workspace_id=? AND grant_id=?",
                  )
                  .get(FIX.workspace, grantId),
                { consumed_at: now },
              );
              // Expiry after successful consumption must not cancel explicit finalization.
              await finalize(publication, bytes);
              await assertReplay(() => upload(timedPublication, bytes));
            } else {
              assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
              assert.equal(effects.get_calls, 1);
              assert.equal(effects.array_buffer_reads, 1);
              await assertReplay(() => redeem(timedIssued!));
              await publicationFacts(publication, bytes, f.runId, true);
            }
          }
          await fk();
        },
      );
    }
  }
  const report = {
    checks,
    failures,
    bounds,
    migration_head: loadMigrationManifest(resolve(root, "migrations/d1")).migration_head,
  };
  console.log(JSON.stringify(report));
  if (failures.length) process.exitCode = 1;
  else console.log("C11_ARTIFACT_PRIVACY_D1_R2_OK");
} finally {
  await server.close();
}
