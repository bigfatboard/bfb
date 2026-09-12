// ABOUTME: Certifies C09 claims, controls and containment across independent production Worker routes.
// ABOUTME: Disposable D1 also proves populated migration preservation and occupied-checkout recovery after Hub eviction.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, loadMigrationManifest, type D1Like } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  canonicalRunnerKey,
  createAgentProfileCommand,
  createTaskCommand,
  encodeRunnerToken,
  launchDeadline,
  randomUlid,
  reportRepositoryConfigCommand,
  runnerChallengeTranscript,
  runnerHash,
  runnerKeyThumbprint,
  runnerSecret,
  seedSyntheticWorkspace,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type HubCommand,
  type PolicySettings,
  type RunnerChallenge,
  type RunnerTokenClaims,
} from "@bfb/domain";
import type {
  CheckoutLeaseObservation,
  LaunchClaimResult,
  LaunchFinalRequest,
  LaunchReconciliation,
  LaunchStartRequest,
  RunnerInventory,
} from "@bfb/protocol";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.launches.test";
// RunnerChannels owns a real clock, so the initial signed pull must share its wall time.
const INITIAL = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const SIGNING = "c09-runtime-current-signing-key-84d1e9";
const SESSION = "c09-synthetic-session",
  SESSION_TOKEN = "c09-synthetic-session-token";
const cookie = `__Host-bfb_session=${encodeURIComponent(`${SESSION_TOKEN}.${createHmac("sha256", SIGNING).update(SESSION_TOKEN).digest("base64")}`)}`;
const csrf = `2.${createHmac("sha256", SIGNING).update(`bfb-csrf:${SESSION}`).digest("hex")}`;
const DIGEST = `sha256:${"a".repeat(64)}`,
  EMPTY = `sha256:${runnerHash("{}")}`;
const migrationDir = await mkdtemp(resolve(tmpdir(), "bfb-c09-migrations-"));
const manifest = loadMigrationManifest(resolve(root, "migrations/d1"));
const c09 = manifest.migrations.findIndex(
  (migration) => migration.id === "0016_launch_orchestration",
);
assert(c09 >= 0, "C09 migration is required");
for (const migration of manifest.migrations.slice(0, c09))
  await copyFile(
    resolve(root, "migrations/d1", migration.file),
    resolve(migrationDir, migration.file),
  );
const database = {
  binding: "DB",
  database_name: "bfb-launches-test",
  database_id: "00000000-0000-4000-8000-000000000009",
  migrations_dir: migrationDir,
};
const base = {
  compatibility_date: "2026-08-08",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [
    database,
    {
      ...database,
      binding: "EMPTY_DB",
      database_name: "bfb-launches-empty-test",
      database_id: "00000000-0000-4000-8000-000000000019",
      migrations_dir: resolve(root, "migrations/d1"),
    },
  ],
};
const control = {
  ...base,
  main: resolve(root, "tools/launches/worker.ts"),
  vars: {
    ENVIRONMENT: "local",
    JURISDICTION: "global",
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.launches.test",
    LAUNCH_ORIGIN: "https://launch.launches.test",
    BETTER_AUTH_SECRETS: `2:${SIGNING},1:c09-runtime-previous-signing-key-3f71bc`,
    GITHUB_CLIENT_ID: "c09-synthetic-github-client",
    GITHUB_CLIENT_SECRET: "c09-synthetic-github-secret",
    AUTH_ABUSE_SECRET: "c09-synthetic-abuse-key-2b69a4ecxx-long",
  },
  r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-launches-artifacts" }],
  queues: {
    producers: [
      { binding: "JOBS", queue: "bfb-launches-jobs" },
      { binding: "JOBS_DLQ", queue: "bfb-launches-dlq" },
    ],
  },
  assets: { directory: resolve(root, "apps/web/dist"), binding: "ASSETS" },
  durable_objects: {
    bindings: [
      { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-launches-hub" },
    ],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...control, name: "bfb-launches-a" } },
    { config: { ...control, name: "bfb-launches-b" } },
    {
      config: {
        ...base,
        name: "bfb-launches-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
  ],
});
let now = INITIAL;
function send(
  index: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  raw?: string,
) {
  return server.getWorker(index % 2 ? "bfb-launches-b" : "bfb-launches-a").fetch(ORIGIN + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "192.0.2.109",
      "x-c09-test-time": now,
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
  });
}
function browser(index: number, action: string, body: unknown) {
  return send(index, `/api/v1/workspaces/${FIX.workspace}/${action}`, body, {
    cookie,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-bfb-csrf": csrf,
  });
}
async function accepted<T>(response: Awaited<ReturnType<typeof send>>, status = 200): Promise<T> {
  assert.equal(
    response.status,
    status,
    `unexpected status ${response.status}: ${await response.clone().text()}`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as T;
}
type Launch = {
  launch_id: string;
  run_id: string;
  run_execution_id: string;
  assignment_generation: number;
  state: string;
};
type Claimed = { state: "claimed"; claim: LaunchClaimResult };
type Control = { control_id: string; state: string; expires_at: string; resume_launch_id?: string };

try {
  await server.listen();
  const worker = server.getWorker("bfb-launches-a"),
    hubWorker = server.getWorker("bfb-launches-hub");
  await worker.applyD1Migrations("EMPTY_DB");
  await worker.applyD1Migrations("DB");
  const env = (await worker.getEnv()) as unknown as { DB: D1Like; EMPTY_DB: D1Like },
    db = adaptD1(env.DB);
  assert.deepEqual(await adaptD1(env.EMPTY_DB).prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    await adaptD1(env.EMPTY_DB).prepare("SELECT COUNT(*) AS count FROM launch_commands").get(),
    { count: 0 },
  );
  // Global routing is the Workerd-supported namespace. C04 tests cover persisted EU/US selection.
  await seedSyntheticWorkspace(db, now, "global");
  const seedHub = new WorkspaceHub(db);
  async function human<I, R>(command: HubCommand<I, R>, input: I): Promise<R> {
    const outcome = await seedHub.execute(command, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now,
      idempotencyKey: randomUlid(),
      input,
    });
    assert(outcome.ok, JSON.stringify(outcome));
    return outcome.result;
  }
  const ordinary: PolicySettings = {
    allowedProviders: ["claude", "codex", "grok"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand, { ...ordinary, expectedVersion: 1 });
  await human(updateProjectPolicyCommand, {
    ...ordinary,
    projectId: FIX.projectA,
    expectedVersion: 1,
  });
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: EMPTY,
  });
  const oldTask = await human(createTaskCommand, {
    projectId: FIX.projectA,
    title: "Synthetic preserved C08 task",
    priority: "P2",
  });
  const oldRun = randomUlid(),
    oldSnapshot = randomUlid(),
    oldExecution = randomUlid(),
    oldSession = randomUlid();
  await db
    .prepare(
      `INSERT INTO runs (workspace_id, id, project_id, task_id, requested_by_human_id, agent_profile_id, result_state, activity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', 'unknown', ?)`,
    )
    .run(FIX.workspace, oldRun, FIX.projectA, oldTask.id, FIX.owner, FIX.profileCodex, now);
  await db
    .prepare(
      `INSERT INTO run_configuration_snapshots (workspace_id, id, project_id, run_id, workspace_policy_version, project_policy_version,
    repository_config_version, agent_profile_id, agent_profile_version, canonical_json, content_hash, created_at)
    VALUES (?, ?, ?, ?, 2, 2, 2, ?, 1, '{"synthetic":"preserved"}', ?, ?)`,
    )
    .run(FIX.workspace, oldSnapshot, FIX.projectA, oldRun, FIX.profileCodex, DIGEST, now);
  await db
    .prepare(
      `INSERT INTO run_executions (workspace_id, id, run_id, state, created_at) VALUES (?, ?, ?, 'attached', ?)`,
    )
    .run(FIX.workspace, oldExecution, oldRun, now);
  await db
    .prepare(
      `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, started_at)
    VALUES (?, ?, ?, ?, 'codex', 'synthetic-preserved-session', 'active', ?)`,
    )
    .run(FIX.workspace, oldSession, oldRun, oldExecution, now);
  const preservedTables = [
    "agent_profiles",
    "agent_profile_versions",
    "runs",
    "run_executions",
    "provider_sessions",
    "run_configuration_snapshots",
  ];
  const before = await Promise.all(
    preservedTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()),
  );
  for (const migration of manifest.migrations.slice(c09))
    await copyFile(
      resolve(root, "migrations/d1", migration.file),
      resolve(migrationDir, migration.file),
    );
  await worker.applyD1Migrations("DB");
  for (const [index, table] of preservedTables.entries()) {
    const rows = (await db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()) as Record<
      string,
      unknown
    >[];
    if (table === "run_configuration_snapshots")
      for (const row of rows) {
        assert.equal(row.snapshot_generation, 1);
        delete row.snapshot_generation;
      }
    assert.deepEqual(rows, before[index], `${table} history changed during upgrade`);
  }
  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  for (const table of ["agent_profile_versions", "run_configuration_snapshots"])
    await assert.rejects(db.prepare(`DELETE FROM ${table}`).run());
  console.log(
    "C09_D1_MIGRATION_OK populated 0015 upgrade preserves profiles, snapshots, sessions and foreign keys",
  );

  await db
    .prepare(
      `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES ('c09-user', 'Synthetic Launch Owner', 'owner@synthetic.test', 1, ?, ?)`,
    )
    .run(now, now);
  await db
    .prepare(`UPDATE humans SET better_auth_user_id = 'c09-user' WHERE id = ?`)
    .run(FIX.owner);
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-09-12T12:00:00.000Z', ?, ?, ?, 'c09-user')`,
    )
    .run(SESSION, SESSION_TOKEN, now, now);
  const policy: PolicySettings = {
    ...ordinary,
    allowedProviders: [...ordinary.allowedProviders, "fake"],
  };
  await human(updateWorkspacePolicyCommand, { ...policy, expectedVersion: 2 });
  await human(updateProjectPolicyCommand, {
    ...policy,
    projectId: FIX.projectA,
    expectedVersion: 2,
  });
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 2,
    document: {},
    contentHash: EMPTY,
  });
  const profile = await human(createAgentProfileCommand, {
    name: "Synthetic C09 adapter",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey),
    publicKey = await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const runner = randomUlid(),
    checkout = randomUlid(),
    alias = randomUlid(),
    tokenId = randomUlid(),
    thumbprint = runnerKeyThumbprint(publicKey),
    secret = runnerSecret();
  const claims: RunnerTokenClaims = {
    v: 1,
    sub: runner,
    workspace_id: FIX.workspace,
    aud: "bfb-runner",
    iss: ORIGIN,
    jti: tokenId,
    iat: Date.parse(now) / 1000,
    exp: Date.parse(launchDeadline(now, 300_000)) / 1000,
    authorization_epoch: 1,
    owner_authorization_epoch: 1,
    grant_epoch: 1,
    token_epoch: 1,
    cnf: { jkt: thumbprint },
  };
  // C06 certifies token issuance; this isolated C09 fixture seeds one real signed-request credential.
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
    VALUES (?, ?, ?, 'Synthetic C09 Mac', ?, ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, JSON.stringify(publicKey), thumbprint, now);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, now);
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash(secret),
      JSON.stringify(claims),
      launchDeadline(now, 300_000),
    );
  const token = encodeRunnerToken(claims, secret),
    native = `/runner/workspaces/${FIX.workspace}/runners/${runner}`;
  async function possession(index: number, action: string, bytes: string, method = "POST") {
    const path = `${native}/${action}`;
    const challenge = (
      await accepted<{ challenge: RunnerChallenge }>(
        await send(index, native + "/challenge", {
          purpose: "request",
          token,
          request: { method, path, body_sha256: runnerHash(bytes) },
        }),
      )
    ).challenge;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      runnerChallengeTranscript(challenge),
    );
    return Buffer.from(
      JSON.stringify({
        challenge_id: challenge.challenge_id,
        server_nonce: challenge.server_nonce,
        signature: Buffer.from(signature).toString("base64url"),
        token,
      }),
    ).toString("base64url");
  }
  async function signed(index: number, action: string, body: unknown, raw?: string) {
    const bytes = raw ?? JSON.stringify(body);
    return send(
      index,
      `${native}/${action}`,
      undefined,
      { "x-bfb-runner-proof": await possession(index, action, bytes) },
      bytes,
    );
  }
  let revision = 0;
  async function inventory(configHash = EMPTY) {
    const baseCheckout = {
      schema_version: 1 as const,
      workspace_id: FIX.workspace,
      runner_id: runner,
      project_id: FIX.projectA,
      label: "Synthetic C09 checkout",
      repository_identity: "synthetic/c09",
      workspace_subpath: ".",
      physical_worktree_hash: DIGEST,
      repository_config_hash: configHash,
      is_default: true,
      dirty: false,
      status: "validated" as const,
      validated_at: now,
    };
    const document: RunnerInventory = {
      schema_version: 1,
      workspace_id: FIX.workspace,
      runner_id: runner,
      revision: ++revision,
      checkouts: [
        { ...baseCheckout, checkout_id: checkout },
        { ...baseCheckout, checkout_id: alias, is_default: false },
      ],
      providers: [
        {
          provider: "fake",
          version: "1.0.0",
          manifest_id: DIGEST,
          status: "healthy",
          observed_at: now,
          expires_at: launchDeadline(now, 30_000),
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
    };
    await accepted(await signed(0, "inventory", document));
  }
  async function startInput(checkoutId = checkout): Promise<LaunchStartRequest> {
    const task = await human(createTaskCommand, {
      projectId: FIX.projectA,
      title: "Synthetic C09 race",
      priority: "P2",
    });
    return {
      schema_version: 1,
      idempotency_key: randomUlid(),
      task_id: task.id,
      expected_task_version: 1,
      runner_id: runner,
      checkout_id: checkoutId,
      agent_profile_id: profile.id,
      agent_profile_version: 1,
      workspace_policy_version: 3,
      project_policy_version: 3,
      repository_config_version: 3,
    };
  }
  function claimInput(launch: Launch, idempotencyKey = randomUlid()) {
    return {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: runner,
      idempotency_key: idempotencyKey,
      claimed_at: now,
    };
  }
  function finalInput(claim: LaunchClaimResult): LaunchFinalRequest {
    const spec = claim.specification;
    return {
      schema_version: 1,
      launch_id: spec.launch_id,
      run_execution_id: spec.run_execution_id,
      assignment_generation: spec.assignment_generation,
      fencing_generation: claim.fencing_generation,
      config_snapshot_id: spec.config_snapshot_id,
      config_snapshot_hash: spec.config_snapshot_hash,
      repository_config_hash: claim.snapshot.repository_config_hash,
      physical_worktree_hash: claim.snapshot.physical_worktree_hash,
      supervisor: { pid: 1234, start_identity: "123456:1000", executable_hash: DIGEST },
      local_lock_id: randomUlid(),
    };
  }
  function live(final: LaunchFinalRequest): CheckoutLeaseObservation {
    return {
      schema_version: 1,
      run_execution_id: final.run_execution_id,
      assignment_generation: final.assignment_generation,
      fencing_generation: final.fencing_generation,
      sequence: 1,
      observed_at: now,
      operation: "renew",
      supervisor: final.supervisor,
      local_lock_id: final.local_lock_id,
      owned_group_id: 1235,
      owned_group_start_identity: "123457:1000",
      supervisor_state: "verified",
      group_state: "live",
      lock_state: "held",
      descendants_state: "contained",
      recovery_local: false,
    };
  }
  await inventory();
  const connected = await server.getWorker("bfb-launches-a").fetch(ORIGIN + native + "/connect", {
    headers: {
      upgrade: "websocket",
      "sec-websocket-protocol": "bfb.runner.v1",
      "x-c09-test-time": now,
      "cf-connecting-ip": "192.0.2.109",
      "x-bfb-runner-proof": await possession(0, "connect", "", "GET"),
    },
  });
  assert.equal(connected.status, 101);
  const socket = connected.webSocket;
  assert(socket);
  const messages: { kind: string }[] = [];
  const listeners = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as { kind: string });
    for (const listener of listeners) listener();
  });
  socket.accept();
  async function waitMessage(kind: string) {
    if (messages.some((message) => message.kind === kind)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`missing synthetic channel message ${kind}`));
      }, 10_000);
      function check() {
        if (messages.some((message) => message.kind === kind)) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve();
        }
      }
      listeners.add(check);
      check();
    });
  }
  await waitMessage("runner.channel.ready");
  const start = await startInput();
  const atomicTables = [
    "launch_commands",
    "execution_assignments",
    "checkout_leases",
    "runs",
    "run_executions",
    "run_configuration_snapshots",
    "semantic_events",
    "audit_events",
    "outbox_records",
    "idempotency_records",
    "workspace_cursors",
  ];
  const rollbackBefore = await Promise.all(
    atomicTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()),
  );
  await db
    .prepare(
      `CREATE TRIGGER c09_fail_launch_outbox BEFORE INSERT ON outbox_records WHEN NEW.kind = 'launch.start'
    BEGIN SELECT RAISE(ABORT, 'synthetic C09 commit failure'); END`,
    )
    .run();
  assert.equal((await browser(0, "launches", start)).status, 403);
  assert.deepEqual(
    await Promise.all(
      atomicTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()),
    ),
    rollbackBefore,
  );
  assert.deepEqual(
    await db.prepare(`SELECT state, resource_version FROM tasks WHERE id = ?`).get(start.task_id),
    { state: "ready", resource_version: 1 },
  );
  await db.prepare("DROP TRIGGER c09_fail_launch_outbox").run();
  const starts = await Promise.all(
    [0, 1].map(async (index) => accepted<Launch>(await browser(index, "launches", start), 201)),
  );
  assert.equal(starts[0]!.launch_id, starts[1]!.launch_id);
  const launched = starts[0]!;
  const competitor = await accepted<Launch>(
    await browser(1, "launches", await startInput(alias)),
    201,
  );
  const wake = await accepted<{ intent_id: string }>(
    await browser(0, "launches/wake", { schema_version: 1, launch_id: launched.launch_id }),
    201,
  );
  const wakeRace = await Promise.all(
    [0, 1].map((index) =>
      signed(index, "wake/redeem", { schema_version: 1, wake_intent_id: wake.intent_id }),
    ),
  );
  assert.deepEqual(wakeRace.map((response) => response.status).sort(), [200, 403]);
  await waitMessage("runner.commands.available");
  socket.close(1000, "synthetic missed-nudge recovery");
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS count FROM execution_assignments").get(), {
    count: 2,
  });
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS count FROM checkout_leases").get(), {
    count: 0,
  });
  const pulled = await accepted<{ commands: { command_id: string }[] }>(
    await signed(1, "commands/pull", {}),
  );
  assert(
    pulled.commands.some((command) => command.command_id === launched.launch_id),
    "missed nudge must retain durable launch",
  );
  const claim = claimInput(launched),
    competingClaim = claimInput(competitor);
  const claimRace = await Promise.all([
    signed(0, "launch/claim", claim),
    signed(1, "launch/claim", competingClaim),
  ]);
  const outcomes = await Promise.all(
    claimRace.map((response) => accepted<{ state: string; claim?: LaunchClaimResult }>(response)),
  );
  assert.equal(outcomes.filter((result) => result.state === "claimed").length, 1);
  assert.equal(outcomes.filter((result) => result.state === "rejected").length, 1);
  const winnerIndex = outcomes.findIndex((result) => result.state === "claimed"),
    winner = [launched, competitor][winnerIndex]!;
  const winnerRequest = [claim, competingClaim][winnerIndex]!,
    won = outcomes[winnerIndex]!.claim!;
  assert.equal(won.fencing_generation, 1);
  const retries = await Promise.all(
    [0, 1].map(async (index) =>
      accepted<Claimed>(await signed(index, "launch/claim", winnerRequest)),
    ),
  );
  assert(
    retries.every(
      (result) =>
        result.claim.specification.run_execution_id === won.specification.run_execution_id &&
        result.claim.fencing_generation === 1,
    ),
  );
  await hubWorker.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
  assert.equal(
    (await accepted<Claimed>(await signed(1, "launch/claim", winnerRequest))).claim
      .fencing_generation,
    1,
  );
  const final = finalInput(won);
  assert.equal(
    (await accepted<{ decision: string }>(await signed(0, "launch/authorize", final))).decision,
    "authorized",
  );
  const observation = live(final);
  assert.equal(
    (await accepted<{ state: string }>(await signed(0, "leases/observe", observation))).state,
    "live",
  );
  console.log(
    "C09_D1_CLAIM_OK duplicate Start, physical-alias race, single-use wake, missed nudge, retry and Hub eviction",
  );

  const controlInput = {
    schema_version: 1,
    idempotency_key: randomUlid(),
    runner_id: runner,
    run_execution_id: final.run_execution_id,
    assignment_generation: final.assignment_generation,
    action: "interrupt",
  };
  const controls = await Promise.all(
    [0, 1].map(async (index) =>
      accepted<Control>(await browser(index, "run-controls", controlInput), 201),
    ),
  );
  assert.equal(controls[0]!.control_id, controls[1]!.control_id);
  const offered = await accepted<Control & { action: string; run_execution_id: string }>(
    await signed(1, "controls/read", { schema_version: 1, control_id: controls[0]!.control_id }),
  );
  assert.equal(offered.action, "interrupt");
  assert.equal(offered.run_execution_id, final.run_execution_id);
  assert.equal(offered.state, "pending");
  const controlClaim = {
    schema_version: 1,
    control_id: controls[0]!.control_id,
    idempotency_key: randomUlid(),
    run_execution_id: final.run_execution_id,
    assignment_generation: final.assignment_generation,
    action: "interrupt",
  };
  const delivered = await Promise.all(
    [0, 1].map(async (index) =>
      accepted<Control>(await signed(index, "controls/claim", controlClaim)),
    ),
  );
  assert(delivered.every((result) => result.state === "claimed"));
  const acknowledgement = { ...controlClaim, action: undefined, disposition: "applied" };
  const acknowledged = await Promise.all(
    [0, 1].map(async (index) =>
      accepted<Control>(await signed(index, "controls/acknowledge", acknowledgement)),
    ),
  );
  assert(acknowledged.every((result) => result.state === "applied"));
  assert.equal(
    (await signed(1, "controls/claim", { ...controlClaim, assignment_generation: 2 })).status,
    403,
  );
  assert.equal(
    (
      await accepted<{ state: string }>(
        await signed(1, "leases/observe", {
          ...observation,
          sequence: 2,
          descendants_state: "escaped",
        }),
      )
    ).state,
    "containment_unknown",
  );
  now = launchDeadline(INITIAL, 121_000);
  await inventory();
  await hubWorker.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
  const blockedStart = await startInput();
  assert.equal((await browser(1, "launches", blockedStart)).status, 403);
  const gone = {
    ...observation,
    observed_at: now,
    sequence: 3,
    operation: "release",
    supervisor_state: "gone",
    group_state: "gone",
    lock_state: "gone",
    descendants_state: "gone",
  };
  assert.equal(
    (await accepted<{ state: string }>(await signed(0, "leases/observe", gone))).state,
    "containment_unknown",
  );
  assert.equal(
    (
      await accepted<{ state: string }>(
        await signed(1, "leases/observe", {
          ...gone,
          sequence: 4,
          operation: "recover",
          recovery_local: true,
        }),
      )
    ).state,
    "released",
  );
  const result = await db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(winner.run_id);
  assert.deepEqual(result, { result_state: "open" });
  console.log(
    "C09_D1_CONTAINMENT_OK one control disposition; escaped child survives TTL and eviction until explicit full-group/lock recovery",
  );

  const observedSession = randomUlid();
  await db
    .prepare(
      `INSERT INTO provider_sessions (workspace_id, id, run_id, execution_id, provider, observed_session_id, state, started_at)
    VALUES (?, ?, ?, ?, 'fake', 'synthetic-c09-resume', 'active', ?)`,
    )
    .run(FIX.workspace, observedSession, winner.run_id, final.run_execution_id, INITIAL);
  const resume = await accepted<Control>(
    await browser(0, "run-controls", {
      ...controlInput,
      idempotency_key: randomUlid(),
      action: "resume",
    }),
    201,
  );
  const resumeClaim = {
    ...controlClaim,
    control_id: resume.control_id,
    idempotency_key: randomUlid(),
    action: "resume",
  };
  const resumeRace = await Promise.all(
    [0, 1].map(async (index) =>
      accepted<Control>(await signed(index, "controls/claim", resumeClaim)),
    ),
  );
  assert.equal(resumeRace[0]!.resume_launch_id, resumeRace[1]!.resume_launch_id);
  assert(resumeRace[0]!.resume_launch_id);
  const resumed = await accepted<Claimed>(
    await signed(0, "launch/claim", {
      ...claimInput(winner),
      launch_id: resumeRace[0]!.resume_launch_id,
    }),
  );
  assert.equal(resumed.claim.specification.run_id, winner.run_id);
  assert.notEqual(resumed.claim.specification.run_execution_id, final.run_execution_id);
  assert.equal(resumed.claim.fencing_generation, 2);
  assert.equal(resumed.claim.specification.expires_at, resume.expires_at);
  assert.equal(resumed.claim.specification.resume_session?.provider_session_id, observedSession);
  const resumedFinal = finalInput(resumed.claim);
  // Final authorization must observe a grant loss even after a successful claim.
  await db
    .prepare(
      `DELETE FROM runner_launch_grants WHERE workspace_id = ? AND runner_id = ? AND human_id = ?`,
    )
    .run(FIX.workspace, runner, FIX.owner);
  assert.equal(
    (await accepted<{ decision: string }>(await signed(1, "launch/authorize", resumedFinal)))
      .decision,
    "rejected",
  );
  assert.deepEqual(
    await db.prepare(`SELECT state FROM checkout_leases WHERE runner_id = ?`).get(runner),
    { state: "reserved" },
  );
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, now);
  await accepted(
    await signed(0, "leases/observe", {
      schema_version: 1,
      run_execution_id: resumedFinal.run_execution_id,
      assignment_generation: resumedFinal.assignment_generation,
      fencing_generation: 2,
      sequence: 1,
      observed_at: now,
      operation: "release",
      local_lock_id: resumedFinal.local_lock_id,
      owned_group_id: 0,
      owned_group_start_identity: "",
      supervisor_state: "never_started",
      group_state: "never_started",
      lock_state: "never_acquired",
      descendants_state: "none",
      recovery_local: false,
    }),
  );
  console.log(
    "C09_D1_RESUME_OK one exact-session resume creates a new execution and fence; final revocation never releases occupancy",
  );

  const expiring = await accepted<Launch>(await browser(0, "launches", blockedStart), 201);
  now = launchDeadline(INITIAL, 242_000);
  await inventory();
  const unclaimedRequest = claimInput(expiring);
  const expired = await accepted<{ state: string }>(
    await signed(1, "launch/claim", unclaimedRequest),
  );
  assert.equal(expired.state, "expired");
  assert.deepEqual(
    await db
      .prepare(`SELECT state, end_reason FROM run_executions WHERE id = ?`)
      .get(expiring.run_execution_id),
    { state: "ended", end_reason: "launch_expired" },
  );
  assert.deepEqual(
    await db.prepare(`SELECT result_state FROM runs WHERE id = ?`).get(expiring.run_id),
    { result_state: "open" },
  );
  const fresh = await accepted<Launch>(await browser(0, "launches", await startInput()), 201);
  // One Start consumes one shared browser budget slot; both isolates must share the remaining nineteen.
  const abuse = await Promise.all(
    Array.from({ length: 22 }, (_, index) =>
      browser(index, "launches/wake", { schema_version: 1, launch_id: fresh.launch_id }),
    ),
  );
  assert.equal(abuse.filter((response) => response.status === 201).length, 19);
  assert.equal(abuse.filter((response) => response.status === 403).length, 3);
  for (const response of abuse.filter((response) => response.status === 403))
    assert.deepEqual(await response.json(), {
      error: "request_rejected",
      message: "request rejected",
    });
  const rawWakes = [wake.intent_id];
  for (const response of abuse.filter((response) => response.status === 201))
    rawWakes.push(((await response.json()) as { intent_id: string }).intent_id);
  const lostClaim = claimInput(fresh);
  // Discard the successful claim response; only the persisted request survives on the Mac.
  await accepted<Claimed>(await signed(0, "launch/claim", lostClaim));
  const retainedLease = await db
    .prepare(`SELECT * FROM checkout_leases WHERE runner_id = ?`)
    .get(runner);
  await hubWorker.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
  const unclaimed = await accepted<LaunchReconciliation>(
    await signed(1, "launch/reconcile", unclaimedRequest),
  );
  assert.equal(unclaimed.reservation_state, "never_acquired");
  assert.equal(unclaimed.run_execution_id, expiring.run_execution_id);
  assert.equal(unclaimed.launch_state, "expired");
  for (const field of [
    "fencing_generation",
    "observation_sequence",
    "lease_expires_at",
    "specification",
    "snapshot",
  ])
    assert(!(field in unclaimed), "never-acquired receipt disclosed another reservation");
  assert.deepEqual(
    await db.prepare(`SELECT * FROM checkout_leases WHERE runner_id = ?`).get(runner),
    retainedLease,
  );
  now = launchDeadline(now, 46_000);
  await inventory();
  assert.equal((await signed(1, "launch/claim", lostClaim)).status, 403);
  await hubWorker.evictDurableObject("WorkspaceHub", { name: FIX.workspace });
  const reconciled = await accepted<LaunchReconciliation>(
    await signed(1, "launch/reconcile", lostClaim),
  );
  assert.equal(reconciled.run_execution_id, fresh.run_execution_id);
  assert.equal(reconciled.reservation_state, "reserved");
  assert.equal(reconciled.observation_sequence, 0);
  assert(!("specification" in reconciled) && !("snapshot" in reconciled));
  assert.deepEqual(
    await db.prepare(`SELECT * FROM checkout_leases WHERE runner_id = ?`).get(runner),
    retainedLease,
  );
  assert.equal(
    (await signed(0, "launch/reconcile", { ...lostClaim, idempotency_key: randomUlid() })).status,
    403,
  );
  await accepted(
    await signed(0, "launch/reject", {
      schema_version: 1,
      launch_id: reconciled.launch_id,
      run_execution_id: reconciled.run_execution_id,
      assignment_generation: reconciled.assignment_generation,
    }),
  );
  assert.equal(
    (
      await accepted<{ state: string }>(
        await signed(1, "leases/observe", {
          schema_version: 1,
          run_execution_id: reconciled.run_execution_id,
          assignment_generation: reconciled.assignment_generation,
          fencing_generation: reconciled.fencing_generation,
          sequence: reconciled.observation_sequence! + 1,
          observed_at: now,
          operation: "release",
          local_lock_id: randomUlid(),
          owned_group_id: 0,
          owned_group_start_identity: "",
          supervisor_state: "never_started",
          group_state: "never_started",
          lock_state: "never_acquired",
          descendants_state: "none",
          recovery_local: false,
        }),
      )
    ).state,
    "released",
  );
  assert.equal(
    (await accepted<LaunchReconciliation>(await signed(0, "launch/reconcile", lostClaim)))
      .reservation_state,
    "released",
  );
  console.log(
    "C09_D1_RECONCILE_OK lost claim and never-acquired rejection survive expiry and Hub eviction; cleanup metadata neither renews authority nor exposes another fence",
  );
  const canaries = [...rawWakes, token, secret, SESSION_TOKEN];
  for (const table of [
    "launch_wake_intents",
    "audit_events",
    "semantic_events",
    "outbox_records",
    "idempotency_records",
    "rate_limit_buckets",
  ]) {
    const data = JSON.stringify(await db.prepare(`SELECT * FROM ${table}`).all());
    for (const canary of canaries)
      assert(!data.includes(canary), `${table} contains capability material`);
  }
  const logs = JSON.stringify(server.getLogs());
  for (const canary of canaries)
    assert(!logs.includes(canary), "runtime logs contain capability material");
  assert.deepEqual(await db.prepare("PRAGMA foreign_key_check").all(), []);
  console.log(
    "C09_D1_OK expiry has no launch authority; two Worker isolates share durable wake/control budgets; capability scans are clean",
  );
} finally {
  await server.close();
  await rm(migrationDir, { recursive: true, force: true });
}
