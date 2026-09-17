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
  sweepAbandonedArtifactUploads,
  syntheticUlid,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.v01.test";
const ARTIFACT_ORIGIN = "https://artifacts.v01.test";
// Phased clocks keep each phase inside a fresh durable-abuse window while
// grant TTL and sweep assertions use their own explicit timestamps.
const T0 = "2026-09-17T12:00:00.000Z";
const T1 = "2026-09-17T12:05:00.000Z";
const T1_LATE = "2026-09-17T12:21:01.000Z";
const T2 = "2026-09-17T12:10:00.000Z";
const T3 = "2026-09-17T12:15:00.000Z";
const T4A = "2026-09-17T12:20:00.000Z";
const T4B = "2026-09-17T12:39:00.000Z";
const SWEEP_TIME = "2026-09-17T12:40:00.000Z";
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
) {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "cf-connecting-ip": ip,
    "x-v01-test-time": now,
  };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return server.getWorker("bfb-v01-artifact").fetch(`${ARTIFACT_ORIGIN}/upload/${grantId}`, {
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
    ARTIFACTS: {
      head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
    };
  };
  const db = adaptD1(env.DB);

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
  assert.deepEqual(budgetStatuses.slice(0, 20), new Array(20).fill(200));
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
  const liveAtSweep = await create(1, reviewBody(TEXT), OWNER, "192.0.2.91", T4B);
  void liveAtSweep;
  const marked = await sweepAbandonedArtifactUploads(db, SWEEP_TIME);
  assert(marked.includes(abandoned.version_id), "abandoned version was not swept");
  const states = (await db.prepare(`SELECT id, state FROM artifact_versions`).all()) as Array<{
    id: string;
    state: string;
  }>;
  const byId = new Map(states.map((row) => [row.id, row.state]));
  assert.equal(byId.get(abandoned.version_id), "failed");
  assert.equal(byId.get(created.version_id), "available");
  note("sweep_marked", marked.length);

  // Capability scan: no secret, bearer, or byte payload survives in D1 or R2 keys.
  const dump = JSON.stringify({
    grants: await db.prepare(`SELECT * FROM artifact_upload_grants`).all(),
    versions: await db.prepare(`SELECT * FROM artifact_versions`).all(),
    objects: await db.prepare(`SELECT * FROM artifact_objects`).all(),
    receipts: await db.prepare(`SELECT * FROM artifact_upload_receipts`).all(),
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
