// ABOUTME: Certifies artifact publication across two control isolates and the Artifact Worker.
// ABOUTME: Real D1, disposable R2, and the production hub prove faults, races, and budgets.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  bumpMemberEpoch,
  seedSyntheticWorkspace,
  listAbandonedArtifactUploads,
  randomUlid,
  syntheticUlid,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";
import type { ArtifactTestBucket } from "./artifact.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.v01.test";
const ARTIFACT_ORIGIN = "https://artifacts.v01.test";
// Abuse-clock phases are synthetic; Hub authority and grant issuance use real
// current server time. Expiry/sweep probes remain relative to this fresh base.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const phase = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const T1 = phase(1);
const T1_LATE = phase(17);
const T2 = phase(2);
const T3 = phase(3);
const T4A = phase(4);
const SIGNING = "v01-runtime-current-signing-key-55c1e7";
const SESSION = "v01-synthetic-session";
const SESSION_TOKEN = "v01-synthetic-session-token";
const MEMBER_SESSION = "v01-synthetic-member-session";
const MEMBER_TOKEN = "v01-synthetic-member-token";
const REVIEWER_SESSION = "v01-synthetic-reviewer-session";
const REVIEWER_TOKEN = "v01-synthetic-reviewer-token";
const TEXT = new TextEncoder().encode("# synthetic review\n");
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33,
  0x44, 0x55, 0x66,
]);
const RUN_ID = syntheticUlid("V01RUN");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionPair(sessionId: string, token: string): { cookie: string; csrf: string } {
  const signed = `${token}.${createHmac("sha256", SIGNING).update(token).digest("base64")}`;
  return {
    cookie: `__Host-bfb_session=${encodeURIComponent(signed)}`,
    csrf: `2.${createHmac("sha256", SIGNING).update(`bfb-csrf:${sessionId}`).digest("hex")}`,
  };
}
const OWNER = sessionPair(SESSION, SESSION_TOKEN);
const MEMBER = sessionPair(MEMBER_SESSION, MEMBER_TOKEN);
const REVIEWER = sessionPair(REVIEWER_SESSION, REVIEWER_TOKEN);

const database = {
  binding: "DB",
  database_name: "bfb-v01-test",
  database_id: "00000000-0000-4000-8000-000000000020",
  migrations_dir: resolve(root, "migrations/d1"),
};
const base = {
  compatibility_date: "2026-08-08",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [database],
};
const control = {
  ...base,
  main: resolve(root, "tools/artifacts/control.ts"),
  vars: {
    ENVIRONMENT: "local",
    JURISDICTION: "global",
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN,
    LAUNCH_ORIGIN: "https://launch.v01.test",
    BETTER_AUTH_SECRETS: `2:${SIGNING},1:v01-runtime-previous-signing-key-9d22b0`,
    GITHUB_CLIENT_ID: "v01-synthetic-github-client",
    GITHUB_CLIENT_SECRET: "v01-synthetic-github-secret",
    AUTH_ABUSE_SECRET: "v01-synthetic-abuse-key-4c88e2abxx-long",
  },
  r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v01-artifacts" }],
  queues: {
    producers: [
      { binding: "JOBS", queue: "bfb-v01-jobs" },
      { binding: "JOBS_DLQ", queue: "bfb-v01-jobs-dlq" },
    ],
  },
  assets: { directory: resolve(root, "apps/web/dist"), binding: "ASSETS" },
  durable_objects: {
    bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-v01-hub" }],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...control, name: "bfb-v01-a" } },
    { config: { ...control, name: "bfb-v01-b" } },
    {
      config: {
        ...base,
        name: "bfb-v01-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
    {
      config: {
        ...base,
        name: "bfb-v01-artifact-b",
        main: resolve(root, "tools/artifacts/artifact.ts"),
        vars: {
          ENVIRONMENT: "local",
          ARTIFACT_ORIGIN,
          APP_ORIGIN: ORIGIN,
          UPLOAD_ABUSE_SECRET: "v01-harness-upload-abuse-secret-8e13d2axx-long",
        },
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v01-artifacts" }],
      },
    },
    {
      config: {
        ...base,
        name: "bfb-v01-artifact",
        main: resolve(root, "tools/artifacts/artifact.ts"),
        vars: {
          ENVIRONMENT: "local",
          ARTIFACT_ORIGIN,
          APP_ORIGIN: ORIGIN,
          UPLOAD_ABUSE_SECRET: "v01-harness-upload-abuse-secret-8e13d2axx-long",
        },
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v01-artifacts" }],
      },
    },
  ],
});

type Session = { cookie: string; csrf: string };

function browser(
  index: number,
  method: string,
  path: string,
  body: unknown,
  session: Session = OWNER,
  ip = "192.0.2.91",
  now: string = T0,
) {
  const init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  } = {
    method,
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "x-v01-test-time": now,
      cookie: session.cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": session.csrf,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return server.getWorker(index % 2 ? "bfb-v01-b" : "bfb-v01-a").fetch(ORIGIN + path, init);
}

function upload(
  grantId: string,
  secret: string | null,
  body: Uint8Array,
  ip = "192.0.2.91",
  now: string = T0,
  index = 0,
  raceScope?: string,
  receiptScope?: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "cf-connecting-ip": ip,
    "x-v01-test-time": now,
  };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  if (raceScope) headers["x-v01-race-scope"] = raceScope;
  if (receiptScope) headers["x-v01-receipt-race-scope"] = receiptScope;
  return server
    .getWorker(index % 2 ? "bfb-v01-artifact-b" : "bfb-v01-artifact")
    .fetch(`${ARTIFACT_ORIGIN}/upload/${grantId}`, {
      method: "PUT",
      headers,
      body: body as unknown as never,
    });
}

type WorkerResponse = Awaited<ReturnType<typeof upload>>;

async function accepted<T>(response: WorkerResponse, status = 200): Promise<T> {
  assert.equal(
    response.status,
    status,
    `unexpected status ${response.status}: ${await response.clone().text()}`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as T;
}

async function rejected(response: WorkerResponse): Promise<void> {
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "request_rejected",
    message: "request rejected",
  });
}

type Created = {
  artifact_id: string;
  version_id: string;
  upload_grant: { grant_id: string; secret: string; expires_at: string };
};

async function create(
  index: number,
  body: Record<string, unknown>,
  session: Session = OWNER,
  ip = "192.0.2.91",
  now: string = T0,
): Promise<Created> {
  return accepted<Created>(
    await browser(
      index,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts`,
      body,
      session,
      ip,
      now,
    ),
    201,
  );
}

function reviewBody(
  bytes: Uint8Array,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: "markdown",
    role: "review",
    declared_size: bytes.byteLength,
    expected_digest: digest(bytes),
    ...extra,
  };
}

async function seedHuman(
  db: SqlDatabase,
  userId: string,
  sessionId: string,
  token: string,
  humanId: string,
  email: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(userId, email, email, T0, T0);
  await db.prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`).run(userId, humanId);
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-09-17T12:00:00.000Z', ?, ?, ?, ?)`,
    )
    .run(sessionId, token, T0, T0, userId);
}

const outcomes: Record<string, number> = {};
function note(name: string, value = 1): void {
  outcomes[name] = (outcomes[name] ?? 0) + value;
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-v01-a");
  await worker.applyD1Migrations("DB");
  const env = (await worker.getEnv()) as unknown as {
    DB: D1Like;
    ARTIFACTS: ArtifactTestBucket;
  };
  const db = adaptD1(env.DB);
  await db
    .prepare("CREATE TABLE v01_read_barriers (scope TEXT PRIMARY KEY, arrivals INTEGER NOT NULL)")
    .run();

  await seedSyntheticWorkspace(db, T0, "global");
  await seedHuman(db, "v01-user", SESSION, SESSION_TOKEN, FIX.owner, "owner@synthetic.test");
  await seedHuman(
    db,
    "v01-member-user",
    MEMBER_SESSION,
    MEMBER_TOKEN,
    FIX.member,
    "member@synthetic.test",
  );
  await seedHuman(
    db,
    "v01-reviewer-user",
    REVIEWER_SESSION,
    REVIEWER_TOKEN,
    FIX.restricted,
    "restricted@synthetic.test",
  );
  const taskId = syntheticUlid("V01TASK");
  await db
    .prepare(
      `INSERT INTO tasks (workspace_id, id, project_id, parent_task_id, title, state, priority, due_at, next_owner_type, next_owner_id, next_action_reason, punchline, resource_version, created_by_human_id, created_by_delegation_id, created_at)
       VALUES (?, ?, ?, NULL, 'Synthetic artifact task', 'ready', 'P2', NULL, 'unassigned', NULL, NULL, 'Synthetic punchline.', 1, ?, NULL, ?)`,
    )
    .run(FIX.workspace, taskId, FIX.projectA, FIX.owner, T0);
  await db
    .prepare(
      `INSERT INTO runs (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id, result_state, activity, resource_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 'working', 1, ?)`,
    )
    .run(FIX.workspace, RUN_ID, FIX.projectA, taskId, FIX.owner, FIX.profileCodex, T0);

  // Happy path: create, upload, finalize through alternating isolates.
  const created = await create(0, reviewBody(TEXT));
  note("created");
  assert.match(created.upload_grant.secret, /^[A-Za-z0-9_-]{43}$/);
  const uploaded = await accepted<{
    version_id: string;
    content_hash: string;
    size: number;
    r2_key: string;
    deduplicated: boolean;
  }>(await upload(created.upload_grant.grant_id, created.upload_grant.secret, TEXT));
  note("uploaded");
  assert.equal(uploaded.content_hash, digest(TEXT));
  assert.equal(uploaded.r2_key, `workspaces/${FIX.workspace}/artifacts/sha256/${digest(TEXT)}`);
  assert.equal(uploaded.deduplicated, false);
  const head = await env.ARTIFACTS.head(uploaded.r2_key);
  assert(head, "R2 object is missing after upload");
  assert.equal(head?.size, TEXT.byteLength);
  assert.equal(head?.customMetadata?.sha256, digest(TEXT));
  note("r2_confirmed");
  const finalized = await accepted<{ state: string; r2_key: string }>(
    await browser(
      1,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${created.version_id}/finalize`,
      { content_hash: digest(TEXT), size: TEXT.byteLength },
    ),
  );
  assert.equal(finalized.state, "available");
  assert.equal(finalized.r2_key, uploaded.r2_key);
  note("finalized");

  // A valid workspace member loses all artifact mutation/upload authority on
  // a restricted run as soon as the project grant is removed, without an epoch bump.
  const scoped = await create(0, reviewBody(TEXT, { run_id: RUN_ID }), MEMBER, "192.0.2.181");
  const scopedReceipt = await create(1, reviewBody(TEXT, { run_id: RUN_ID }), OWNER, "192.0.2.182");
  await accepted(
    await upload(
      scopedReceipt.upload_grant.grant_id,
      scopedReceipt.upload_grant.secret,
      TEXT,
      "192.0.2.182",
    ),
  );
  await db
    .prepare(
      "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
    )
    .run(FIX.workspace, FIX.projectA, FIX.member);
  await rejected(
    await browser(
      0,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${scoped.version_id}/grants`,
      {},
      MEMBER,
      "192.0.2.183",
    ),
  );
  await rejected(
    await browser(
      1,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${scopedReceipt.version_id}/finalize`,
      { content_hash: digest(TEXT), size: TEXT.byteLength },
      MEMBER,
      "192.0.2.184",
    ),
  );
  await rejected(
    await upload(scoped.upload_grant.grant_id, scoped.upload_grant.secret, TEXT, "192.0.2.185"),
  );
  assert.deepEqual(
    await db
      .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE id = ?")
      .get(scoped.upload_grant.grant_id),
    { consumed_at: null },
  );
  await db
    .prepare("INSERT INTO project_access (workspace_id, project_id, human_id) VALUES (?, ?, ?)")
    .run(FIX.workspace, FIX.projectA, FIX.member);
  note("current_project_authority_rejected");

  // Replay, wrong secret, unknown grant, and missing auth never yield bytes.
  await rejected(await upload(created.upload_grant.grant_id, created.upload_grant.secret, TEXT));
  note("replay_rejected");
  const fresh = await create(1, reviewBody(TEXT));
  await rejected(await upload(fresh.upload_grant.grant_id, "wrong-secret-value-0123456789", TEXT));
  note("wrong_secret_rejected");
  await rejected(await upload(syntheticUlid("V01NOGRT"), created.upload_grant.secret, TEXT));
  note("unknown_grant_rejected");
  const noAuth = await server
    .getWorker("bfb-v01-artifact")
    .fetch(`${ARTIFACT_ORIGIN}/upload/${fresh.upload_grant.grant_id}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "x-v01-test-time": T0 },
      body: TEXT as unknown as never,
    });
  assert.equal(noAuth.status, 403);
  note("missing_auth_rejected");

  // Expiry, revocation, reviewer, and foreign-workspace negatives.
  const expiring = await create(0, reviewBody(TEXT), OWNER, "192.0.2.91", T1);
  const expired = await upload(
    expiring.upload_grant.grant_id,
    expiring.upload_grant.secret,
    TEXT,
    "192.0.2.91",
    T1_LATE,
  );
  assert.equal(expired.status, 403);
  note("expiry_rejected");
  await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
  const revoked = await create(0, reviewBody(TEXT), OWNER, "192.0.2.91", T1);
  await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
  await rejected(
    await upload(
      revoked.upload_grant.grant_id,
      revoked.upload_grant.secret,
      TEXT,
      "192.0.2.91",
      T1,
    ),
  );
  note("revoked_upload_rejected");
  const revokedFinalize = await browser(
    0,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/artifacts/${created.version_id}/finalize`,
    { content_hash: digest(TEXT), size: TEXT.byteLength },
    OWNER,
    "192.0.2.91",
    T1,
  );
  assert.equal(revokedFinalize.status, 403);
  note("revoked_finalize_rejected");
  const reviewerCreate = await browser(
    0,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/artifacts`,
    reviewBody(TEXT),
    REVIEWER,
    "192.0.2.91",
    T1,
  );
  assert.equal(reviewerCreate.status, 403);
  note("reviewer_create_rejected");
  const reviewerVersion = await create(1, reviewBody(TEXT), OWNER, "192.0.2.91", T1);
  const reviewerFinalize = await browser(
    1,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/artifacts/${reviewerVersion.version_id}/finalize`,
    { content_hash: digest(TEXT), size: TEXT.byteLength },
    REVIEWER,
    "192.0.2.91",
    T1,
  );
  assert.equal(reviewerFinalize.status, 403);
  note("reviewer_finalize_rejected");
  const foreign = await browser(
    0,
    "POST",
    `/api/v1/workspaces/${syntheticUlid("V01OTHER")}/artifacts/${reviewerVersion.version_id}/finalize`,
    { content_hash: digest(TEXT), size: TEXT.byteLength },
    OWNER,
    "192.0.2.91",
    T1,
  );
  assert([401, 403, 404].includes(foreign.status), `unexpected foreign status ${foreign.status}`);
  note("foreign_workspace_rejected");

  // Size, digest, and MIME errors consume the grant but keep a recoverable version.
  const sized = await create(0, reviewBody(TEXT), OWNER, "192.0.2.91", T2);
  const short = await upload(
    sized.upload_grant.grant_id,
    sized.upload_grant.secret,
    TEXT.slice(0, 4),
    "192.0.2.91",
    T2,
  );
  assert.equal(short.status, 422);
  assert.deepEqual(await short.json(), { error: "upload_rejected", message: "size_mismatch" });
  note("size_rejected");
  const tampered = new TextEncoder().encode("# synthetic review tampered!\n");
  const wrongDigest = await create(
    1,
    {
      format: "markdown",
      role: "review",
      declared_size: tampered.byteLength,
      expected_digest: digest(TEXT),
    },
    OWNER,
    "192.0.2.91",
    T2,
  );
  const tamperedResponse = await upload(
    wrongDigest.upload_grant.grant_id,
    wrongDigest.upload_grant.secret,
    tampered,
    "192.0.2.91",
    T2,
  );
  assert.equal(tamperedResponse.status, 422);
  assert.deepEqual(await tamperedResponse.json(), {
    error: "upload_rejected",
    message: "digest_mismatch",
  });
  note("digest_rejected");
  const pngVersion = await create(
    0,
    {
      format: "markdown",
      role: "review",
      declared_size: PNG.byteLength,
      expected_digest: digest(PNG),
    },
    OWNER,
    "192.0.2.91",
    T2,
  );
  const mime = await upload(
    pngVersion.upload_grant.grant_id,
    pngVersion.upload_grant.secret,
    PNG,
    "192.0.2.91",
    T2,
  );
  assert.equal(mime.status, 422);
  assert.deepEqual(await mime.json(), { error: "upload_rejected", message: "mime_mismatch" });
  note("mime_rejected");
  const big = new Uint8Array(6 * 1024 * 1024).fill(65);
  const bigVersion = await create(1, reviewBody(TEXT), OWNER, "192.0.2.91", T2);
  const oversized = await upload(
    bigVersion.upload_grant.grant_id,
    bigVersion.upload_grant.secret,
    big,
    "192.0.2.91",
    T2,
  );
  assert.equal(oversized.status, 413);
  note("oversize_rejected");

  // Log chunks ride the run-scoped key prefix and must be compressed.
  const plainLog = await create(
    0,
    {
      format: "log",
      role: "log",
      declared_size: TEXT.byteLength,
      expected_digest: digest(TEXT),
      run_id: RUN_ID,
    },
    OWNER,
    "192.0.2.91",
    T2,
  );
  const plainLogUpload = await upload(
    plainLog.upload_grant.grant_id,
    plainLog.upload_grant.secret,
    TEXT,
    "192.0.2.91",
    T2,
  );
  assert.equal(plainLogUpload.status, 422);
  note("log_role_rejected");
  const chunk = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, ...TEXT]);
  const logged = await create(
    1,
    {
      format: "log",
      role: "log",
      declared_size: chunk.byteLength,
      expected_digest: digest(chunk),
      run_id: RUN_ID,
    },
    OWNER,
    "192.0.2.91",
    T2,
  );
  const loggedUpload = await accepted<{ r2_key: string }>(
    await upload(logged.upload_grant.grant_id, logged.upload_grant.secret, chunk, "192.0.2.91", T2),
  );
  assert.equal(
    loggedUpload.r2_key,
    `workspaces/${FIX.workspace}/runs/${RUN_ID}/logs/${logged.version_id}.jsonl.zst`,
  );
  note("log_chunk_uploaded");
  const loggedFinalize = await accepted<{ state: string }>(
    await browser(
      0,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${logged.version_id}/finalize`,
      { content_hash: digest(chunk), size: chunk.byteLength },
      OWNER,
      "192.0.2.91",
      T2,
    ),
  );
  assert.equal(loggedFinalize.state, "available");
  note("log_chunk_finalized");

  // Same-hash race: two versions, one conditional object, no overwrite.
  const raceA = await create(0, reviewBody(TEXT), OWNER, "192.0.2.92", T2);
  const raceB = await create(1, reviewBody(TEXT), OWNER, "192.0.2.93", T2);
  const [putA, putB] = await Promise.all([
    upload(raceA.upload_grant.grant_id, raceA.upload_grant.secret, TEXT, "192.0.2.92", T2),
    upload(raceB.upload_grant.grant_id, raceB.upload_grant.secret, TEXT, "192.0.2.93", T2),
  ]);
  assert.equal(putA.status, 200);
  assert.equal(putB.status, 200);
  const [finalA, finalB] = await Promise.all([
    browser(
      0,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${raceA.version_id}/finalize`,
      { content_hash: digest(TEXT), size: TEXT.byteLength },
      OWNER,
      "192.0.2.92",
      T2,
    ),
    browser(
      1,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${raceB.version_id}/finalize`,
      { content_hash: digest(TEXT), size: TEXT.byteLength },
      OWNER,
      "192.0.2.93",
      T2,
    ),
  ]);
  assert.equal(((await finalA.json()) as { state: string }).state, "available");
  assert.equal(((await finalB.json()) as { state: string }).state, "available");
  const objects = (await db
    .prepare(`SELECT COUNT(*) AS count FROM artifact_objects WHERE content_hash = ?`)
    .get(digest(TEXT))) as { count: number };
  assert.equal(objects.count, 1);
  const raceHead = await env.ARTIFACTS.head(
    `workspaces/${FIX.workspace}/artifacts/sha256/${digest(TEXT)}`,
  );
  assert(raceHead && raceHead.size === TEXT.byteLength);
  note("same_hash_race_converged");

  // Two genuine grants for one version both read an absent receipt before
  // either atomic batch flushes. Only its winning source may create an outbox.
  const receiptBytes = new TextEncoder().encode("# synthetic two-grant receipt race\n");
  const receiptVersion = await create(0, reviewBody(receiptBytes), OWNER, "192.0.2.180", T2);
  const receiptGrant = await accepted<{ grant_id: string; secret: string }>(
    await browser(
      1,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${receiptVersion.version_id}/grants`,
      { request_id: randomUlid() },
      OWNER,
      "192.0.2.181",
      T2,
    ),
    201,
  );
  const receiptScope = randomUlid();
  await db.prepare("INSERT INTO v01_read_barriers (scope,arrivals) VALUES (?,0)").run(receiptScope);
  const receiptResponses = await Promise.all(
    [receiptVersion.upload_grant, receiptGrant].map((grant, index) =>
      upload(
        grant.grant_id,
        grant.secret,
        receiptBytes,
        `192.0.2.${180 + index}`,
        T2,
        index,
        undefined,
        receiptScope,
      ),
    ),
  );
  assert.deepEqual(
    receiptResponses.map((response) => response.status),
    [200, 200],
  );
  for (const response of receiptResponses) await response.arrayBuffer();
  for (const table of ["artifact_upload_receipts", "artifact_upload_receipt_sources"])
    assert.deepEqual(
      await db
        .prepare(`SELECT COUNT(*) n FROM ${table} WHERE version_id=?`)
        .get(receiptVersion.version_id),
      { n: 1 },
    );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE version_id=? AND action='artifact.upload_verified'",
      )
      .get(receiptVersion.version_id),
    { n: 1 },
  );
  const receiptSource = await db
    .prepare(
      `SELECT source.grant_id,source.attempt_id,outbox.id FROM artifact_upload_receipt_sources source
    JOIN artifact_upload_consumptions consumed ON consumed.workspace_id=source.workspace_id AND consumed.grant_id=source.grant_id AND consumed.attempt_id=source.attempt_id
    JOIN artifact_audit_outbox outbox ON outbox.workspace_id=source.workspace_id AND outbox.id=source.outbox_id
    WHERE source.version_id=?`,
    )
    .get(receiptVersion.version_id);
  assert(receiptSource, "canonical receipt lacks its exact consumed source/outbox");
  note("two_grant_receipt_single_source_outbox");

  // Both real isolates finish their live candidate reads before either atomic
  // D1 consume batch commits. An exact same timestamp must still have one winner.
  const sameTimeBytes = new TextEncoder().encode("# synthetic same-time grant race\n");
  const sameTime = await create(0, reviewBody(sameTimeBytes), OWNER, "192.0.2.186", T2);
  const raceScope = randomUlid();
  await db.prepare("INSERT INTO v01_read_barriers (scope, arrivals) VALUES (?, 0)").run(raceScope);
  const sameTimeResponses = await Promise.all(
    [0, 1].map((index) =>
      upload(
        sameTime.upload_grant.grant_id,
        sameTime.upload_grant.secret,
        sameTimeBytes,
        `192.0.2.${187 + index}`,
        T2,
        index,
        raceScope,
      ),
    ),
  );
  assert.deepEqual(sameTimeResponses.map((response) => response.status).sort(), [200, 403]);
  for (const response of sameTimeResponses) await response.arrayBuffer();
  let bodyReads = 0,
    putCalls = 0;
  for (const name of ["bfb-v01-artifact", "bfb-v01-artifact-b"]) {
    const counts = (await (
      await server.getWorker(name).fetch(`${ARTIFACT_ORIGIN}/__v01/effects/${raceScope}`)
    ).json()) as { body_reads: number; put_calls: number };
    bodyReads += counts.body_reads;
    putCalls += counts.put_calls;
  }
  assert.equal(bodyReads, 1, "losing grant consumer read its body");
  assert.equal(putCalls, 1, "losing grant consumer called R2 put");
  assert.deepEqual(
    await db
      .prepare("SELECT COUNT(*) n FROM artifact_upload_consumptions WHERE grant_id = ?")
      .get(sameTime.upload_grant.grant_id),
    { n: 1 },
  );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM artifact_audit_outbox WHERE action = 'artifact.grant_consumed' AND grant_id = ?",
      )
      .get(sameTime.upload_grant.grant_id),
    { n: 1 },
  );
  note("same_timestamp_single_consume");
  note("same_timestamp_body_reads", bodyReads);
  note("same_timestamp_r2_puts", putCalls);

  // Real R2 returns null for the conditional conflict. Matching custom metadata
  // cannot override its stored checksum for different same-sized bytes.
  const conflictBytes = new TextEncoder().encode("# synthetic R2 checksum conflict\n");
  const conflict = await create(1, reviewBody(conflictBytes), OWNER, "192.0.2.189", T2);
  const conflictKey = `workspaces/${FIX.workspace}/artifacts/sha256/${digest(conflictBytes)}`;
  const corruptBytes = conflictBytes.slice();
  corruptBytes[2] = corruptBytes[2]! ^ 1;
  await env.ARTIFACTS.put(conflictKey, corruptBytes, {
    sha256: digest(corruptBytes),
    customMetadata: { sha256: digest(conflictBytes) },
  });
  const conflictResponse = await upload(
    conflict.upload_grant.grant_id,
    conflict.upload_grant.secret,
    conflictBytes,
    "192.0.2.189",
    T2,
  );
  assert.equal(conflictResponse.status, 500);
  assert.deepEqual(await conflictResponse.json(), { error: "upload_failed" });
  assert.deepEqual(
    await db
      .prepare("SELECT COUNT(*) n FROM artifact_upload_receipts WHERE version_id = ?")
      .get(conflict.version_id),
    { n: 0 },
  );
  const unchanged = await env.ARTIFACTS.get(conflictKey);
  assert(unchanged);
  assert.equal(digest(new Uint8Array(await unchanged.arrayBuffer())), digest(corruptBytes));
  await rejected(
    await browser(
      0,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${conflict.version_id}/finalize`,
      { content_hash: digest(conflictBytes), size: conflictBytes.byteLength },
      OWNER,
      "192.0.2.190",
      T2,
    ),
  );
  note("r2_null_checksum_conflict_rejected");

  // Upload budgets survive Worker-isolate changes; the 21st attempt fails closed.
  // Creates split across two principals so only the upload budget is exhausted.
  const budgetVersions: Created[] = [];
  // Creates rotate IPs so only the pinned upload IP budget is exhausted below.
  for (let index = 0; index < 21; index += 1) {
    budgetVersions.push(
      await create(
        index,
        reviewBody(TEXT),
        index < 11 ? OWNER : MEMBER,
        `192.0.2.${128 + index}`,
        T3,
      ),
    );
  }
  const budgetStatuses: number[] = [];
  for (const candidate of budgetVersions) {
    const response = await upload(
      candidate.upload_grant.grant_id,
      candidate.upload_grant.secret,
      TEXT,
      "192.0.2.94",
      T3,
    );
    budgetStatuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(
    budgetStatuses.slice(0, 20),
    Array.from({ length: 20 }, () => 200),
  );
  assert.equal(budgetStatuses[20], 403);
  note("budget_exhausted");
  // The budgeted-out grant was never consumed, so a fresh IP still redeems it.
  const spared = budgetVersions[20]!;
  const sparedUpload = await accepted<{ version_id: string }>(
    await upload(spared.upload_grant.grant_id, spared.upload_grant.secret, TEXT, "192.0.2.95", T3),
  );
  assert.equal(sparedUpload.version_id, spared.version_id);
  note("budget_isolated_by_ip");

  // Recovery sweep marks only versions whose grants all expired past grace.
  const abandoned = await create(0, reviewBody(TEXT), OWNER, "192.0.2.91", T4A);
  const earlySweep = await listAbandonedArtifactUploads(db, new Date().toISOString());
  assert(
    !earlySweep.some((row) => row.id === abandoned.version_id),
    "fresh grant was selected before expiry",
  );
  const freshRecovery = await accepted<{ ok: boolean }>(
    await server
      .getWorker("bfb-v01-a")
      .fetch(`${ORIGIN}/__v01/recover/${abandoned.version_id}`, { method: "POST" }),
  );
  assert.equal(freshRecovery.ok, false, "fresh system abandonment was accepted");
  // Historical synthetic setup makes one legitimate candidate; the production
  // Hub command still observes its own fresh wall clock, never this fixture's clock.
  const historicalTime = new Date(Date.now() - 21 * 60_000).toISOString();
  const expiredTime = new Date(Date.now() - 6 * 60_000).toISOString();
  const historicalArtifact = randomUlid();
  const historicalVersion = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifacts
    (workspace_id,id,run_id,format,role,created_by_human_id,created_at)
    VALUES (?, ?, NULL, 'markdown', 'review', ?, ?)`,
    )
    .run(FIX.workspace, historicalArtifact, FIX.owner, historicalTime);
  await db
    .prepare(
      `INSERT INTO artifact_versions
    (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at)
    VALUES (?, ?, ?, 'uploading', 'markdown', ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      historicalVersion,
      historicalArtifact,
      TEXT.length,
      digest(TEXT),
      historicalTime,
    );
  await db
    .prepare(
      `INSERT INTO artifact_upload_grants
    (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,
     expected_digest,expires_at,consumed_at,created_at)
    VALUES (?, ?, ?, ?, ?, 1, NULL, 'markdown', ?, ?, ?, NULL, ?)`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      historicalVersion,
      digest(new TextEncoder().encode(randomUlid())),
      FIX.owner,
      TEXT.length,
      digest(TEXT),
      expiredTime,
      historicalTime,
    );
  const candidates = await listAbandonedArtifactUploads(db, new Date().toISOString());
  assert(
    candidates.some((row) => row.id === historicalVersion),
    "historical candidate was not selected",
  );
  const recovery = await accepted<{ ok: boolean; result: { state: string } }>(
    await server
      .getWorker("bfb-v01-b")
      .fetch(`${ORIGIN}/__v01/recover/${historicalVersion}`, { method: "POST" }),
  );
  assert.equal(recovery.ok, true, "eligible Hub recovery was denied");
  assert.equal(recovery.result.state, "failed");
  const protectedVersion = randomUlid();
  await db
    .prepare(
      `INSERT INTO artifact_versions
    (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at)
    SELECT workspace_id,?,artifact_id,'uploading',format,declared_size,expected_digest,created_at
    FROM artifact_versions WHERE id=?`,
    )
    .run(protectedVersion, historicalVersion);
  assert(
    (await listAbandonedArtifactUploads(db, new Date().toISOString())).some(
      (row) => row.id === protectedVersion,
    ),
    "pre-regrant candidate was not selected",
  );
  const protectedGrant = await accepted<{ grant_id: string; secret: string }>(
    await browser(
      0,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${protectedVersion}/grants`,
      { request_id: randomUlid() },
      OWNER,
      "192.0.2.97",
      T4A,
    ),
    201,
  );
  await accepted(
    await upload(protectedGrant.grant_id, protectedGrant.secret, TEXT, "192.0.2.97", T4A),
  );
  assert(
    !(await listAbandonedArtifactUploads(db, new Date().toISOString())).some(
      (row) => row.id === protectedVersion,
    ),
    "fresh consumed grant did not protect the version",
  );
  const protectedRecovery = await accepted<{ ok: boolean }>(
    await server
      .getWorker("bfb-v01-a")
      .fetch(`${ORIGIN}/__v01/recover/${protectedVersion}`, { method: "POST" }),
  );
  assert.equal(protectedRecovery.ok, false, "in-flight consumed grant was abandoned");
  note("consumed_fresh_grant_protected");
  const states = (await db.prepare(`SELECT id, state FROM artifact_versions`).all()) as Array<{
    id: string;
    state: string;
  }>;
  const byId = new Map(states.map((row) => [row.id, row.state]));
  assert.equal(byId.get(historicalVersion), "failed");
  assert.equal(byId.get(abandoned.version_id), "uploading");
  assert.equal(byId.get(created.version_id), "available");
  note("sweep_marked", 1);

  // Original outbox IDs survive concurrent dispatch, lost replies and transient
  // Hub cache loss. Only finite metadata may enter projected events and audit.
  async function auditSource() {
    const id = randomUlid();
    await db
      .prepare(
        `INSERT INTO artifact_audit_outbox
      (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
      VALUES (?,?,?,NULL,'artifact.upload_verified',?,?,NULL)`,
      )
      .run(
        FIX.workspace,
        id,
        created.version_id,
        JSON.stringify({ private_body: "V01-PRIVATE-AUDIT-CANARY" }),
        T0,
      );
    return id;
  }
  const dispatchAudit = (id: string, index = 0, drop = false) =>
    server.getWorker(index % 2 ? "bfb-v01-b" : "bfb-v01-a").fetch(`${ORIGIN}/__v01/audit/${id}`, {
      method: "POST",
      headers: drop ? { "x-v01-drop-audit-reply": "1" } : {},
    });
  async function auditCounts(id: string) {
    const events = await db
      .prepare(`SELECT event_id,payload_json,created_at FROM semantic_events WHERE event_id=?`)
      .all(id);
    const audit = await db
      .prepare(`SELECT audit_id,payload_json FROM audit_events WHERE audit_id=?`)
      .all(id);
    const stamp = (await db
      .prepare(`SELECT dispatched_at FROM artifact_audit_outbox WHERE id=?`)
      .get(id)) as { dispatched_at: string | null };
    return { events, audit, stamp };
  }
  const concurrentSource = await auditSource();
  const concurrentAudits = await Promise.all([
    dispatchAudit(concurrentSource, 0),
    dispatchAudit(concurrentSource, 1),
  ]);
  const concurrentResults = await Promise.all(
    concurrentAudits.map((response) => accepted<{ ok: boolean; replayed: boolean }>(response)),
  );
  assert(concurrentResults.every((result) => result.ok));
  assert.equal(concurrentResults.filter((result) => result.replayed).length, 1);
  const concurrentCounts = await auditCounts(concurrentSource);
  assert.equal(concurrentCounts.events.length, 1);
  assert.equal(concurrentCounts.audit.length, 1);
  assert(concurrentCounts.stamp.dispatched_at);
  const projected = concurrentCounts.events[0] as { payload_json: string; created_at: string };
  assert.deepEqual(JSON.parse(projected.payload_json), {
    schema_version: 1,
    outbox_id: concurrentSource,
    version_id: created.version_id,
    grant_id: null,
    source_action: "artifact.upload_verified",
    occurred_at: T0,
  });
  assert.equal(projected.created_at, concurrentCounts.stamp.dispatched_at);
  note("audit_concurrent_single_projection");

  const lostAuditSource = await auditSource();
  const lostAuditResponse = await dispatchAudit(lostAuditSource, 0, true);
  assert.equal(lostAuditResponse.status, 503);
  await lostAuditResponse.arrayBuffer();
  const recoveredAudit = await accepted<{ ok: boolean; replayed: boolean }>(
    await dispatchAudit(lostAuditSource, 1),
  );
  assert.equal(recoveredAudit.ok, true);
  assert.equal(recoveredAudit.replayed, true);
  await db
    .prepare(`DELETE FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?`)
    .run(FIX.workspace, `artifact-audit:${lostAuditSource}`);
  const uncachedAudit = await accepted<{ ok: boolean }>(await dispatchAudit(lostAuditSource));
  assert.equal(uncachedAudit.ok, false);
  const lostCounts = await auditCounts(lostAuditSource);
  assert.equal(lostCounts.events.length, 1);
  assert.equal(lostCounts.audit.length, 1);
  note("audit_lost_reply_cache_loss_single_projection");

  const failedAuditSource = await auditSource();
  await db
    .prepare(
      `CREATE TRIGGER synthetic_v01_audit_failure BEFORE INSERT ON outbox_records
    WHEN NEW.kind = 'artifact.dispatch_audit'
    BEGIN SELECT RAISE(ABORT,'synthetic late audit failure'); END`,
    )
    .run();
  const failedAudit = await accepted<{ ok: boolean }>(await dispatchAudit(failedAuditSource));
  assert.equal(failedAudit.ok, false);
  assert.deepEqual(await auditCounts(failedAuditSource), {
    events: [],
    audit: [],
    stamp: { dispatched_at: null },
  });
  await db.prepare(`DROP TRIGGER synthetic_v01_audit_failure`).run();
  const retriedAudit = await accepted<{ ok: boolean }>(await dispatchAudit(failedAuditSource, 1));
  assert.equal(retriedAudit.ok, true);
  const retriedCounts = await auditCounts(failedAuditSource);
  assert.equal(retriedCounts.events.length, 1);
  assert.equal(retriedCounts.audit.length, 1);
  note("audit_late_fault_atomic_retry");
  const auditProjectionDump = JSON.stringify({
    semantic: await db.prepare(`SELECT payload_json FROM semantic_events`).all(),
    audit: await db.prepare(`SELECT payload_json FROM audit_events`).all(),
    hubOutbox: await db.prepare(`SELECT payload_json FROM outbox_records`).all(),
    cache: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
  });
  assert(!auditProjectionDump.includes("V01-PRIVATE-AUDIT-CANARY"));
  note("audit_private_payload_excluded");

  // Capability scan: no secret, bearer, or byte payload survives in D1 or R2 keys.
  const dump = JSON.stringify({
    grants: await db.prepare(`SELECT * FROM artifact_upload_grants`).all(),
    versions: await db.prepare(`SELECT * FROM artifact_versions`).all(),
    objects: await db.prepare(`SELECT * FROM artifact_objects`).all(),
    receipts: await db.prepare(`SELECT * FROM artifact_upload_receipts`).all(),
    consumption: await db.prepare(`SELECT * FROM artifact_upload_consumptions`).all(),
    receipt_sources: await db.prepare(`SELECT * FROM artifact_upload_receipt_sources`).all(),
    agent_operations: await db.prepare(`SELECT * FROM artifact_agent_operations`).all(),
    agent_grants: await db.prepare(`SELECT * FROM artifact_agent_grants`).all(),
    audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
    events: await db.prepare(`SELECT payload_json FROM semantic_events`).all(),
    idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
    buckets: await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all(),
  });
  const secrets = [
    created.upload_grant.secret,
    fresh.upload_grant.secret,
    revoked.upload_grant.secret,
    raceA.upload_grant.secret,
    raceB.upload_grant.secret,
    receiptVersion.upload_grant.secret,
    receiptGrant.secret,
    protectedGrant.secret,
  ];
  for (const secret of secrets) {
    assert(!dump.includes(secret), "secret retained outside its hashed grant");
  }
  assert(
    !dump.includes("/tmp/") && !dump.includes("/Users/"),
    "local path retained in diagnostics",
  );
  const buckets = (await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all()) as Array<{
    bucket_key: string;
  }>;
  assert(buckets.length > 0, "abuse budgets never persisted");
  for (const bucket of buckets) assert.match(bucket.bucket_key, /^[0-9a-f]{64}$/);
  const keys = (await db.prepare(`SELECT r2_key FROM artifact_objects`).all()) as Array<{
    r2_key: string;
  }>;
  assert(keys.length > 0, "no R2 keys registered");
  for (const key of keys) {
    assert.match(key.r2_key, new RegExp(`^workspaces/${FIX.workspace}/(artifacts/sha256/|runs/)`));
  }
  note("scan_clean");

  console.log(
    JSON.stringify({ ...outcomes, r2Objects: keys.length, abuseBuckets: buckets.length }),
  );
  console.log("V01_D1_OK");
} finally {
  await server.close();
}
