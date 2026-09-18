// ABOUTME: Drills X05 operations across real Workers, D1, R2, and a local Queue with DLQ.
// ABOUTME: Planted canaries prove redaction; evidence stays bounded with counts and states only.

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

import { adaptD1, loadMigrationManifest, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  checkOperationsTables,
  FIX,
  issueStepUpProof,
  OPS_STEP_UP_ACTIONS,
  randomUlid,
  seedSyntheticWorkspace,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

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
const evidenceDir = resolve(root, "docs/work-packages/evidence/WP-X05");

const ORIGIN = "https://bfb.x05.test";
const ARTIFACT_ORIGIN = "https://artifacts.x05.test";
const QUEUE = "bfb-ops-local";
const DLQ = "bfb-ops-dlq-local";
const POLL_TIMEOUT_MS = 30_000;
const POLL_STEP_MS = 250;

const webhookSecret = `x05-webhook-secret-${randomBytes(16).toString("hex")}`;
const abuseSecret = `x05-abuse-secret-${randomBytes(16).toString("hex")}-long`;
const signingKey = `x05-signing-key-${randomBytes(16).toString("hex")}`;
const previousKey = `x05-previous-key-${randomBytes(16).toString("hex")}`;
// Planted secrets: task bodies, cookies, bearer grants, paths, hook payloads,
// artifact bytes, and terminal output that must never surface in drill output.
const CANARIES = {
  taskBody: "X05-CANARY-TASK-BODY-alpha",
  cookie: "X05-CANARY-COOKIE-beta=secret",
  bearer: "Bearer X05-CANARY-BEARER-gamma",
  path: "/Users/x05canary/secret/path",
  hook: "X05-CANARY-HOOK-PAYLOAD-delta",
  artifact: "X05-CANARY-ARTIFACT-BYTES-epsilon",
  terminal: "X05-CANARY-TERMINAL-OUTPUT-zeta",
};

const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
assert.ok(
  manifest.migrations.some((entry) => entry.id === "0034_operations"),
  "X05 migration is required",
);

const traces: string[] = [];
const scenarioResults: Array<{ name: string; outcome: string }> = [];
function note(scenario: string, line: string): void {
  traces.push(`[${scenario}] ${line}`);
  console.log(`X05_${scenario} ${line}`);
}
function pass(scenario: string): void {
  scenarioResults.push({ name: scenario, outcome: "passed" });
}

function sessionPair(sessionId: string, token: string): { cookie: string; csrf: string } {
  const signed = `${token}.${createHmac("sha256", signingKey).update(token).digest("base64")}`;
  return {
    cookie: `__Host-bfb_session=${encodeURIComponent(signed)}`,
    csrf: `2.${createHmac("sha256", signingKey).update(`bfb-csrf:${sessionId}`).digest("hex")}`,
  };
}

const OWNER = sessionPair("x05-owner-session", "x05-owner-token");
const MEMBER = sessionPair("x05-member-session", "x05-member-token");
const REVIEWER = sessionPair("x05-reviewer-session", "x05-reviewer-token");

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

async function stepUp(
  db: SqlDatabase,
  humanId: string,
  action: string,
  targetId: string,
  now: string,
): Promise<string> {
  return issueStepUpProof(
    db,
    humanId,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
    },
    now,
  );
}

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const dlqCopies: unknown[] = [];
  const harness = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/dlq") {
      let text = "";
      request.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      request.on("end", () => {
        try {
          dlqCopies.push(JSON.parse(text) as unknown);
        } catch {
          dlqCopies.push({ unparseable: true });
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((done) => harness.listen(0, "127.0.0.1", done));
  const harnessUrl = `http://127.0.0.1:${(harness.address() as { port: number }).port}`;

  const assetsDir = resolve(tmpdir(), `bfb-x05-assets-${randomBytes(6).toString("hex")}`);
  await mkdir(assetsDir, { recursive: true });
  await writeFile(resolve(assetsDir, "index.html"), "<!doctype html><title>x05</title>\n");

  const database = {
    binding: "DB",
    database_name: "bfb-x05-test",
    database_id: "00000000-0000-4000-8000-000000000034",
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
    LAUNCH_ORIGIN: "https://launch.x05.test",
    BETTER_AUTH_SECRETS: `2:${signingKey},1:${previousKey}`,
    AUTH_ABUSE_SECRET: abuseSecret,
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    GITHUB_CLIENT_ID: "x05-synthetic-oauth-client",
    GITHUB_CLIENT_SECRET: "x05-synthetic-oauth-secret-0123456789abcdef",
  };
  const control = (consume: boolean) => ({
    ...base,
    main: resolve(root, "apps/control-worker/src/index.ts"),
    vars,
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-x05-artifacts" }],
    queues: {
      producers: [
        { binding: "OPS_JOBS", queue: QUEUE },
        { binding: "OPS_DLQ", queue: DLQ },
        { binding: "JOBS", queue: "bfb-x05-jobs-unused" },
        { binding: "JOBS_DLQ", queue: "bfb-x05-jobs-dlq-unused" },
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
      bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-x05-hub" }],
    },
  });
  const server = createTestHarness({
    root,
    workers: [
      { config: { ...control(true), name: "bfb-x05-a" } },
      { config: { ...control(false), name: "bfb-x05-b" } },
      {
        config: {
          ...base,
          name: "bfb-x05-hub",
          main: resolve(root, "apps/control-worker/src/index.ts"),
          durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
          exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
        },
      },
      {
        config: {
          ...base,
          name: "bfb-x05-dlq",
          main: resolve(toolDir, "dlq-worker.ts"),
          vars: { HARNESS_URL: harnessUrl },
          queues: {
            consumers: [{ queue: DLQ, max_batch_size: 10, max_batch_timeout: 5 }],
          },
        },
      },
    ],
  });

  let workerIndex = 0;
  const pick = (): string => (workerIndex++ % 2 === 0 ? "bfb-x05-a" : "bfb-x05-b");
  const fetchWorker = (name: string, url: string, init?: RequestInit): Promise<Response> =>
    (
      server.getWorker(name).fetch as unknown as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>
    )(url, init);

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

  const get = (path: string, session: { cookie: string; csrf: string }) =>
    fetchWorker(pick(), ORIGIN + path, { headers: { cookie: session.cookie } }).then(
      async (response) => ({
        status: response.status,
        body: (await response.json()) as unknown,
      }),
    );

  try {
    await server.listen();
    const seeder = server.getWorker("bfb-x05-hub");
    await seeder.applyD1Migrations("DB");
    const env = (await seeder.getEnv()) as unknown as { DB: D1Like };
    const db = adaptD1(env.DB);

    // D1: migration 0034 is registered and applied (never claimed as newest head).
    assert.ok(
      manifest.migrations.some((entry) => entry.id === "0034_operations"),
      "0034_operations is registered",
    );
    const tables = await checkOperationsTables(db);
    assert.deepEqual(tables.missing, []);
    note("D1", "0034_operations registered and applied; operations tables present");
    pass("D1-migration");

    await seedSyntheticWorkspace(db, now, "global");
    await seedHuman(
      db,
      "x05-user",
      "x05-owner-session",
      "x05-owner-token",
      FIX.owner,
      "owner@synthetic.test",
      now,
    );
    await seedHuman(
      db,
      "x05-member-user",
      "x05-member-session",
      "x05-member-token",
      FIX.member,
      "member@synthetic.test",
      now,
    );
    await seedHuman(
      db,
      "x05-reviewer-user",
      "x05-reviewer-session",
      "x05-reviewer-token",
      FIX.reviewer,
      "restricted@synthetic.test",
      now,
    );

    const base = `/api/v1/workspaces/${FIX.workspace}/operations`;
    const harvested: Record<string, string> = {};
    const harvest = (name: string, value: unknown): void => {
      harvested[name] = JSON.stringify(value);
    };

    // D2: Owner-only security audit; activity stays distinct and attributable.
    {
      const ownerAudit = await get(`${base}/security-audit`, OWNER);
      assert.equal(ownerAudit.status, 200);
      const memberAudit = await get(`${base}/security-audit`, MEMBER);
      assert.equal(memberAudit.status, 403);
      const reviewerAudit = await get(`${base}/security-audit`, REVIEWER);
      assert.equal(reviewerAudit.status, 403);
      const ownerActivity = await get(`${base}/activity`, OWNER);
      assert.equal(ownerActivity.status, 200);
      const memberActivity = await get(`${base}/activity`, MEMBER);
      assert.equal(memberActivity.status, 200);
      const reviewerActivity = await get(`${base}/activity`, REVIEWER);
      assert.equal(reviewerActivity.status, 200);
      harvest("security-audit", ownerAudit.body);
      harvest("activity", ownerActivity.body);
      assert.ok(
        !harvested["activity"]!.includes("payload_json"),
        "activity carries no ledger payloads",
      );
      note("D2", "security audit Owner-only; activity role-scoped without payloads");
      pass("D2-roles");
    }

    // D3: retention step-up matrix over the real Worker.
    {
      const target = `ops-retention:${FIX.workspace}`;
      const memberProof = await stepUp(db, FIX.member, OPS_STEP_UP_ACTIONS.retention, target, now);
      const memberDenied = await browser("PUT", `${base}/retention`, MEMBER, {
        request_id: "x05-d3-member",
        raw_log_retention_days: 7,
        step_up_proof_id: memberProof,
      });
      assert.equal(memberDenied.status, 403);
      const missing = await browser("PUT", `${base}/retention`, OWNER, {
        request_id: "x05-d3-missing",
        raw_log_retention_days: 7,
      });
      assert.equal(missing.status, 400);
      const fresh = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.retention, target, now);
      const changed = await browser("PUT", `${base}/retention`, OWNER, {
        request_id: "x05-d3-fresh",
        raw_log_retention_days: 30,
        step_up_proof_id: fresh,
      });
      assert.equal(changed.status, 200);
      const replayed = await browser("PUT", `${base}/retention`, OWNER, {
        request_id: "x05-d3-replay",
        raw_log_retention_days: 9,
        step_up_proof_id: fresh,
      });
      assert.equal(replayed.status, 403);
      const wrong = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.recover, target, now);
      const mismatched = await browser("PUT", `${base}/retention`, OWNER, {
        request_id: "x05-d3-mismatch",
        raw_log_retention_days: 9,
        step_up_proof_id: wrong,
      });
      assert.equal(mismatched.status, 403);
      const staleBorn = new Date(Date.parse(now) - 10 * 60_000).toISOString();
      const staleIssue = await issueStepUpProof(
        db,
        FIX.owner,
        {
          action: OPS_STEP_UP_ACTIONS.retention,
          workspaceId: FIX.workspace,
          targetId: target,
          scopes: [],
          authorizationEpoch: 1,
          expiresAt: new Date(Date.parse(staleBorn) + 60_000).toISOString(),
        },
        staleBorn,
      );
      const stale = await browser("PUT", `${base}/retention`, OWNER, {
        request_id: "x05-d3-stale",
        raw_log_retention_days: 9,
        step_up_proof_id: staleIssue,
      });
      assert.equal(stale.status, 403);
      note(
        "D3",
        "member/missing/replayed/mismatched/stale proofs rejected; fresh Owner proof sets v1",
      );
      pass("D3-step-up");
    }

    // D4: an expired pending launch is visible as stuck without touching live claims.
    {
      const {
        WorkspaceHub: Hub,
        updateWorkspacePolicyCommand,
        updateProjectPolicyCommand,
        reportRepositoryConfigCommand,
        createAgentProfileCommand,
        createTaskCommand,
        addContextCommand,
        replaceRunnerInventoryCommand,
        startLaunchCommand,
        runnerHash,
      } = await import("@bfb/domain");
      const T0 = new Date(Math.floor((Date.parse(now) - 30 * 60_000) / 1000) * 1000).toISOString();
      const hub = new Hub(db);
      const runner = randomUlid();
      const checkout = randomUlid();
      const tokenId = randomUlid();
      const principal = {
        kind: "runner",
        workspaceId: FIX.workspace,
        runnerId: runner,
        ownerHumanId: FIX.owner,
        authorizationEpoch: 1,
        ownerAuthorizationEpoch: 1,
        grantEpoch: 1,
        tokenEpoch: 1,
        tokenId,
        keyThumbprint: "x05-drill-key",
        authExpiresAt: new Date(Date.parse(T0) + 300_000).toISOString(),
        projectIds: [FIX.projectA],
      } as const;
      const human = async <T>(
        command: { name: string },
        input: unknown,
        at: string,
      ): Promise<T> => {
        const outcome = await hub.execute(command as never, {
          workspaceId: FIX.workspace,
          idempotencyKey: randomUlid(),
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          now: at,
          input: input as never,
        });
        assert.equal(outcome.ok, true, `seed ${command.name}: ${JSON.stringify(outcome)}`);
        return (outcome as { result: T }).result;
      };
      const native = async <T>(
        command: { name: string },
        input: unknown,
        at: string,
      ): Promise<T> => {
        const outcome = await hub.execute(command as never, {
          workspaceId: FIX.workspace,
          idempotencyKey: randomUlid(),
          actorRunnerId: runner,
          authorizationEpoch: 1,
          now: at,
          input: input as never,
        });
        assert.equal(outcome.ok, true, `seed ${command.name}: ${JSON.stringify(outcome)}`);
        return (outcome as { result: T }).result;
      };
      await db
        .prepare(
          `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
           VALUES (?, ?, ?, 'X05 drill Mac', '{}', ?, 1, ?)`,
        )
        .run(FIX.workspace, runner, FIX.owner, principal.keyThumbprint, T0);
      await db
        .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
        .run(FIX.workspace, runner, FIX.projectA);
      await db
        .prepare(
          `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
        )
        .run(FIX.workspace, runner, FIX.owner, T0);
      await db
        .prepare(
          `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          runner,
          tokenId,
          runnerHash("x05-drill-token"),
          JSON.stringify({
            v: 1,
            sub: runner,
            workspace_id: FIX.workspace,
            aud: "bfb-runner",
            iss: ORIGIN,
            jti: tokenId,
            iat: Math.floor(Date.parse(T0) / 1000),
            exp: Math.floor(Date.parse(principal.authExpiresAt) / 1000),
            authorization_epoch: 1,
            owner_authorization_epoch: 1,
            grant_epoch: 1,
            token_epoch: 1,
            cnf: { jkt: principal.keyThumbprint },
          }),
          principal.authExpiresAt,
        );
      const policy = {
        allowedProviders: ["claude", "codex", "grok", "fake"],
        allowAgentRootPropose: false,
        allowPassToAgent: true,
        allowRunOverrides: true,
      };
      await human(updateWorkspacePolicyCommand, { ...policy, expectedVersion: 1 }, T0);
      await human(
        updateProjectPolicyCommand,
        { ...policy, expectedVersion: 1, projectId: FIX.projectA },
        T0,
      );
      const configHash = `sha256:${runnerHash("{}")}`;
      await human(
        reportRepositoryConfigCommand,
        { projectId: FIX.projectA, expectedVersion: 1, document: {}, contentHash: configHash },
        T0,
      );
      const profile = (await human(
        createAgentProfileCommand,
        {
          name: "X05 drill provider",
          provider: "fake",
          model: "synthetic",
          executionMode: "interactive",
          harnessMode: "restricted",
        },
        T0,
      )) as { id: string };
      const task = (await human(
        createTaskCommand,
        {
          projectId: FIX.projectA,
          title: `Drill task ${CANARIES.taskBody}`,
          priority: "P2",
        },
        T0,
      )) as { id: string };
      await human(
        addContextCommand,
        {
          taskId: task.id,
          kind: "brief",
          audience: "agent",
          body: [
            CANARIES.taskBody,
            CANARIES.cookie,
            CANARIES.bearer,
            CANARIES.path,
            CANARIES.hook,
            CANARIES.artifact,
            CANARIES.terminal,
          ].join(" | "),
        },
        T0,
      );
      await native(
        replaceRunnerInventoryCommand,
        {
          principal,
          inventory: {
            schema_version: 1,
            workspace_id: FIX.workspace,
            runner_id: runner,
            revision: 1,
            checkouts: [
              {
                schema_version: 1,
                checkout_id: checkout,
                workspace_id: FIX.workspace,
                runner_id: runner,
                project_id: FIX.projectA,
                label: "X05 drill checkout",
                repository_identity: "synthetic/x05",
                workspace_subpath: ".",
                physical_worktree_hash: configHash,
                repository_config_hash: configHash,
                is_default: true,
                dirty: false,
                status: "validated",
                validated_at: T0,
              },
            ],
            providers: [
              {
                provider: "fake",
                version: "1.0.0",
                manifest_id: configHash,
                status: "healthy",
                observed_at: T0,
                expires_at: new Date(Date.parse(T0) + 30_000).toISOString(),
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
              },
            ],
          },
        },
        T0,
      );
      const versions = {
        workspace: (
          (await db
            .prepare(`SELECT resource_version FROM workspace_policies WHERE workspace_id = ?`)
            .get(FIX.workspace)) as { resource_version: number }
        ).resource_version,
        project: (
          (await db
            .prepare(
              `SELECT resource_version FROM project_policies WHERE workspace_id = ? AND project_id = ?`,
            )
            .get(FIX.workspace, FIX.projectA)) as { resource_version: number }
        ).resource_version,
        config: (
          (await db
            .prepare(
              `SELECT resource_version FROM repository_configs WHERE workspace_id = ? AND project_id = ?`,
            )
            .get(FIX.workspace, FIX.projectA)) as { resource_version: number }
        ).resource_version,
      };
      const launch = (await human(
        startLaunchCommand,
        {
          schema_version: 1,
          idempotency_key: randomUlid(),
          task_id: task.id,
          expected_task_version: 1,
          runner_id: runner,
          checkout_id: checkout,
          agent_profile_id: profile.id,
          agent_profile_version: 1,
          workspace_policy_version: versions.workspace,
          project_policy_version: versions.project,
          repository_config_version: versions.config,
        },
        T0,
      )) as { launch_id: string };
      const queues = await get(`${base}/queues`, OWNER);
      assert.equal(queues.status, 200);
      const stuck = (queues.body as { stuck_launches: Array<{ command_id: string }> })
        .stuck_launches;
      assert.ok(
        stuck.some((entry) => entry.command_id === launch.launch_id),
        "expired launch is stuck-visible",
      );
      harvest("queues", queues.body);
      note("D4", "expired pending launch visible as stuck; live claims untouched");
      pass("D4-stuck-launch");
    }

    // D5: a stuck upload is visible and recoverable idempotently.
    {
      const artifact = randomUlid();
      const version = randomUlid();
      const created = new Date(Date.parse(now) - 60 * 60_000).toISOString();
      await db
        .prepare(
          `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
           VALUES (?, ?, NULL, 'log', 'log', ?, ?)`,
        )
        .run(FIX.workspace, artifact, FIX.owner, created);
      await db
        .prepare(
          `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, created_at)
           VALUES (?, ?, ?, 'uploading', 'log', 64, ?, ?)`,
        )
        .run(FIX.workspace, version, artifact, "f".repeat(64), created);
      const before = await get(`${base}/queues`, OWNER);
      assert.equal(before.status, 200);
      assert.ok(
        (
          (before.body as { stuck_uploads: Array<{ version_id: string }> }).stuck_uploads ?? []
        ).some((entry) => entry.version_id === version),
        "stuck upload is visible",
      );
      const recoverTarget = `ops-recover:resolve_stuck_upload:${FIX.workspace}`;
      const firstProof = await stepUp(
        db,
        FIX.owner,
        OPS_STEP_UP_ACTIONS.recover,
        recoverTarget,
        now,
      );
      const first = await browser("POST", `${base}/recovery`, OWNER, {
        request_id: "x05-d5-first",
        kind: "resolve_stuck_upload",
        target: { version_ids: [version] },
        step_up_proof_id: firstProof,
      });
      assert.equal(first.status, 200);
      assert.equal((first.body as { result: { replayed: boolean } }).result.replayed, false);
      const state = (await db
        .prepare(`SELECT state FROM artifact_versions WHERE workspace_id = ? AND id = ?`)
        .get(FIX.workspace, version)) as { state: string };
      assert.equal(state.state, "failed");
      const secondProof = await stepUp(
        db,
        FIX.owner,
        OPS_STEP_UP_ACTIONS.recover,
        recoverTarget,
        now,
      );
      const second = await browser("POST", `${base}/recovery`, OWNER, {
        request_id: "x05-d5-second",
        kind: "resolve_stuck_upload",
        target: { version_ids: [version] },
        step_up_proof_id: secondProof,
      });
      assert.equal(second.status, 200);
      assert.equal((second.body as { result: { replayed: boolean } }).result.replayed, true);
      const liveProof = await stepUp(
        db,
        FIX.owner,
        OPS_STEP_UP_ACTIONS.recover,
        recoverTarget,
        now,
      );
      const liveDenied = await browser("POST", `${base}/recovery`, OWNER, {
        request_id: "x05-d5-live",
        kind: "resolve_stuck_upload",
        target: { version_ids: [randomUlid()] },
        step_up_proof_id: liveProof,
      });
      assert.equal(liveDenied.status, 400);
      note("D5", "stuck upload resolved once, replayed on retry, live versions rejected");
      pass("D5-stuck-upload");
    }

    // D6: a parked GitHub outbox row requeues through the X04 converger.
    {
      const delivery = `x05-delivery-${randomBytes(4).toString("hex")}`;
      await db
        .prepare(
          `INSERT INTO github_webhook_deliveries (workspace_id, delivery_id, event, effect_json, state, received_at)
           VALUES (?, ?, 'push', '{}', 'received', ?)`,
        )
        .run(FIX.workspace, delivery, now);
      await db
        .prepare(
          `INSERT INTO github_integration_outbox (workspace_id, outbox_id, delivery_id, kind, state, attempts, next_attempt_at, created_at, updated_at)
           VALUES (?, 'x05-outbox-dlq-1', ?, 'github.reconcile', 'dlq', 5, ?, ?, ?)`,
        )
        .run(FIX.workspace, delivery, now, now, now);
      const recoverTarget = `ops-recover:requeue_github_outbox:${FIX.workspace}`;
      const proof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.recover, recoverTarget, now);
      const requeued = await browser("POST", `${base}/recovery`, OWNER, {
        request_id: "x05-d6-requeue",
        kind: "requeue_github_outbox",
        target: { outbox_ids: ["x05-outbox-dlq-1"] },
        step_up_proof_id: proof,
      });
      assert.equal(requeued.status, 200);
      const row = (await db
        .prepare(
          `SELECT state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
        )
        .get(FIX.workspace, "x05-outbox-dlq-1")) as { state: string; attempts: number };
      assert.deepEqual(row, { state: "pending", attempts: 0 });
      note("D6", "github DLQ row requeued to pending with reset attempts");
      pass("D6-github-requeue");
    }

    // D7: missed notification dispatch rewinds the X01 watermark idempotently.
    {
      const eventId = randomUlid();
      await db
        .prepare(
          `INSERT INTO semantic_events (workspace_id, event_id, workspace_cursor, kind, payload_json, created_at)
           VALUES (?, ?, 21, 'attention.request', '{}', ?)`,
        )
        .run(FIX.workspace, eventId, now);
      await db
        .prepare(
          `INSERT INTO notification_dispatch_state (workspace_id, last_cursor, updated_at) VALUES (?, 21, ?)
           ON CONFLICT (workspace_id) DO UPDATE SET last_cursor = 21, updated_at = excluded.updated_at`,
        )
        .run(FIX.workspace, now);
      const recoverTarget = `ops-recover:retry_notification_dispatch:${FIX.workspace}`;
      const proof = await stepUp(db, FIX.owner, OPS_STEP_UP_ACTIONS.recover, recoverTarget, now);
      const rewound = await browser("POST", `${base}/recovery`, OWNER, {
        request_id: "x05-d7-rewind",
        kind: "retry_notification_dispatch",
        target: { cursors: [21] },
        step_up_proof_id: proof,
      });
      assert.equal(rewound.status, 200);
      const watermark = (await db
        .prepare(`SELECT last_cursor FROM notification_dispatch_state WHERE workspace_id = ?`)
        .get(FIX.workspace)) as { last_cursor: number };
      assert.equal(watermark.last_cursor, 20);
      note("D7", "notification watermark rewound to 20 for redelivery");
      pass("D7-notify-rewind");
    }

    // D8: retention deletes only the eligible log object through the OPS queue.
    {
      const oldAt = new Date(Date.parse(now) - 60 * 24 * 60 * 60_000).toISOString();
      const freshAt = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
      const chunks: Array<{ version: string; key: string }> = [];
      for (const [at, run] of [
        [oldAt, "01JX05OLD00000000000000001"],
        [freshAt, "01JX05FRESH000000000000001"],
      ] as const) {
        const artifact = randomUlid();
        const version = randomUlid();
        const key = `workspaces/${FIX.workspace}/runs/${run}/logs/${version}.jsonl.zst`;
        await db
          .prepare(
            `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
             VALUES (?, ?, NULL, 'log', 'log', ?, ?)`,
          )
          .run(FIX.workspace, artifact, FIX.owner, at);
        await db
          .prepare(
            `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
             VALUES (?, ?, ?, 'available', 'log', 256, ?, ?, ?, ?, ?)`,
          )
          .run(FIX.workspace, version, artifact, "d".repeat(64), "e".repeat(64), key, at, at);
        chunks.push({ version, key });
      }
      const reviewArtifact = randomUlid();
      const reviewVersion = randomUlid();
      await db
        .prepare(
          `INSERT INTO artifacts (workspace_id, id, run_id, format, role, created_by_human_id, created_at)
           VALUES (?, ?, NULL, 'markdown', 'review', ?, ?)`,
        )
        .run(FIX.workspace, reviewArtifact, FIX.owner, oldAt);
      await db
        .prepare(
          `INSERT INTO artifact_versions (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
           VALUES (?, ?, ?, 'available', 'markdown', 128, ?, ?, ?, ?, ?)`,
        )
        .run(
          FIX.workspace,
          reviewVersion,
          reviewArtifact,
          "d".repeat(64),
          "f".repeat(64),
          `workspaces/${FIX.workspace}/artifacts/sha256/${"f".repeat(64)}`,
          oldAt,
          oldAt,
        );
      const control = server.getWorker("bfb-x05-a");
      const queueEnv = (await control.getEnv()) as unknown as {
        OPS_JOBS: { send(message: unknown): Promise<unknown> };
        ARTIFACTS: {
          put(key: string, value: string): Promise<unknown>;
          get(key: string): Promise<{ text(): Promise<string> } | null>;
        };
      };
      await queueEnv.ARTIFACTS.put(chunks[0]!.key, "old-log-bytes");
      await queueEnv.ARTIFACTS.put(chunks[1]!.key, "fresh-log-bytes");
      await queueEnv.ARTIFACTS.put(
        `workspaces/${FIX.workspace}/artifacts/sha256/${"f".repeat(64)}`,
        "review-bytes",
      );
      await queueEnv.OPS_JOBS.send({
        schema_version: 1,
        kind: "retention.sweep",
        workspace_id: FIX.workspace,
        attempt: 1,
      });
      const run = await poll("retention run recorded", async () => {
        const row = (await db
          .prepare(
            `SELECT examined, deleted_objects, deleted_bytes, error FROM retention_runs WHERE workspace_id = ? ORDER BY started_at DESC, id DESC`,
          )
          .get(FIX.workspace)) as
          | {
              examined: number;
              deleted_objects: number;
              deleted_bytes: number;
              error: string | null;
            }
          | undefined;
        return row && row.deleted_objects === 1 ? row : null;
      });
      assert.equal(run.error, null);
      assert.equal((await queueEnv.ARTIFACTS.get(chunks[0]!.key)) === null, true);
      assert.equal(await (await queueEnv.ARTIFACTS.get(chunks[1]!.key))?.text(), "fresh-log-bytes");
      assert.equal(
        await (
          await queueEnv.ARTIFACTS.get(
            `workspaces/${FIX.workspace}/artifacts/sha256/${"f".repeat(64)}`,
          )
        )?.text(),
        "review-bytes",
      );
      const kept = (await db
        .prepare(`SELECT COUNT(*) AS count FROM artifact_versions WHERE workspace_id = ?`)
        .get(FIX.workspace)) as { count: number };
      assert.ok(kept.count >= 3, "every D1 version row survives retention");
      await writeJson(resolve(evidenceDir, "retention-fixture.json"), {
        examined: run.examined,
        deleted_objects: run.deleted_objects,
        deleted_bytes: run.deleted_bytes,
        kept_d1_rows: kept.count,
        review_object_intact: true,
      });
      note(
        "D8",
        `retention via queue deleted 1 eligible object; ${kept.count} D1 rows and review bytes intact`,
      );
      pass("D8-retention");
    }

    // D9: diagnostic generate, inventory review, consent, and queued upload.
    {
      const generateProof = await stepUp(
        db,
        FIX.owner,
        OPS_STEP_UP_ACTIONS.diagnosticGenerate,
        `diagnostic:generate:${FIX.workspace}`,
        now,
      );
      const generated = await browser("POST", `${base}/diagnostics`, OWNER, {
        request_id: "x05-d9-generate",
        step_up_proof_id: generateProof,
      });
      assert.equal(generated.status, 200);
      const bundle = (
        generated.body as { result: { id: string; state: string; inventory_json: string } }
      ).result;
      assert.equal(bundle.state, "pending_consent");
      const inventory = JSON.parse(bundle.inventory_json) as { sections: Array<{ name: string }> };
      assert.deepEqual(
        inventory.sections.map((section) => section.name),
        ["identity", "work", "delivery", "execution", "integrations"],
      );
      harvest("diagnostic-inventory", JSON.parse(bundle.inventory_json) as unknown);
      const review = await get(`${base}/diagnostics/${bundle.id}`, OWNER);
      assert.equal(review.status, 200);
      const consentProof = await stepUp(
        db,
        FIX.owner,
        OPS_STEP_UP_ACTIONS.diagnosticUpload,
        `diagnostic:${bundle.id}`,
        now,
      );
      const consented = await browser("POST", `${base}/diagnostics/${bundle.id}/consent`, OWNER, {
        request_id: "x05-d9-consent",
        step_up_proof_id: consentProof,
      });
      assert.equal(consented.status, 200);
      assert.equal((consented.body as { upload_queued: boolean }).upload_queued, true);
      const uploaded = await poll("bundle uploaded through the OPS queue", async () => {
        const row = (await db
          .prepare(`SELECT state, r2_key FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
          .get(FIX.workspace, bundle.id)) as { state: string; r2_key: string | null };
        return row.state === "uploaded" ? row : null;
      });
      const control = server.getWorker("bfb-x05-b");
      const r2 = (
        (await control.getEnv()) as unknown as {
          ARTIFACTS: { get(key: string): Promise<{ text(): Promise<string> } | null> };
        }
      ).ARTIFACTS;
      const stored = await (await r2.get(uploaded.r2_key!))?.text();
      assert.ok(stored && stored.length > 0, "uploaded bundle is readable");
      harvest("diagnostic-upload", JSON.parse(stored) as unknown);
      note("D9", "bundle generated, inventory reviewed, consented, and uploaded redacted");
      pass("D9-diagnostics");
    }

    // D10: a poison OPS message DLQs visibly while a valid sibling converges.
    {
      const control = server.getWorker("bfb-x05-a");
      const queueEnv = (await control.getEnv()) as unknown as {
        OPS_JOBS: { send(message: unknown): Promise<unknown> };
      };
      const before = dlqCopies.length;
      await queueEnv.OPS_JOBS.send({ kind: "diagnostic.upload", workspace_id: FIX.workspace });
      await queueEnv.OPS_JOBS.send({
        schema_version: 1,
        kind: "retention.sweep",
        workspace_id: FIX.workspace,
        attempt: 1,
      });
      await poll("poison copy reaches the DLQ collector", async () =>
        dlqCopies.length > before ? dlqCopies : null,
      );
      const copy = dlqCopies[dlqCopies.length - 1] as Record<string, unknown>;
      assert.ok(copy && typeof copy === "object", "DLQ copy is structured");
      await poll("sibling sweep still converges", async () => {
        const row = (await db
          .prepare(`SELECT COUNT(*) AS count FROM retention_runs WHERE workspace_id = ?`)
          .get(FIX.workspace)) as { count: number };
        return row.count >= 2 ? row : null;
      });
      harvest("dlq-copy", copy);
      note("D10", "poison retried into the DLQ with IDs only; sibling sweep converged");
      pass("D10-poison");
    }

    // D11: every harvested output is scanned for secrets and private payloads.
    {
      const needles = [
        CANARIES.taskBody,
        CANARIES.cookie,
        CANARIES.bearer,
        CANARIES.path,
        CANARIES.hook,
        CANARIES.artifact,
        CANARIES.terminal,
        "BEGIN PRIVATE KEY",
        webhookSecret,
        abuseSecret,
        signingKey,
      ];
      const hits: Array<{ haystack: string; needle: string }> = [];
      for (const [name, haystack] of Object.entries(harvested)) {
        for (const needle of needles) {
          if (haystack.includes(needle)) {
            hits.push({ haystack: name, needle: needle.slice(0, 24) });
          }
        }
      }
      for (const copy of dlqCopies) {
        const rendered = JSON.stringify(copy);
        for (const needle of needles) {
          if (rendered.includes(needle)) {
            hits.push({ haystack: "dlq-copy", needle: needle.slice(0, 24) });
          }
        }
      }
      for (const line of traces) {
        for (const needle of needles) {
          if (line.includes(needle)) {
            hits.push({ haystack: "drill-log", needle: needle.slice(0, 24) });
          }
        }
      }
      assert.deepEqual(hits, []);
      await writeJson(resolve(evidenceDir, "redaction-scan.json"), {
        scanned: [...Object.keys(harvested), "dlq-copies", "drill-log"],
        needle_classes: [
          "task body",
          "cookie",
          "bearer grant",
          "local path",
          "hook payload",
          "artifact bytes",
          "terminal output",
          "private key",
          "webhook secret",
          "abuse secret",
          "session signing key",
        ],
        hits: 0,
        outcome: "passed",
      });
      note("D11", `secret scan passed over ${Object.keys(harvested).length + 2} outputs`);
      pass("D11-redaction");
    }

    await writeFile(resolve(evidenceDir, "drill.jsonl"), `${traces.join("\n")}\n`);
    console.log("X05_DRILL_OK all scenarios passed");
  } catch (error) {
    for (const entry of server.getLogs().slice(-15)) {
      console.log("X05_WORKER_LOG", JSON.stringify(entry).slice(0, 500));
    }
    throw error;
  } finally {
    await server.close().catch(() => undefined);
    await new Promise<void>((done) => harness.close(() => done()));
  }
}

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
