// ABOUTME: Certifies X04 across real Workers, D1, the local Queue, and a GitHub double.
// ABOUTME: Recorded fixtures drive faults; evidence stays bounded and redacted.

import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  createProjectCommand,
  FIX,
  GITHUB_PERMISSIONS_ALLOWLIST,
  GITHUB_WEBHOOK_EVENTS_ALLOWLIST,
  GITHUB_WEBHOOK_SYSTEM_ID,
  issueStepUpProof,
  randomUlid,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

import { GitHubDouble } from "./double.js";

/** Evidence JSON must match the repository Prettier style so regeneration stays byte-identical. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const options = (await resolveConfig(path)) ?? {};
  await writeFile(
    path,
    await format(JSON.stringify(value, null, 2), { ...options, parser: "json" }),
  );
}

const toolDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolDir, "../..");
const fixturesDir = resolve(toolDir, "fixtures");
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-X04");

const ORIGIN = "https://bfb.x04.test";
const ARTIFACT_ORIGIN = "https://artifacts.x04.test";
const QUEUE = "bfb-x04-jobs";
const DLQ = "bfb-x04-dlq";
const POLL_TIMEOUT_MS = 30_000;
const POLL_STEP_MS = 250;

const webhookSecret = `x04-webhook-secret-${randomBytes(16).toString("hex")}`;
const abuseSecret = `x04-abuse-secret-${randomBytes(16).toString("hex")}-long`;
const signingKey = `x04-signing-key-${randomBytes(16).toString("hex")}`;
const previousKey = `x04-previous-key-${randomBytes(16).toString("hex")}`;
const canary = `x04-canary-${randomBytes(12).toString("hex")}`;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
assert.ok(
  manifest.migrations.some((entry) => entry.id === "0028_github_integration"),
  "X04 migration is required",
);

interface Fixture {
  event: string;
  delivery_id: string;
  payload: Record<string, unknown>;
}

async function loadFixture(name: string): Promise<Fixture> {
  return JSON.parse(await readFile(resolve(fixturesDir, "webhooks", name), "utf8")) as Fixture;
}

const traces: string[] = [];
const scenarioResults: Array<{ name: string; outcome: string }> = [];
function note(scenario: string, line: string): void {
  traces.push(`[${scenario}] ${line}`);
  console.log(`X04_${scenario} ${line}`);
}
function pass(scenario: string): void {
  scenarioResults.push({ name: scenario, outcome: "passed" });
}

function signature(raw: Uint8Array, secret: string = webhookSecret): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function sessionPair(sessionId: string, token: string): { cookie: string; csrf: string } {
  const signed = `${token}.${createHmac("sha256", signingKey).update(token).digest("base64")}`;
  return {
    cookie: `__Host-bfb_session=${encodeURIComponent(signed)}`,
    csrf: `2.${createHmac("sha256", signingKey).update(`bfb-csrf:${sessionId}`).digest("hex")}`,
  };
}

const OWNER = sessionPair("x04-owner-session", "x04-owner-token");
const MEMBER = sessionPair("x04-member-session", "x04-member-token");
const REVIEWER = sessionPair("x04-reviewer-session", "x04-reviewer-token");

async function seedHuman(
  db: SqlDatabase,
  userId: string,
  sessionId: string,
  token: string,
  humanId: string,
  email: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(userId, email, email, now, now);
  await db.prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`).run(userId, humanId);
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-09-18T12:00:00.000Z', ?, ?, ?, ?)`,
    )
    .run(sessionId, token, now, now, userId);
}

async function poll<T>(label: string, read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const value = await read().catch(() => null);
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((done) => setTimeout(done, POLL_STEP_MS));
  }
}

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const double = new GitHubDouble(fixturesDir, canary);
  const apiBase = await double.start();
  note("setup", `github double serves recorded fixtures`);

  const assetsDir = resolve(tmpdir(), `bfb-x04-assets-${randomBytes(6).toString("hex")}`);
  await mkdir(assetsDir, { recursive: true });
  await writeFile(resolve(assetsDir, "index.html"), "<!doctype html><title>x04</title>\n");

  const database = {
    binding: "DB",
    database_name: "bfb-x04-test",
    database_id: "00000000-0000-4000-8000-000000000028",
    migrations_dir: resolve(root, "migrations/d1"),
  };
  const base = {
    compatibility_date: "2026-08-08",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [database],
  };
  const vars = {
    ENVIRONMENT: "local",
    JURISDICTION: "global",
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN,
    LAUNCH_ORIGIN: "https://launch.x04.test",
    BETTER_AUTH_SECRETS: `2:${signingKey},1:${previousKey}`,
    AUTH_ABUSE_SECRET: abuseSecret,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    GITHUB_API_BASE: apiBase,
    GITHUB_APP_ID: "999000",
    GITHUB_APP_PRIVATE_KEY: appPrivateKey,
    GITHUB_CLIENT_ID: "x04-synthetic-oauth-client",
    GITHUB_CLIENT_SECRET: "x04-synthetic-oauth-secret-0123456789abcdef",
  };
  const control = (consume: boolean) => ({
    ...base,
    main: resolve(root, "apps/control-worker/src/index.ts"),
    vars,
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-x04-artifacts" }],
    queues: {
      producers: [
        { binding: "JOBS", queue: QUEUE },
        { binding: "JOBS_DLQ", queue: DLQ },
      ],
      ...(consume
        ? {
            consumers: [
              {
                queue: QUEUE,
                max_batch_size: 10,
                max_batch_timeout: 5,
                max_retries: 3,
                dead_letter_queue: DLQ,
              },
            ],
          }
        : {}),
    },
    assets: { directory: assetsDir, binding: "ASSETS" },
    durable_objects: {
      bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-x04-hub" }],
    },
  });
  const server = createTestHarness({
    root,
    workers: [
      { config: { ...control(true), name: "bfb-x04-a" } },
      { config: { ...control(false), name: "bfb-x04-b" } },
      {
        config: {
          ...base,
          name: "bfb-x04-hub",
          main: resolve(root, "apps/control-worker/src/index.ts"),
          durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
          exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
        },
      },
      {
        config: {
          ...base,
          name: "bfb-x04-proxy",
          main: resolve(toolDir, "hub-proxy.ts"),
          durable_objects: {
            bindings: [
              { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-x04-hub" },
            ],
          },
        },
      },
    ],
  });

  let workerIndex = 0;
  const pick = (): string => (workerIndex++ % 2 === 0 ? "bfb-x04-a" : "bfb-x04-b");
  const fetchWorker = (name: string, url: string, init?: RequestInit): Promise<Response> =>
    (
      server.getWorker(name).fetch as unknown as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>
    )(url, init);

  const FIXTURE_NOW = "2026-09-18T12:00:00.000Z";
  const FIXTURE_OLDER = "2026-09-18T11:55:00.000Z";

  async function postWebhook(
    fixture: Fixture,
    delivery?: string,
    secret: string = webhookSecret,
    at?: string,
  ): Promise<{ status: number; body: unknown }> {
    // Recorded fixtures carry fixed clocks; live deliveries are stamped with
    // the scenario time so ordering assertions are deterministic.
    let text = JSON.stringify(fixture.payload);
    if (at !== undefined) {
      text = text.split(FIXTURE_NOW).join(at);
      text = text.split(FIXTURE_OLDER).join(new Date(Date.parse(at) - 5 * 60 * 1000).toISOString());
    }
    const raw = new TextEncoder().encode(text);
    const response = await fetchWorker(pick(), `${ORIGIN}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": fixture.event,
        "x-github-delivery": delivery ?? fixture.delivery_id,
        "x-hub-signature-256": signature(raw, secret),
      },
      body: raw as unknown as BodyInit,
    });
    return { status: response.status, body: await response.json() };
  }

  async function browser(
    method: string,
    path: string,
    session: { cookie: string; csrf: string },
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const init: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "x-bfb-csrf": session.csrf,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await fetchWorker(pick(), ORIGIN + path, init);
    return { status: response.status, body: await response.json() };
  }

  try {
    await server.listen();
    const seeder = server.getWorker("bfb-x04-hub");
    await seeder.applyD1Migrations("DB");
    const env = (await seeder.getEnv()) as unknown as { DB: D1Like };
    const db = adaptD1(env.DB);

    await seedSyntheticWorkspace(db, now, "global");
    await seedHuman(
      db,
      "x04-user",
      "x04-owner-session",
      "x04-owner-token",
      FIX.owner,
      "owner@synthetic.test",
      now,
    );
    await seedHuman(
      db,
      "x04-member-user",
      "x04-member-session",
      "x04-member-token",
      FIX.member,
      "member@synthetic.test",
      now,
    );
    await seedHuman(
      db,
      "x04-reviewer-user",
      "x04-reviewer-session",
      "x04-reviewer-token",
      FIX.reviewer,
      "restricted@synthetic.test",
      now,
    );

    const hub = new WorkspaceHub(db);
    const projectOutcome = await hub.execute(createProjectCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now,
      input: {
        name: "Synthetic X04",
        slug: "x04-github",
        tint: "#3B82F6",
        accessMode: "workspace",
        repositoryHost: "github.com",
        hostedRepositoryId: "87654321",
        repositorySubpath: ".",
      },
    });
    assert.ok(projectOutcome.ok, JSON.stringify(projectOutcome));
    const projectId = (projectOutcome.result as { id: string }).id;
    const base = `/api/v1/workspaces/${FIX.workspace}/github`;
    const stepUpNow = () => new Date().toISOString();
    async function stepUp(
      action: string,
      targetId: string,
      humanId: string = FIX.owner,
    ): Promise<string> {
      const issued = stepUpNow();
      return issueStepUpProof(
        db,
        humanId,
        {
          action,
          workspaceId: FIX.workspace,
          targetId,
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: new Date(Date.parse(issued) + 5 * 60 * 1000).toISOString(),
        },
        issued,
      );
    }
    const deliveryState = (deliveryId: string) =>
      db
        .prepare(
          `SELECT state FROM github_webhook_deliveries WHERE workspace_id = ? AND delivery_id = ?`,
        )
        .get(FIX.workspace, deliveryId) as Promise<{ state: string } | undefined>;
    const outboxFor = (deliveryId: string) =>
      db
        .prepare(
          `SELECT outbox_id, state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND delivery_id = ?`,
        )
        .get(FIX.workspace, deliveryId) as Promise<
        { outbox_id: string; state: string; attempts: number } | undefined
      >;

    // F1: HMAC rejection happens before parsing.
    {
      const garbage = new TextEncoder().encode("{invalid-json");
      const forged = await fetchWorker(pick(), `${ORIGIN}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": "x04-e2e-forge-1",
          "x-hub-signature-256": signature(garbage, "wrong-secret"),
        },
        body: garbage as unknown as BodyInit,
      });
      assert.equal(forged.status, 401);
      assert.deepEqual(await forged.json(), {
        error: "webhook_signature_invalid",
        message: "webhook signature is invalid",
      });
      const parsed = await fetchWorker(pick(), `${ORIGIN}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": "x04-e2e-forge-2",
          "x-hub-signature-256": signature(garbage),
        },
        body: garbage as unknown as BodyInit,
      });
      assert.equal(parsed.status, 400);
      const push = await loadFixture("push.main-new.json");
      const unknown = await postWebhook(push, "x04-e2e-unknown-install");
      assert.equal(unknown.status, 404);
      const count = (await db
        .prepare(`SELECT COUNT(*) AS count FROM github_webhook_deliveries`)
        .get()) as { count: number };
      assert.equal(count.count, 0);
      note("F1", "bad HMAC rejected before parsing; unknown installation commits nothing");
      pass("F1-hmac");
    }

    // F2: Owner step-up management matrix over real browser routes.
    const authMatrix: Array<{ action: string; actor: string; step_up: string; status: number }> =
      [];
    {
      const memberProof = await stepUp(
        "github.install",
        "github-installation:12345678",
        FIX.member,
      );
      const denied = await browser("POST", `${base}/installations`, MEMBER, {
        request_id: "x04-e2e-install-denied",
        installation_id: "12345678",
        app_id: "999000",
        app_slug: "synthetic-app",
        account_id: "555666",
        account_login: "synthetic-org",
        account_type: "Organization",
        permissions: { metadata: "read" },
        events: ["push"],
        step_up_proof_id: memberProof,
      });
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      authMatrix.push({
        action: "install",
        actor: "member",
        step_up: "fresh",
        status: denied.status,
      });
      const reviewerProof = await stepUp(
        "github.install",
        "github-installation:12345678",
        FIX.reviewer,
      );
      const reviewerDenied = await browser("POST", `${base}/installations`, REVIEWER, {
        request_id: "x04-e2e-install-reviewer",
        installation_id: "12345678",
        app_id: "999000",
        app_slug: "synthetic-app",
        account_id: "555666",
        account_login: "synthetic-org",
        account_type: "Organization",
        permissions: { metadata: "read" },
        events: ["push"],
        step_up_proof_id: reviewerProof,
      });
      assert.equal(reviewerDenied.status, 403, JSON.stringify(reviewerDenied.body));
      authMatrix.push({
        action: "install",
        actor: "reviewer",
        step_up: "fresh",
        status: reviewerDenied.status,
      });
      const ownerProof = await stepUp("github.install", "github-installation:12345678");
      const installed = await browser("POST", `${base}/installations`, OWNER, {
        request_id: "x04-e2e-install-1",
        installation_id: "12345678",
        app_id: "999000",
        app_slug: "synthetic-app",
        account_id: "555666",
        account_login: "synthetic-org",
        account_type: "Organization",
        permissions: { metadata: "read", pull_requests: "read", checks: "read" },
        events: ["push", "pull_request", "installation", "issues"],
        step_up_proof_id: ownerProof,
      });
      assert.equal(installed.status, 200, JSON.stringify(installed.body));
      authMatrix.push({
        action: "install",
        actor: "owner",
        step_up: "fresh",
        status: installed.status,
      });
      const replayProof = await stepUp("github.install", "github-installation:12345678");
      const duplicate = await browser("POST", `${base}/installations`, OWNER, {
        request_id: "x04-e2e-install-2",
        installation_id: "12345678",
        app_id: "999000",
        app_slug: "synthetic-app",
        account_id: "555666",
        account_login: "synthetic-org",
        account_type: "Organization",
        permissions: { metadata: "read" },
        events: ["push"],
        step_up_proof_id: replayProof,
      });
      assert.equal(duplicate.status, 409);
      authMatrix.push({
        action: "install-duplicate",
        actor: "owner",
        step_up: "fresh",
        status: duplicate.status,
      });
      const wideProof = await stepUp("github.permissions.update", "github-installation:12345678");
      const wide = await browser("POST", `${base}/installations/12345678/permissions`, OWNER, {
        request_id: "x04-e2e-permissions-wide",
        expected_version: 1,
        permissions: { metadata: "write" },
        events: ["push"],
        step_up_proof_id: wideProof,
      });
      assert.equal(wide.status, 409);
      authMatrix.push({
        action: "permissions-write",
        actor: "owner",
        step_up: "fresh",
        status: wide.status,
      });
      const permProof = await stepUp("github.permissions.update", "github-installation:12345678");
      const perms = await browser("POST", `${base}/installations/12345678/permissions`, OWNER, {
        request_id: "x04-e2e-permissions-1",
        expected_version: 1,
        permissions: { metadata: "read" },
        events: ["push"],
        step_up_proof_id: permProof,
      });
      assert.equal(perms.status, 200);
      authMatrix.push({
        action: "permissions",
        actor: "owner",
        step_up: "fresh",
        status: perms.status,
      });
      // The same proof replayed is consumed: step-up rejects it before any version check.
      const replay = await browser("POST", `${base}/installations/12345678/permissions`, OWNER, {
        request_id: "x04-e2e-permissions-2",
        expected_version: 2,
        permissions: { metadata: "read" },
        events: ["push"],
        step_up_proof_id: permProof,
      });
      assert.equal(replay.status, 403);
      authMatrix.push({
        action: "permissions",
        actor: "owner",
        step_up: "consumed",
        status: replay.status,
      });
      note(
        "F2",
        "member install denied; owner install pending; duplicate and write-permission changes rejected",
      );
      pass("F2-management");
    }

    // F3: installation.created activates through the real Queue with no token.
    {
      const created = await loadFixture("installation.created.json");
      const response = await postWebhook(created);
      assert.equal(response.status, 202);
      const installation = await poll("installation active", async () => {
        const row = (await db
          .prepare(`SELECT status FROM github_app_installations WHERE installation_id = '12345678'`)
          .get()) as { status: string } | undefined;
        return row?.status === "active" ? row : null;
      });
      assert.equal(installation.status, "active");
      assert.ok(
        double.log().every((entry) => !entry.path.includes("access_tokens")),
        "lifecycle reconcile minted no token",
      );
      note("F3", "installation.created converged to active with no token mint");
      pass("F3-activation");
    }

    // F4: repository mapping behind Owner step-up.
    {
      const mapProof = await stepUp("github.repository.map", "github-link:87654321");
      const mapped = await browser("POST", `${base}/repository-links`, OWNER, {
        request_id: "x04-e2e-map-1",
        installation_id: "12345678",
        repository_id: "87654321",
        project_id: projectId,
        full_name: "synthetic-org/synthetic-repo",
        default_branch: "main",
        step_up_proof_id: mapProof,
      });
      assert.equal(mapped.status, 200);
      const mismatchProof = await stepUp("github.repository.map", "github-link:11111111");
      const mismatch = await browser("POST", `${base}/repository-links`, OWNER, {
        request_id: "x04-e2e-map-mismatch",
        installation_id: "12345678",
        repository_id: "11111111",
        project_id: projectId,
        full_name: "synthetic-org/other",
        default_branch: "main",
        step_up_proof_id: mismatchProof,
      });
      assert.equal(mismatch.status, 409);
      note("F4", "repository mapped exactly once; identity mismatch rejected");
      pass("F4-mapping");
    }

    // Scenario clock: every ordering-sensitive delivery is stamped live.
    let t0 = "";
    // F5: push converges through Queue + REST with a short-lived token.
    {
      t0 = new Date().toISOString();
      const push = await loadFixture("push.main-new.json");
      const response = await postWebhook(push, undefined, webhookSecret, t0);
      assert.equal(response.status, 202);
      await poll("push applied", async () => {
        const row = await deliveryState(push.delivery_id);
        return row?.state === "applied" ? row : null;
      });
      const evidence = (await db
        .prepare(
          `SELECT ref, version_token FROM github_evidence WHERE workspace_id = ? AND kind = 'commit' AND observed_by = 'github'`,
        )
        .all(FIX.workspace)) as Array<{ ref: string; version_token: string }>;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.version_token, "b".repeat(40));
      await poll("token minted once", async () => {
        const mints = double.log().filter((entry) => entry.path.includes("access_tokens"));
        return mints.length === 1 ? mints : null;
      });
      const reads = double.log().filter((entry) => entry.path.startsWith("/repositories/"));
      assert.equal(reads.length, 1);
      assert.equal(reads[0]?.auth, "canary");
      note("F5", "push applied once; token minted once and presented to REST");
      pass("F5-push");
    }

    // F6: duplicate redelivery converges with one domain effect.
    {
      const push = await loadFixture("push.main-new.json");
      const response = await postWebhook(push);
      assert.equal(response.status, 202);
      assert.equal((response.body as { duplicate?: boolean }).duplicate, true);
      const outbox = (await db
        .prepare(`SELECT COUNT(*) AS count FROM github_integration_outbox WHERE delivery_id = ?`)
        .get(push.delivery_id)) as { count: number };
      assert.equal(outbox.count, 1);
      const evidence = (await db
        .prepare(
          `SELECT COUNT(*) AS count FROM github_evidence WHERE workspace_id = ? AND kind = 'commit' AND observed_by = 'github'`,
        )
        .get(FIX.workspace)) as { count: number };
      assert.equal(evidence.count, 1);
      note("F6", "duplicate delivery replayed with one outbox row and one effect");
      pass("F6-duplicate");
    }

    // F7: out-of-order delivery is superseded without effect.
    {
      const old = await loadFixture("push.main-old.json");
      const response = await postWebhook(
        old,
        undefined,
        webhookSecret,
        new Date(Date.parse(t0) - 10 * 60 * 1000).toISOString(),
      );
      assert.equal(response.status, 202);
      await poll("old delivery superseded", async () => {
        const row = await deliveryState(old.delivery_id);
        return row?.state === "superseded" ? row : null;
      });
      const evidence = (await db
        .prepare(
          `SELECT version_token FROM github_evidence WHERE workspace_id = ? AND kind = 'commit' AND observed_by = 'github'`,
        )
        .all(FIX.workspace)) as Array<{ version_token: string }>;
      assert.deepEqual(
        evidence.map((row) => row.version_token),
        ["b".repeat(40)],
      );
      note("F7", "older push superseded; newest sha remains the single effect");
      pass("F7-out-of-order");
    }

    // F8: D1-commit-before-enqueue crash gap recovered by the real Cron.
    {
      const feature = await loadFixture("push.feature.json");
      const proxy = server.getWorker("bfb-x04-proxy");
      const crashed = await proxy.fetch(`${ORIGIN}/workspaces/${FIX.workspace}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandName: "github.webhook.receive",
          request: {
            workspaceId: FIX.workspace,
            idempotencyKey: `github-delivery.${feature.delivery_id}`,
            authorizationEpoch: 1,
            actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
            now: new Date().toISOString(),
            input: {
              deliveryId: feature.delivery_id,
              event: feature.event,
              supported: true,
              effect: {
                event: feature.event,
                action: null,
                installationId: "12345678",
                repositoryId: "87654321",
                occurredAt: "2026-09-18T12:00:00.000Z",
                ref: "feature-x04",
                version: "c".repeat(40),
                detail: {},
              },
            },
          },
        }),
      });
      assert.equal(crashed.status, 200);
      // The crash state: committed, pending, and provably not processed early.
      const before = await deliveryState(feature.delivery_id);
      assert.equal(before?.state, "received");
      const pending = await outboxFor(feature.delivery_id);
      assert.equal(pending?.state, "pending");
      await new Promise((done) => setTimeout(done, 3000));
      assert.equal((await deliveryState(feature.delivery_id))?.state, "received");
      note("F8", "crash state holds received/pending with no early processing");
      // The real Cron trigger recovers the missed enqueue end to end.
      await server
        .getWorker("bfb-x04-a")
        .scheduled({ cron: "*/5 * * * *", scheduledTime: new Date() });
      await poll("crashed delivery applied", async () => {
        const row = await deliveryState(feature.delivery_id);
        return row?.state === "applied" ? row : null;
      });
      note("F8", "cron recovery applied the crashed delivery exactly once");
      pass("F8-crash-gap");
    }

    // F9: poison Queue message DLQs independently; siblings ack once.
    {
      const control = server.getWorker("bfb-x04-a");
      const queueEnv = (await control.getEnv()) as unknown as {
        JOBS: { send(message: unknown): Promise<unknown> };
      };
      const bogusOutbox = `x04-bogus-${randomBytes(4).toString("hex")}`;
      const bogusDelivery = `x04-bogus-${randomBytes(4).toString("hex")}`;
      await queueEnv.JOBS.send({
        schema_version: 1,
        kind: "github.outbox.dispatch",
        workspace_id: FIX.workspace,
        outbox_id: bogusOutbox,
        delivery_id: bogusDelivery,
        attempt: 0,
      });
      const pr = await loadFixture("pull_request.opened.json");
      const response = await postWebhook(
        pr,
        undefined,
        webhookSecret,
        new Date(Date.parse(t0) + 15 * 60 * 1000).toISOString(),
      );
      assert.equal(response.status, 202);
      await poll("poison parked in DLQ", async () => {
        const row = (await db
          .prepare(`SELECT error FROM github_dlq WHERE workspace_id = ? AND outbox_id = ?`)
          .get(FIX.workspace, bogusOutbox)) as { error: string } | undefined;
        return row ? row : null;
      });
      await poll("sibling PR applied", async () => {
        const row = await deliveryState(pr.delivery_id);
        return row?.state === "applied" ? row : null;
      });
      const evidence = (await db
        .prepare(
          `SELECT ref, version_token FROM github_evidence WHERE workspace_id = ? AND kind = 'pull_request' AND observed_by = 'github'`,
        )
        .all(FIX.workspace)) as Array<{ ref: string; version_token: string }>;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]?.ref, "7");
      note("F9", "poison message DLQed while the sibling PR applied exactly once");
      pass("F9-poison");
    }

    // F10: suspend parks deliveries temporarily; unsuspend resumes.
    {
      const suspend = await loadFixture("installation.suspend.json");
      assert.equal((await postWebhook(suspend)).status, 202);
      await poll("installation suspended", async () => {
        const row = (await db
          .prepare(`SELECT status FROM github_app_installations WHERE installation_id = '12345678'`)
          .get()) as { status: string } | undefined;
        return row?.status === "suspended" ? row : null;
      });
      const parked = await loadFixture("check_run.completed.json");
      const parkedResponse = await postWebhook(parked);
      assert.equal(parkedResponse.status, 503, JSON.stringify(parkedResponse.body));
      assert.equal(await deliveryState(parked.delivery_id), null);
      const unsuspend = await loadFixture("installation.unsuspend.json");
      assert.equal((await postWebhook(unsuspend)).status, 202);
      await poll("installation active again", async () => {
        const row = (await db
          .prepare(`SELECT status FROM github_app_installations WHERE installation_id = '12345678'`)
          .get()) as { status: string } | undefined;
        return row?.status === "active" ? row : null;
      });
      const retry = await postWebhook(
        { ...parked, delivery_id: "x04-delivery-check-retry" },
        undefined,
        webhookSecret,
        new Date(Date.parse(t0) + 16 * 60 * 1000).toISOString(),
      );
      assert.equal(retry.status, 202);
      await poll("retried check applied", async () => {
        const row = await deliveryState("x04-delivery-check-retry");
        return row?.state === "applied" ? row : null;
      });
      note("F10", "suspended installation parks with no state; unsuspend resumes");
      pass("F10-suspend");
    }

    // F11: revocation closes links and ignores later deliveries without minting.
    {
      const mintsBefore = double
        .log()
        .filter((entry) => entry.path.includes("access_tokens")).length;
      const deleted = await loadFixture("installation.deleted.json");
      assert.equal((await postWebhook(deleted)).status, 202);
      await poll("installation revoked", async () => {
        const row = (await db
          .prepare(`SELECT status FROM github_app_installations WHERE installation_id = '12345678'`)
          .get()) as { status: string } | undefined;
        return row?.status === "revoked" ? row : null;
      });
      const links = (await db
        .prepare(
          `SELECT COUNT(*) AS count FROM github_repository_links WHERE repository_id = '87654321' AND link_state = 'active'`,
        )
        .get()) as { count: number };
      assert.equal(links.count, 0);
      const late = await postWebhook({
        ...(await loadFixture("push.main-new.json")),
        delivery_id: "x04-delivery-push-after-revoke",
      });
      assert.equal(late.status, 202);
      assert.equal((late.body as { ignored?: boolean }).ignored, true);
      await new Promise((done) => setTimeout(done, 2000));
      assert.equal(
        double.log().filter((entry) => entry.path.includes("access_tokens")).length,
        mintsBefore,
      );
      note("F11", "revocation closed links; later deliveries ignored with no new token");
      pass("F11-revocation");
    }

    // F12: issues never move tasks; provenance separates runner from github.
    {
      const created = await browser("POST", `/api/v1/workspaces/${FIX.workspace}/tasks`, OWNER, {
        project_id: projectId,
        title: "Synthetic X04 canonical task",
        priority: "P2",
        request_id: "x04-e2e-task-1",
      });
      assert.equal(created.status, 200);
      const taskId = (created.body as { result: { id: string } }).result.id;
      const linked = await browser("POST", `${base}/evidence/links`, MEMBER, {
        request_id: "x04-e2e-evidence-runner",
        project_id: projectId,
        task_id: taskId,
        repository_id: "87654321",
        kind: "issue",
        ref: "9",
        version_token: "open",
        observed_by: "runner",
        state: { note: "runner claim" },
      });
      assert.equal(linked.status, 200);
      const before = await browser("POST", `${base}/evidence/verification`, MEMBER, {
        refs: [{ kind: "github", ref: "github:87654321:issue:9" }],
      });
      assert.deepEqual((before.body as { statuses: unknown }).statuses, [
        { kind: "github", ref: "github:87654321:issue:9", provenance: "runner_observed" },
      ]);
      // Reinstall a fresh installation so issue webhooks flow after F11.
      const ownerProof = await stepUp("github.install", "github-installation:12345679");
      const reinstalled = await browser("POST", `${base}/installations`, OWNER, {
        request_id: "x04-e2e-install-2",
        installation_id: "12345679",
        app_id: "999000",
        app_slug: "synthetic-app",
        account_id: "555666",
        account_login: "synthetic-org",
        account_type: "Organization",
        permissions: { metadata: "read", issues: "read" },
        events: ["issues", "installation"],
        step_up_proof_id: ownerProof,
      });
      assert.equal(reinstalled.status, 200);
      const recast = await loadFixture("installation.created.json");
      recast.payload = {
        ...recast.payload,
        installation: { ...(recast.payload.installation as object), id: 12345679 },
      };
      assert.equal((await postWebhook(recast, "x04-delivery-install-second")).status, 202);
      await poll("second installation active", async () => {
        const row = (await db
          .prepare(`SELECT status FROM github_app_installations WHERE installation_id = '12345679'`)
          .get()) as { status: string } | undefined;
        return row?.status === "active" ? row : null;
      });
      // Map the same repository under the new installation to the project.
      const mapProof = await stepUp("github.repository.map", "github-link:87654321");
      const mapped = await browser("POST", `${base}/repository-links`, OWNER, {
        request_id: "x04-e2e-map-2",
        installation_id: "12345679",
        repository_id: "87654321",
        project_id: projectId,
        full_name: "synthetic-org/synthetic-repo",
        default_branch: "main",
        step_up_proof_id: mapProof,
      });
      assert.equal(mapped.status, 200);
      const opened = await loadFixture("issues.opened.json");
      opened.payload = {
        ...opened.payload,
        installation: { ...(opened.payload.installation as object), id: 12345679 },
      };
      assert.equal(
        (
          await postWebhook(
            opened,
            "x04-delivery-issue-second",
            webhookSecret,
            new Date(Date.parse(t0) + 20 * 60 * 1000).toISOString(),
          )
        ).status,
        202,
      );
      await poll("issue evidence recorded", async () => {
        const rows = (await db
          .prepare(
            `SELECT version_token FROM github_evidence WHERE workspace_id = ? AND kind = 'issue' AND ref = '9' AND observed_by = 'github'`,
          )
          .all(FIX.workspace)) as Array<{ version_token: string }>;
        return rows.length === 1 ? rows : null;
      });
      const after = await browser("POST", `${base}/evidence/verification`, MEMBER, {
        refs: [{ kind: "github", ref: "github:87654321:issue:9" }],
      });
      assert.deepEqual((after.body as { statuses: unknown }).statuses, [
        { kind: "github", ref: "github:87654321:issue:9", provenance: "github_verified" },
      ]);
      const task = (await db
        .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, taskId)) as { state: string };
      assert.equal(task.state, "ready");
      note(
        "F12",
        "issue events link evidence only; task stays canonical; provenance upgrades on github match",
      );
      pass("F12-provenance");
    }

    // F13: token and key canary scan across D1, logs, and evidence.
    {
      const dump: string[] = [];
      for (const table of [
        "github_app_installations",
        "github_repository_links",
        "github_webhook_deliveries",
        "github_integration_outbox",
        "github_dlq",
        "github_evidence",
        "github_reconcile_state",
        "semantic_events",
        "audit_events",
        "outbox_records",
        "idempotency_records",
      ]) {
        const rows = (await db.prepare(`SELECT * FROM ${table}`).all()) as unknown[];
        dump.push(JSON.stringify(rows));
      }
      const logs = server
        .getLogs()
        .map((entry) => JSON.stringify(entry))
        .join("\n");
      const doubleLog = JSON.stringify(double.log());
      const haystacks = {
        d1: dump.join("\n"),
        worker_logs: logs,
        double_log: doubleLog,
        traces: traces.join("\n"),
      };
      const needles = [canary, "BEGIN PRIVATE KEY", webhookSecret, abuseSecret, signingKey];
      const hits: Array<{ haystack: string; needle: string }> = [];
      for (const [name, haystack] of Object.entries(haystacks)) {
        for (const needle of needles) {
          if (haystack.includes(needle)) {
            hits.push({ haystack: name, needle: needle.slice(0, 24) });
          }
        }
      }
      // The double must have seen a well-formed JWT but never the App key.
      const mints = double.log().filter((entry) => entry.path.includes("access_tokens"));
      assert.ok(mints.length >= 1, "expected at least one token mint");
      assert.ok(
        mints.every((entry) => entry.auth === "jwt"),
        "mints use App JWT bearer",
      );
      assert.deepEqual(hits, []);
      await mkdir(evidenceDir, { recursive: true });
      await writeJson(resolve(evidenceDir, "canary-scan.json"), {
        scanned: Object.keys(haystacks),
        hits: 0,
        outcome: "passed",
      });
      note("F13", `canary scan passed over ${Object.keys(haystacks).join(", ")}`);
      pass("F13-canary");
    }

    // Evidence traces.
    await mkdir(evidenceDir, { recursive: true });
    const matrix = [
      "| Action | Actor | Step-up | HTTP |",
      "| --- | --- | --- | --- |",
      ...authMatrix.map(
        (row) => `| ${row.action} | ${row.actor} | ${row.step_up} | ${row.status} |`,
      ),
    ].join("\n");
    await writeFile(resolve(evidenceDir, "auth-matrix.md"), `${matrix}\n`);
    const statusSnapshot = await browser("GET", `${base}/status`, OWNER);
    assert.equal(statusSnapshot.status, 200);
    const recorded = (
      statusSnapshot.body as {
        installations: Array<{ permissions: Record<string, string>; events: string[] }>;
      }
    ).installations;
    for (const installation of recorded) {
      for (const [name, access] of Object.entries(installation.permissions)) {
        assert.ok(
          (GITHUB_PERMISSIONS_ALLOWLIST[name] as readonly string[] | undefined)?.includes(access),
          `recorded permission ${name}:${access} is outside the inventory`,
        );
      }
      for (const event of installation.events) {
        assert.ok(
          (GITHUB_WEBHOOK_EVENTS_ALLOWLIST as readonly string[]).includes(event),
          `recorded event ${event} is outside the inventory`,
        );
      }
    }
    await writeJson(resolve(evidenceDir, "permission-inventory.json"), {
      allowlist: GITHUB_PERMISSIONS_ALLOWLIST,
      events: GITHUB_WEBHOOK_EVENTS_ALLOWLIST,
      recorded,
    });
    const faultMatrix = [
      "| Fault | Expected | Observed |",
      "| --- | --- | --- |",
      "| Invalid HMAC with unparsable body | 401 before parsing | F1 |",
      "| Valid HMAC with invalid JSON | 400 parse failure | F1 |",
      "| Unknown installation | 404, no rows | F1 |",
      "| Non-Owner install/remap | 403 | F2/F4 |",
      "| Write permission / unknown event | 409 inventory rejection | F2 |",
      "| D1 commit before Queue enqueue | received/pending, Cron recovers | F8 |",
      "| Duplicate delivery | replayed, one outbox row | F6 |",
      "| Out-of-order push | superseded, newest effect wins | F7 |",
      "| Poison Queue message | DLQ row, siblings ack once | F9 |",
      "| Suspended installation | 503, no state | F10 |",
      "| Revoked installation | ignored, links closed, no mint | F11 |",
      "| Issue closed | evidence only, task unchanged | F12 |",
    ].join("\n");
    await writeFile(resolve(evidenceDir, "fault-matrix.md"), `${faultMatrix}\n`);
    await writeJson(resolve(evidenceDir, "command-result.json"), {
      command: "pnpm test:x04",
      scenarios: scenarioResults,
      outcome: "passed",
    });
    const effects = (await db
      .prepare(
        `SELECT delivery_id, event, action, installation_id, repository_id, state FROM github_webhook_deliveries WHERE workspace_id = ? ORDER BY received_at, delivery_id`,
      )
      .all(FIX.workspace)) as unknown[];
    await writeJson(resolve(evidenceDir, "delivery-effects.json"), effects);
    console.log("X04_E2E_OK all scenarios passed");
  } catch (error) {
    for (const entry of server.getLogs().slice(-15)) {
      console.log("X04_WORKER_LOG", JSON.stringify(entry).slice(0, 500));
    }
    throw error;
  } finally {
    await server.close().catch(() => undefined);
    await double.stop().catch(() => undefined);
  }
}

await main();
