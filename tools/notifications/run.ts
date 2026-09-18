// ABOUTME: Proves X01 notifications across real Workers, D1, and a local Queue with DLQ.
// ABOUTME: A fake push origin and a DLQ collector observe every delivery; evidence lands redacted.

import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, copyFile, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  canonicalRunnerKey,
  encodeRunnerToken,
  FIX,
  notificationJobId,
  purgeRevokedNotificationState,
  randomUlid,
  runnerChallengeTranscript,
  runnerHash,
  runnerKeyThumbprint,
  runnerSecret,
  seedSyntheticWorkspace,
  selectNotificationEvent,
  type CommandOutcome,
  type RunnerChallenge,
  type RunnerPrincipal,
  type RunnerTokenClaims,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const now = new Date().toISOString();
const origin = "https://bfb.example.test";
const digest = `sha256:${"a".repeat(64)}`;
const emptyConfig = `sha256:${runnerHash("{}")}`;
const evidenceDir = path.resolve(root, "docs/work-packages/evidence/WP-X01");
const manifest = loadMigrationManifest(path.resolve(root, "migrations/d1"));
const split = manifest.migrations.findIndex((migration) => migration.id === "0030_notifications");
assert(split >= 0, "X01 migration is required");
assert(
  manifest.migrations.some((migration) => migration.id === "0030_notifications"),
  "X01 migration must be registered",
);

const CANARIES = [
  "CANARY task text alpha",
  "/canary/local/secret/path",
  "ghp_canarytoken000000000000000000000001",
  "bfb __launch --canary-evil",
  "--provider-arg=canary-value",
];

const recording: string[] = [];
function record(event: string, fields: Record<string, unknown> = {}): void {
  recording.push(JSON.stringify({ event, ...fields }));
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(input: string): Uint8Array<ArrayBuffer> {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const full = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return Uint8Array.from(atob(full), (char) => char.charCodeAt(0));
}

interface PushPost {
  path: string;
  authorization: string;
  contentEncoding: string | null;
  body: Uint8Array;
}

const pushPosts: PushPost[] = [];
const pushBehaviors = new Map<string, { status: number; remaining: number } | { status: number }>();
const dlqCopies: unknown[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk as Buffer));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url === "/dlq" && req.method === "POST") {
      dlqCopies.push(JSON.parse(body.toString("utf8")));
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url?.startsWith("/push/") && req.method === "POST") {
      pushPosts.push({
        path: req.url,
        authorization: req.headers.authorization ?? "",
        contentEncoding: (req.headers["content-encoding"] as string) ?? null,
        body: new Uint8Array(body),
      });
      const behavior = pushBehaviors.get(req.url);
      let status = 201;
      if (behavior) {
        status = behavior.status;
        if ("remaining" in behavior && behavior.remaining > 0) behavior.remaining -= 1;
        if ("remaining" in behavior && behavior.remaining <= 0) status = 201;
      }
      res.writeHead(status, { "content-type": "text/plain" });
      res.end("x");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const harnessPort = (server.address() as import("node:net").AddressInfo).port;
const harnessUrl = `http://127.0.0.1:${harnessPort}`;

// VAPID application-server keys (ephemeral, test-only; production uses Worker secrets).
const vapidPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const vapidRaw = new Uint8Array(
  (await crypto.subtle.exportKey("raw", vapidPair.publicKey)) as ArrayBuffer,
);
const vapidJwk = (await crypto.subtle.exportKey("jwk", vapidPair.privateKey)) as JsonWebKey;
assert(vapidJwk.d, "vapid export failed");
const VAPID_PUBLIC_KEY = b64encode(vapidRaw);
const VAPID_PRIVATE_KEY = vapidJwk.d;

interface Receiver {
  tag: string;
  p256dh: string;
  auth: string;
  privateScalar: Uint8Array;
}

async function makeReceiver(tag: string): Promise<Receiver> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  assert(jwk.d, "receiver export failed");
  return {
    tag,
    p256dh: b64encode(raw),
    auth: b64encode(crypto.getRandomValues(new Uint8Array(16))),
    privateScalar: b64decode(jwk.d),
  };
}

const receivers = new Map<string, Receiver>();

function fresh(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(view);
}

async function decryptPush(receiver: Receiver, body: Uint8Array): Promise<unknown> {
  const salt = fresh(body.slice(0, 16));
  const keyLen = body[20];
  assert(keyLen === 65, "sender key must be an uncompressed point");
  const senderPublic = fresh(body.slice(21, 21 + keyLen));
  const ciphertext = fresh(body.slice(21 + keyLen));
  const splitPoint = (point: Uint8Array) => ({
    x: b64encode(point.slice(1, 33)),
    y: b64encode(point.slice(33, 65)),
  });
  const receiverPoint = b64decode(receiver.p256dh);
  const { x: rx, y: ry } = splitPoint(receiverPoint);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: b64encode(receiver.privateScalar),
      x: rx,
      y: ry,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderKey } as unknown as Parameters<
        typeof crypto.subtle.deriveBits
      >[0],
      privateKey,
      256,
    ),
  );
  const hmac = async (key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) => {
    const imported = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
  };
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const text = new TextEncoder().encode.bind(new TextEncoder());
  const keyInfo = concat(text("WebPush: info"), new Uint8Array([0]), receiverPoint, senderPublic);
  const prkKey = await hmac(b64decode(receiver.auth), secret);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (
    await hmac(prk, concat(text("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))
  ).slice(0, 16);
  const nonce = (
    await hmac(prk, concat(text("Content-Encoding: nonce"), new Uint8Array([0, 1])))
  ).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
  );
  assert(padded[padded.length - 1] === 0x02, "padding delimiter must close the record");
  return JSON.parse(Buffer.from(padded.slice(0, -1)).toString("utf8"));
}

const migrationDir = await mkdtemp(path.join(tmpdir(), "bfb-x01-migrations-"));
for (const migration of manifest.migrations.slice(0, split)) {
  await copyFile(
    path.resolve(root, "migrations/d1", migration.file),
    path.resolve(migrationDir, migration.file),
  );
}

const base = { compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"] };
const testServer = createTestHarness({
  root,
  workers: [
    {
      config: {
        ...base,
        name: "bfb-x01-a",
        main: path.resolve(root, "tools/work-records/worker.ts"),
        durable_objects: {
          bindings: [
            { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-x01-hub" },
          ],
        },
      },
    },
    {
      config: {
        ...base,
        name: "bfb-x01-hub",
        main: path.resolve(root, "apps/control-worker/src/index.ts"),
        d1_databases: [
          {
            binding: "DB",
            database_name: "bfb-x01-test",
            database_id: "00000000-0000-4000-8000-000000000a01",
            migrations_dir: migrationDir,
          },
          {
            binding: "EMPTY_DB",
            database_name: "bfb-x01-empty-test",
            database_id: "00000000-0000-4000-8000-000000000b01",
            migrations_dir: path.resolve(root, "migrations/d1"),
          },
        ],
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
        vars: {
          APP_ORIGIN: origin,
          ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
          LAUNCH_ORIGIN: "https://launch.bfb.example.test",
          JURISDICTION: "global",
          ENVIRONMENT: "local",
          VAPID_PUBLIC_KEY,
          VAPID_PRIVATE_KEY,
          VAPID_SUBJECT: "mailto:x01@synthetic.test",
          AUTH_ABUSE_SECRET: "x01-synthetic-abuse-key-9d44c2a71e60-long",
        },
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-x01-test" }],
        assets: { directory: path.resolve(root, "tools/notifications/assets"), binding: "ASSETS" },
        queues: {
          producers: [
            { binding: "JOBS", queue: "bfb-x01-jobs" },
            { binding: "JOBS_DLQ", queue: "bfb-x01-jobs-dlq" },
            { binding: "NOTIFY_JOBS", queue: "bfb-notify-local" },
            { binding: "NOTIFY_DLQ", queue: "bfb-notify-dlq-local" },
          ],
          consumers: [
            {
              queue: "bfb-notify-local",
              max_batch_size: 10,
              max_batch_timeout: 1,
              max_retries: 5,
              dead_letter_queue: "bfb-notify-dlq-local",
              retry_delay: 1,
            },
          ],
        },
      },
    },
    {
      config: {
        ...base,
        name: "bfb-x01-dlq",
        main: path.resolve(root, "tools/notifications/dlq-worker.ts"),
        vars: { HARNESS_URL: harnessUrl },
        queues: {
          producers: [],
          consumers: [{ queue: "bfb-notify-dlq-local", max_batch_size: 10, max_batch_timeout: 1 }],
        },
      },
    },
  ],
});

function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, JSON.stringify(outcome));
  return outcome.result;
}

let sequence = 0;
async function execute<T>(
  name: string,
  input: unknown,
  actor: { actorHumanId?: string; actorRunnerId?: string; authorizationEpoch?: number } = {
    actorHumanId: FIX.owner,
  },
): Promise<T> {
  const worker = testServer.getWorker("bfb-x01-a");
  const response = await worker.fetch(`${origin}/workspaces/${FIX.workspace}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandName: name,
      request: {
        workspaceId: FIX.workspace,
        idempotencyKey: `x01-${sequence++}-${Date.now()}`,
        authorizationEpoch: 1,
        now,
        ...actor,
        input,
      },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return success(await (response.json() as Promise<CommandOutcome<T>>));
}

async function human<T>(name: string, input: unknown, humanId: string = FIX.owner): Promise<T> {
  return execute<T>(name, input, { actorHumanId: humanId });
}

async function native<T>(name: string, input: unknown, runnerId: string): Promise<T> {
  return execute<T>(name, input, { actorRunnerId: runnerId });
}

async function waitFor<T>(
  label: string,
  poll: () => Promise<T | null>,
  timeoutMs = 30000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value !== null) return value;
    assert(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface HarnessEnv {
  DB: D1Like;
  EMPTY_DB: D1Like;
  NOTIFY_JOBS: { send: (body: unknown, options?: unknown) => Promise<unknown> };
}

async function hubEnv(): Promise<HarnessEnv> {
  const hub = testServer.getWorker("bfb-x01-hub");
  return (await hub.getEnv()) as unknown as HarnessEnv;
}

let lastCursor = 0;
async function dispatchNew(): Promise<Array<{ cursor: number; kind: string }>> {
  const { DB, NOTIFY_JOBS } = await hubEnv();
  const db = adaptD1(DB);
  const rows = (await db
    .prepare(
      `SELECT workspace_cursor, kind, payload_json FROM semantic_events
       WHERE workspace_id = ? AND workspace_cursor > ? ORDER BY workspace_cursor ASC LIMIT 200`,
    )
    .all(FIX.workspace, lastCursor)) as Array<{
    workspace_cursor: number;
    kind: string;
    payload_json: string;
  }>;
  const sent: Array<{ cursor: number; kind: string }> = [];
  for (const row of rows) {
    lastCursor = Math.max(lastCursor, row.workspace_cursor);
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      payload = null;
    }
    if (payload && selectNotificationEvent(row.kind, payload)) {
      await NOTIFY_JOBS.send(
        {
          schema_version: 1,
          job_id: notificationJobId(FIX.workspace, row.workspace_cursor),
          workspace_id: FIX.workspace,
          event_cursor: row.workspace_cursor,
          event_kind: row.kind,
        },
        { contentType: "json" },
      );
      sent.push({ cursor: row.workspace_cursor, kind: row.kind });
    }
  }
  record("dispatch", { sent: sent.length, kinds: sent.map((entry) => entry.kind) });
  return sent;
}

interface DeliveryRow {
  delivery_id: string;
  channel: string;
  human_id: string;
  runner_id: string | null;
  event_cursor: number;
  category: string;
  state: string;
  attempt_count: number;
  last_error: string | null;
}

async function deliveryRows(cursor: number): Promise<DeliveryRow[]> {
  const { DB } = await hubEnv();
  return (await adaptD1(DB)
    .prepare(
      `SELECT delivery_id, channel, human_id, runner_id, event_cursor, category,
              state, attempt_count, last_error
       FROM notification_deliveries WHERE workspace_id = ? AND event_cursor = ?
       ORDER BY delivery_id`,
    )
    .all(FIX.workspace, cursor)) as DeliveryRow[];
}

async function waitDeliveries(
  cursor: number,
  channel: string,
  state: string,
  count = 1,
): Promise<DeliveryRow[]> {
  return waitFor(`${count}x ${channel}/${state} for cursor ${cursor}`, async () => {
    const rows = (await deliveryRows(cursor)).filter(
      (row) => row.channel === channel && row.state === state,
    );
    return rows.length >= count ? rows : null;
  });
}

const runnerId = randomUlid();
const checkoutId = randomUlid();
const tokenId = randomUlid();
const tokenExpiresAt = new Date(Math.floor(Date.parse(now) / 1000) * 1000 + 300_000).toISOString();

const signingKey = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const signingJwk = (await crypto.subtle.exportKey("jwk", signingKey.publicKey)) as JsonWebKey;
const runnerPublicKey = await canonicalRunnerKey({
  crv: signingJwk.crv,
  kty: signingJwk.kty,
  x: signingJwk.x,
  y: signingJwk.y,
});
const keyThumbprint = runnerKeyThumbprint(runnerPublicKey);
const tokenSecret = runnerSecret();

const principal: RunnerPrincipal = {
  kind: "runner",
  workspaceId: FIX.workspace,
  runnerId,
  ownerHumanId: FIX.owner,
  authorizationEpoch: 1,
  ownerAuthorizationEpoch: 1,
  grantEpoch: 1,
  tokenEpoch: 1,
  tokenId,
  keyThumbprint,
  authExpiresAt: tokenExpiresAt,
  projectIds: [FIX.projectA],
};

const tokenClaims: RunnerTokenClaims = {
  v: 1,
  sub: runnerId,
  workspace_id: FIX.workspace,
  aud: "bfb-runner",
  iss: origin,
  jti: tokenId,
  iat: Math.floor(Date.parse(now) / 1000),
  exp: Math.floor(Date.parse(tokenExpiresAt) / 1000),
  authorization_epoch: 1,
  owner_authorization_epoch: 1,
  grant_epoch: 1,
  token_epoch: 1,
  cnf: { jkt: keyThumbprint },
};
const bearerToken = encodeRunnerToken(tokenClaims, tokenSecret);

async function signedRunner(pathSuffix: string, body: unknown) {
  const hub = testServer.getWorker("bfb-x01-hub");
  const bytes = JSON.stringify(body);
  const targetPath = `/runner/workspaces/${FIX.workspace}/runners/${runnerId}/${pathSuffix}`;
  const challengePath = `/runner/workspaces/${FIX.workspace}/runners/${runnerId}/challenge`;
  const challengeResponse = await hub.fetch(`${origin}${challengePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      purpose: "request",
      token: bearerToken,
      request: { method: "POST", path: targetPath, body_sha256: runnerHash(bytes) },
    }),
  });
  assert.equal(challengeResponse.status, 200, await challengeResponse.clone().text());
  const challenge = ((await challengeResponse.json()) as { challenge: RunnerChallenge }).challenge;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey.privateKey,
    runnerChallengeTranscript(challenge),
  );
  const proof = Buffer.from(
    JSON.stringify({
      challenge_id: challenge.challenge_id,
      server_nonce: challenge.server_nonce,
      signature: Buffer.from(signature).toString("base64url"),
      token: bearerToken,
    }),
  ).toString("base64url");
  return hub.fetch(`${origin}${targetPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bfb-runner-proof": proof },
    body: bytes,
  });
}

function checkoutEntry(id: string, worktreeHash: string, isDefault: boolean) {
  return {
    schema_version: 1,
    checkout_id: id,
    workspace_id: FIX.workspace,
    runner_id: runnerId,
    project_id: FIX.projectA,
    label: `Synthetic X01 checkout ${id.slice(0, 8)}`,
    repository_identity: "synthetic/x01",
    workspace_subpath: ".",
    physical_worktree_hash: worktreeHash,
    repository_config_hash: emptyConfig,
    is_default: isDefault,
    dirty: false,
    status: "validated",
    validated_at: now,
  };
}

function providerEntry() {
  return {
    provider: "fake",
    version: "1.0.0",
    manifest_id: digest,
    status: "healthy",
    observed_at: now,
    expires_at: new Date(Date.parse(now) + 30_000).toISOString(),
    capabilities: [
      "launch.interactive",
      "filesystem.read_only",
      "approval.never",
      "context.session_start",
      "prompt.initial_constant",
      "hooks.session_start",
      "mcp.stdio",
      "control.interrupt",
      "control.terminate",
      "session.resume",
    ],
  };
}

let inventoryRevision = 1;
const extraCheckouts: Array<{ id: string; hash: string }> = [];
async function replaceInventory(): Promise<void> {
  await native(
    "runner.inventory.replace",
    {
      principal,
      inventory: {
        schema_version: 1,
        workspace_id: FIX.workspace,
        runner_id: runnerId,
        revision: inventoryRevision,
        checkouts: [
          checkoutEntry(checkoutId, digest, true),
          ...extraCheckouts.map((entry) => checkoutEntry(entry.id, entry.hash, false)),
        ],
        providers: [providerEntry()],
      },
    },
    runnerId,
  );
}

// Each claimed run gets its own checkout: launch leases bind (runner, worktree),
// so a second launch on the same checkout is correctly rejected.
async function attachCheckout(): Promise<string> {
  const id = randomUlid();
  extraCheckouts.push({ id, hash: `sha256:${runnerHash(`x01-worktree-${id}`)}` });
  inventoryRevision += 1;
  await replaceInventory();
  return id;
}

async function registerEndpoint(humanId: string, tag: string): Promise<Receiver> {
  const receiver = await makeReceiver(tag);
  receivers.set(tag, receiver);
  const { DB } = await hubEnv();
  const hash = createHash("sha256").update(`${harnessUrl}/push/${tag}`, "utf8").digest("hex");
  await adaptD1(DB)
    .prepare(
      `INSERT INTO notification_push_endpoints
       (workspace_id, human_id, endpoint_hash, endpoint, p256dh, auth, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      humanId,
      hash,
      `${harnessUrl}/push/${tag}`,
      receiver.p256dh,
      receiver.auth,
      now,
      now,
    );
  record("endpoint_registered", { human: humanId.slice(0, 8), tag });
  return receiver;
}

async function tableCount(table: string): Promise<number> {
  const { DB } = await hubEnv();
  const row = (await adaptD1(DB)
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`)
    .get(FIX.workspace)) as { count: number };
  return row.count;
}

const policy = {
  allowedProviders: ["fake"],
  allowAgentRootPropose: false,
  allowPassToAgent: true,
  allowRunOverrides: true,
};

async function versions(runId: string, taskId: string): Promise<{ run: number; task: number }> {
  const { DB } = await hubEnv();
  const db = adaptD1(DB);
  const run = (await db
    .prepare(`SELECT resource_version FROM runs WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, runId)) as { resource_version: number };
  const task = (await db
    .prepare(`SELECT resource_version FROM tasks WHERE workspace_id = ? AND id = ?`)
    .get(FIX.workspace, taskId)) as { resource_version: number };
  return { run: run.resource_version, task: task.resource_version };
}

async function latestSubmission(runId: string): Promise<{ id: string; version: number }> {
  const { DB } = await hubEnv();
  const row = (await adaptD1(DB)
    .prepare(
      `SELECT id, version FROM result_submissions
       WHERE workspace_id = ? AND run_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(FIX.workspace, runId)) as { id: string; version: number };
  return row;
}

interface ClaimedRun {
  taskId: string;
  launchId: string;
  runId: string;
  executionId: string;
  generation: number;
}

let runSequence = 0;
async function newClaimedRun(title: string): Promise<ClaimedRun> {
  runSequence += 1;
  const task = await human<{ id: string }>("task.create", {
    projectId: FIX.projectA,
    title,
    priority: "P2",
  });
  const profile = await human<{ id: string }>("agent_profile.create", {
    name: `Synthetic X01 provider ${runSequence} ${title.length}`,
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const runCheckoutId = runSequence === 1 ? checkoutId : await attachCheckout();
  const launch = await human<{ launch_id: string }>("launch.start", {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: task.id,
    expected_task_version: 1,
    runner_id: runnerId,
    checkout_id: runCheckoutId,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  });
  const claimed = await native<{
    state: string;
    claim: {
      specification: { run_id: string; run_execution_id: string; assignment_generation: number };
    };
  }>(
    "launch.claim",
    {
      principal,
      claim: {
        schema_version: 1,
        launch_id: launch.launch_id,
        runner_id: runnerId,
        idempotency_key: randomUlid(),
        claimed_at: now,
      },
    },
    runnerId,
  );
  assert.equal(claimed.state, "claimed");
  return {
    taskId: task.id,
    launchId: launch.launch_id,
    runId: claimed.claim.specification.run_id,
    executionId: claimed.claim.specification.run_execution_id,
    generation: claimed.claim.specification.assignment_generation,
  };
}

function scanClean(label: string, values: string[]): void {
  for (const value of values) {
    for (const canary of CANARIES) {
      assert(
        !value.includes(canary),
        `${label} leaks prohibited content ${JSON.stringify(canary)}`,
      );
    }
  }
  record("redaction_scan", { label, checked: values.length });
}

try {
  await testServer.listen();
  const hub = testServer.getWorker("bfb-x01-hub");
  await hub.applyD1Migrations("EMPTY_DB");
  await hub.applyD1Migrations("DB");

  // S1: X01 migration is registered and applies over populated state.
  {
    assert(
      manifest.migrations.some((entry) => entry.id === "0030_notifications"),
      "X01 notification migration must be registered",
    );
    const empty = adaptD1((await hubEnv()).EMPTY_DB);
    for (const table of [
      "notification_preferences",
      "notification_push_endpoints",
      "notification_deliveries",
      "notification_macos_inbox",
      "notification_dispatch_state",
    ]) {
      const row = (await empty
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table)) as { name: string } | undefined;
      assert(row?.name === table, `EMPTY_DB lacks ${table}; 0030 is not applied`);
    }
    assert.deepEqual(await empty.prepare("PRAGMA foreign_key_check").all(), []);
    record("migration_ok", { migration: "0030_notifications" });
    console.log("X01_MIGRATION_OK 0030 registered and applied on a fresh database");
  }

  const db = adaptD1((await hubEnv()).DB);
  await seedSyntheticWorkspace(db, now, "global");
  const preserved = await human<{ id: string }>("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic X01 migration preservation",
    priority: "P2",
  });
  for (const migration of manifest.migrations.slice(split)) {
    await copyFile(
      path.resolve(root, "migrations/d1", migration.file),
      path.resolve(migrationDir, migration.file),
    );
  }
  await hub.applyD1Migrations("DB");
  {
    const again = adaptD1((await hubEnv()).DB);
    const row = (await again
      .prepare(`SELECT id FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, preserved.id)) as { id: string } | undefined;
    assert(row?.id === preserved.id, "0030 must preserve pre-existing work history");
    const tables = (await again
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'notification_%'`)
      .all()) as Array<{ name: string }>;
    assert(tables.length === 5, `0030 must create five tables, saw ${tables.length}`);
    assert.deepEqual(await again.prepare("PRAGMA foreign_key_check").all(), []);
    record("migration_upgrade_ok", { preserved_task: row?.id === preserved.id });
    console.log("X01_MIGRATION_UPGRADE_OK populated state upgrades to 0030 intact");
  }

  // S2: seed the notification world.
  await human("workspace.policy.update", { ...policy, expectedVersion: 1 });
  await human("project.policy.update", { ...policy, projectId: FIX.projectA, expectedVersion: 1 });
  await human("repository.config.report", {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: emptyConfig,
  });
  {
    const { DB } = await hubEnv();
    const seed = adaptD1(DB);
    await seed
      .prepare(
        `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
         VALUES (?, ?, ?, 'Synthetic X01 Mac', ?, ?, 1, ?)`,
      )
      .run(FIX.workspace, runnerId, FIX.owner, JSON.stringify(runnerPublicKey), keyThumbprint, now);
    await seed
      .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
      .run(FIX.workspace, runnerId, FIX.projectA);
    await seed
      .prepare(
        `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
      )
      .run(FIX.workspace, runnerId, FIX.owner, now);
    await seed
      .prepare(
        `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        FIX.workspace,
        runnerId,
        tokenId,
        runnerHash(tokenSecret),
        JSON.stringify(tokenClaims),
        tokenExpiresAt,
      );
    record("runner_seeded", {});
  }
  await replaceInventory();
  const ownerReceiver = await registerEndpoint(FIX.owner, "owner");
  const memberReceiver = await registerEndpoint(FIX.member, "member");
  await human("notification.preference.set", {
    channel: "browser_push",
    category: "result_changes_requested",
    enabled: true,
  });
  await human(
    "notification.preference.set",
    { channel: "macos", category: "result_changes_requested", enabled: true },
    FIX.member,
  );
  record("preferences_seeded", {});
  console.log("X01_SEED_OK runner, endpoints, and preferences committed over real D1");

  // S3: attention requested notifies push endpoints and the macOS inbox.
  const runA = await newClaimedRun(`Synthetic X01 attention ${CANARIES[0]}`);
  await native(
    "attention.request",
    {
      principal,
      runId: runA.runId,
      executionId: runA.executionId,
      assignmentGeneration: runA.generation,
      kind: "clarification",
      question: `Synthetic X01 question ${CANARIES[0]} ${CANARIES[1]}`,
      blocking: true,
    },
    runnerId,
  );
  const attentionSent = await dispatchNew();
  assert.equal(attentionSent.length, 1);
  assert.equal(attentionSent[0]?.kind, "attention.request");
  const attentionCursor = attentionSent[0]?.cursor ?? 0;
  const pushBefore = pushPosts.length;
  await waitDeliveries(attentionCursor, "browser_push", "delivered", 2);
  await waitDeliveries(attentionCursor, "macos", "delivered", 1);
  assert.equal(pushPosts.length, pushBefore + 2, "one POST per push endpoint");
  const ownerPost = pushPosts.find((post) => post.path === "/push/owner");
  assert(ownerPost, "owner endpoint must receive exactly one POST");
  assert.equal(ownerPost.contentEncoding, "aes128gcm");
  assert.match(ownerPost.authorization, /^vapid t=[^,]+, k=[A-Za-z0-9_-]+$/);
  const ownerPayload = (await decryptPush(ownerReceiver, ownerPost.body)) as {
    title: string;
    body: string;
    deep_link: string;
    delivery_id: string;
    event_cursor: number;
  };
  assert.equal(ownerPayload.title, "BFB needs your attention");
  assert.equal(ownerPayload.body, "Open BFB to review the next step.");
  assert.match(
    ownerPayload.deep_link,
    new RegExp(`^${origin}/w/${FIX.workspace}/tasks/[0-9A-Z]{26}/attention/[0-9A-Z]{26}$`),
  );
  assert.equal(ownerPayload.event_cursor, attentionCursor);
  scanClean("push_payload", [JSON.stringify(ownerPayload), ownerPayload.deep_link]);
  record("attention_delivered", {
    cursor: attentionCursor,
    deep_link_shape: "w/tasks/attention",
  });
  // macOS pull/ack over the signed runner transport carries opaque IDs only.
  {
    const naked = await hub.fetch(
      `${origin}/runner/workspaces/${FIX.workspace}/runners/${runnerId}/notifications/pull`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.equal(naked.status, 403);
    const pulled = await signedRunner("notifications/pull", {});
    assert.equal(pulled.status, 200, await pulled.clone().text());
    const items = ((await pulled.json()) as { deliveries: Array<{ delivery_id: string }> })
      .deliveries;
    assert.equal(items.length, 1);
    assert.match(items[0]?.delivery_id ?? "", /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    const acked = await signedRunner("notifications/ack", {
      delivery_ids: [items[0]?.delivery_id],
    });
    assert.equal(acked.status, 200);
    assert.equal(((await acked.json()) as { acked: number }).acked, 1);
    const empty = await signedRunner("notifications/pull", {});
    assert.deepEqual(((await empty.json()) as { deliveries: unknown[] }).deliveries, []);
    record("macos_pull_ack", { deliveries: 1 });
  }
  // Duplicate queue delivery converges: resend the same message, no second POST.
  {
    const { NOTIFY_JOBS } = await hubEnv();
    await NOTIFY_JOBS.send(
      {
        schema_version: 1,
        job_id: notificationJobId(FIX.workspace, attentionCursor),
        workspace_id: FIX.workspace,
        event_cursor: attentionCursor,
        event_kind: "attention.request",
      },
      { contentType: "json" },
    );
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal(pushPosts.length, pushBefore + 2, "duplicate delivery must not re-POST");
    assert.equal((await deliveryRows(attentionCursor)).length, 3);
    record("duplicate_converged", { cursor: attentionCursor });
  }
  console.log("X01_ATTENTION_OK push, macos, pull/ack, and duplicate convergence");

  // S4: each retained A03 transition notifies per preferences.
  const runB = await newClaimedRun("Synthetic X01 review flow");
  await native(
    "result.submit",
    { runId: runB.runId, summary: `Synthetic X01 summary ${CANARIES[2]} ${CANARIES[3]}` },
    runnerId,
  );
  const submitBefore = pushPosts.length;
  const submitted = await dispatchNew();
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.kind, "result.submit");
  await waitDeliveries(submitted[0]?.cursor ?? 0, "browser_push", "delivered", 2);
  {
    const rows = await deliveryRows(submitted[0]?.cursor ?? 0);
    assert(rows.every((row) => row.category === "result_submitted"));
    const memberPost = pushPosts.slice(submitBefore).find((post) => post.path === "/push/member");
    assert(memberPost, "member endpoint must receive the review request");
    const payload = (await decryptPush(memberReceiver, memberPost.body)) as { deep_link: string };
    assert.match(
      payload.deep_link,
      new RegExp(`^${origin}/w/${FIX.workspace}/tasks/[0-9A-Z]{26}/runs/[0-9A-Z]{26}/results/1$`),
    );
    scanClean("review_payload", [JSON.stringify(payload), payload.deep_link]);
    record("result_submitted", { cursor: submitted[0]?.cursor });
  }
  {
    const current = await versions(runB.runId, runB.taskId);
    const submission = await latestSubmission(runB.runId);
    await human("result.accept", {
      runId: runB.runId,
      submissionId: submission.id,
      expectedRunVersion: current.run,
      expectedTaskVersion: current.task,
    });
    const accepted = await dispatchNew();
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.kind, "result.accept");
    await waitDeliveries(accepted[0]?.cursor ?? 0, "browser_push", "delivered", 2);
    record("result_accepted", { cursor: accepted[0]?.cursor });
  }
  const runC = await newClaimedRun("Synthetic X01 failure flow");
  {
    const current = await versions(runC.runId, runC.taskId);
    await human("result.fail", { runId: runC.runId, expectedRunVersion: current.run });
  }
  const failed = await dispatchNew();
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.kind, "result.fail");
  await waitDeliveries(failed[0]?.cursor ?? 0, "browser_push", "delivered", 2);
  record("run_failed", { cursor: failed[0]?.cursor });
  const runD = await newClaimedRun("Synthetic X01 changes flow");
  await native(
    "result.submit",
    { runId: runD.runId, summary: "Synthetic X01 changes summary" },
    runnerId,
  );
  await dispatchNew();
  {
    const current = await versions(runD.runId, runD.taskId);
    const submission = await latestSubmission(runD.runId);
    await human("result.request_changes", {
      runId: runD.runId,
      submissionId: submission.id,
      expectedRunVersion: current.run,
      expectedTaskVersion: current.task,
      comment: "Synthetic X01 changes comment",
    });
  }
  const changed = await dispatchNew();
  assert.equal(changed.length, 1);
  assert.equal(changed[0]?.kind, "result.request_changes");
  const changedRows = await waitDeliveries(changed[0]?.cursor ?? 0, "browser_push", "delivered", 1);
  assert.equal(changedRows[0]?.human_id, FIX.owner, "member stays opted out of changes");
  record("changes_requested", { cursor: changed[0]?.cursor });
  const runE = await newClaimedRun("Synthetic X01 cancel flow");
  {
    const current = await versions(runE.runId, runE.taskId);
    await human("result.cancel", { runId: runE.runId, expectedRunVersion: current.run });
  }
  const cancelled = await dispatchNew();
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]?.kind, "result.cancel");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  assert.equal(
    (await deliveryRows(cancelled[0]?.cursor ?? 0)).length,
    0,
    "cancelled stays off by default",
  );
  record("run_cancelled_default_off", { cursor: cancelled[0]?.cursor });
  console.log("X01_RESULTS_OK submit, accept, fail, changes, and cancelled defaults");

  // S5: launch blocked notifies with a run deep link.
  const runF = await newClaimedRun("Synthetic X01 blocked flow");
  await native(
    "launch.reject",
    {
      principal,
      launchId: runF.launchId,
      executionId: runF.executionId,
      assignmentGeneration: runF.generation,
    },
    runnerId,
  );
  const blocked = await dispatchNew();
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.kind, "launch.reject");
  await waitDeliveries(blocked[0]?.cursor ?? 0, "browser_push", "delivered", 2);
  {
    const rows = await deliveryRows(blocked[0]?.cursor ?? 0);
    assert(rows.every((row) => row.category === "launch_blocked"));
    record("launch_blocked", { cursor: blocked[0]?.cursor });
  }
  console.log("X01_BLOCKED_OK launch rejection notifies");

  // S6: ordinary telemetry never notifies, and unknown kinds ack cleanly.
  {
    const stream = randomUlid();
    const ingest = await native(
      "event.ingest",
      {
        principal,
        events: ["heartbeat", "turn_started", "tool_started", "progress_reported"].map(
          (kind, index) => ({
            schema_version: 1,
            event_id: randomUlid(),
            source_stream_id: stream,
            source_sequence: index + 1,
            run_execution_id: runF.executionId,
            assignment_generation: runF.generation,
            kind,
            occurred_at: now,
            capture_origin: "runner_observed",
            payload: {},
          }),
        ),
      },
      runnerId,
    );
    const dispositions = (ingest as { dispositions: Array<{ disposition: string }> }).dispositions;
    assert(dispositions.every((entry) => entry.disposition === "accepted"));
    const telemetry = await dispatchNew();
    assert.equal(telemetry.length, 0, "telemetry must not dispatch");
    const { NOTIFY_JOBS } = await hubEnv();
    const taskCursorRow = (await adaptD1((await hubEnv()).DB)
      .prepare(
        `SELECT workspace_cursor FROM semantic_events
         WHERE workspace_id = ? AND kind = 'task.create' ORDER BY workspace_cursor DESC LIMIT 1`,
      )
      .get(FIX.workspace)) as { workspace_cursor: number };
    await NOTIFY_JOBS.send(
      {
        schema_version: 1,
        job_id: notificationJobId(FIX.workspace, taskCursorRow.workspace_cursor),
        workspace_id: FIX.workspace,
        event_cursor: taskCursorRow.workspace_cursor,
        event_kind: "task.create",
      },
      { contentType: "json" },
    );
    await new Promise((resolve) => setTimeout(resolve, 4000));
    assert.equal((await deliveryRows(taskCursorRow.workspace_cursor)).length, 0);
    record("telemetry_suppressed", {});
  }
  console.log("X01_TELEMETRY_OK heartbeats, turns, tools, and progress stay silent");

  // S7: revoked members never notify, and hygiene purges their state.
  await human("workspace.member.remove", { humanId: FIX.member });
  const runG = await newClaimedRun("Synthetic X01 post-revocation flow");
  await native(
    "attention.request",
    {
      principal,
      runId: runG.runId,
      executionId: runG.executionId,
      assignmentGeneration: runG.generation,
      kind: "blocker",
      question: "Synthetic X01 post-revocation question",
      blocking: true,
    },
    runnerId,
  );
  const revoked = await dispatchNew();
  assert.equal(revoked.length, 1);
  await waitDeliveries(revoked[0]?.cursor ?? 0, "browser_push", "delivered", 1);
  {
    const rows = await deliveryRows(revoked[0]?.cursor ?? 0);
    assert(
      rows.every((row) => row.human_id !== FIX.member),
      "revoked member must have no rows",
    );
    const purged = await purgeRevokedNotificationState(adaptD1((await hubEnv()).DB), FIX.workspace);
    assert(purged.endpoints >= 1 && purged.preferences >= 1);
    assert.equal(await tableCount("notification_push_endpoints"), 1, "owner endpoint survives");
    record("revocation_ok", { purged });
  }
  console.log("X01_REVOCATION_OK removed members are excluded and purged");

  // S8: failing endpoints retry into visible DLQ state without blocking commands.
  pushBehaviors.set("/push/owner", { status: 500 });
  const runH = await newClaimedRun("Synthetic X01 poison flow");
  await native(
    "attention.request",
    {
      principal,
      runId: runH.runId,
      executionId: runH.executionId,
      assignmentGeneration: runH.generation,
      kind: "blocker",
      question: "Synthetic X01 poison question",
      blocking: true,
    },
    runnerId,
  );
  const poison = await dispatchNew();
  assert.equal(poison.length, 1);
  const poisonCursor = poison[0]?.cursor ?? 0;
  const ownerPostsBefore = pushPosts.filter((post) => post.path === "/push/owner").length;
  const poisoned = await waitDeliveries(poisonCursor, "browser_push", "dead_lettered", 1);
  assert(poisoned[0]?.last_error?.includes("push_status_500"));
  assert((poisoned[0]?.attempt_count ?? 0) >= 4, "retries must be visible before dead-lettering");
  const ownerPostsAfter = pushPosts.filter((post) => post.path === "/push/owner").length;
  assert.equal(ownerPostsAfter - ownerPostsBefore, 5, "exactly the queue budget is attempted");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(
    pushPosts.filter((post) => post.path === "/push/owner").length,
    ownerPostsAfter,
    "dead-lettered deliveries stop retrying",
  );
  const dlqCopy = await waitFor("dlq diagnostic copy", async () =>
    dlqCopies.length > 0 ? dlqCopies : null,
  );
  assert.equal(dlqCopy.length, 1);
  scanClean("dlq_copy", [JSON.stringify(dlqCopy[0])]);
  assert(!JSON.stringify(dlqCopy[0]).includes("127.0.0.1"), "DLQ copies carry IDs, not endpoints");
  record("poison_dlq", { cursor: poisonCursor, attempts: poisoned[0]?.attempt_count });
  // Product commands keep working through the poison storm.
  await human("task.create", {
    projectId: FIX.projectA,
    title: "Synthetic X01 storm task",
    priority: "P2",
  });
  console.log("X01_DLQ_OK poison retries exhaust into visible DLQ state");

  // S9: expired endpoints are deleted instead of retried.
  pushBehaviors.set("/push/owner", { status: 410 });
  const runI = await newClaimedRun("Synthetic X01 expired flow");
  await native(
    "attention.request",
    {
      principal,
      runId: runI.runId,
      executionId: runI.executionId,
      assignmentGeneration: runI.generation,
      kind: "blocker",
      question: "Synthetic X01 expired question",
      blocking: true,
    },
    runnerId,
  );
  const expired = await dispatchNew();
  assert.equal(expired.length, 1);
  const expiredRows = await waitDeliveries(expired[0]?.cursor ?? 0, "browser_push", "failed", 1);
  assert(expiredRows[0]?.last_error?.includes("endpoint_expired"));
  assert.equal(await tableCount("notification_push_endpoints"), 0, "gone endpoint is deleted");
  record("endpoint_expired", { cursor: expired[0]?.cursor });
  console.log("X01_EXPIRED_OK gone endpoints delete without retry");

  // S10: nothing emitted carries task text, paths, tokens, commands, or arguments.
  {
    const decrypted: string[] = [];
    for (const post of pushPosts) {
      const tag = post.path.replace("/push/", "");
      const receiver = receivers.get(tag);
      assert(receiver, `unknown push tag ${tag}`);
      decrypted.push(JSON.stringify(await decryptPush(receiver, post.body)));
    }
    const { DB } = await hubEnv();
    const links = (await adaptD1(DB)
      .prepare(`SELECT delivery_id FROM notification_deliveries WHERE workspace_id = ?`)
      .all(FIX.workspace)) as Array<{ delivery_id: string }>;
    scanClean("all_push_bodies", decrypted);
    scanClean(
      "all_dlq_copies",
      dlqCopies.map((copy) => JSON.stringify(copy)),
    );
    scanClean("recording", recording);
    assert(links.length > 10, "evidence must cover a meaningful delivery population");
    record("redaction_ok", { deliveries: links.length, push_posts: decrypted.length });
  }
  console.log("X01_REDACTION_OK no prohibited content in payloads, links, or DLQ copies");

  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    path.resolve(evidenceDir, "recording.jsonl"),
    `${recording.join("\n")}\n`,
    "utf8",
  );
  record("harness_complete", {});
  console.log("X01_HARNESS_OK all notification scenarios passed");
} catch (error) {
  recording.push(JSON.stringify({ event: "harness_failed", error: String(error).slice(0, 500) }));
  try {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(
      path.resolve(evidenceDir, "recording.jsonl"),
      `${recording.join("\n")}\n`,
      "utf8",
    );
  } catch {
    // Evidence best-effort on failure; the thrown error stays authoritative.
  }
  throw error;
} finally {
  server.close();
  await testServer.close();
}
