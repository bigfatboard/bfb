// ABOUTME: Proves held E02 public positions and preserved runner ingestion over real Workers and D1.
// ABOUTME: Synthetic identities certify admission denial, not an available browser replay or live service.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, createAuthorizationContext, type D1Like } from "@bfb/db";
import {
  authorizeSyntheticPolicyUpdate,
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  FIX,
  ingestRunnerEventsCommand,
  launchDeadline,
  listLedgerEvents,
  randomUlid,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  type CommandOutcome,
  type IngestRunnerEventsResult,
  type PolicySettings,
  type RunnerPrincipal,
  type TaskRecord,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const now = "2026-09-12T12:00:00.000Z",
  origin = "https://bfb.realtime.test";
// Browser socket expiry runs on production wall-clock time inside the DO, so
// harness session expiries stay relative to the real clock, not fixture time.
const sessionExpiry = new Date(Date.now() + 3_600_000).toISOString();
const sessionExpiredAt = new Date(Date.now() - 3_600_000).toISOString();
const digest = `sha256:${"a".repeat(64)}`,
  emptyConfig = `sha256:${runnerHash("{}")}`;
const base = { compatibility_date: "2026-08-08", compatibility_flags: ["nodejs_compat"] };
const client = {
  ...base,
  main: resolve(root, "tools/realtime/worker.ts"),
  durable_objects: {
    bindings: [
      { name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-realtime-hub" },
    ],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...client, name: "bfb-realtime-a" } },
    { config: { ...client, name: "bfb-realtime-b" } },
    {
      config: {
        ...base,
        name: "bfb-realtime-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        d1_databases: [
          {
            binding: "DB",
            database_name: "bfb-realtime-test",
            database_id: "00000000-0000-4000-8000-000000000021",
            migrations_dir: resolve(root, "migrations/d1"),
          },
        ],
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
  ],
});

let sequence = 0;
async function execute<T>(
  name: string,
  input: unknown,
  actor: {
    actorHumanId?: string;
    actorRunnerId?: string;
    authorizationEpoch?: number;
    workspaceId?: string;
  } = { actorHumanId: FIX.owner },
) {
  const worker = server.getWorker(sequence++ % 2 ? "bfb-realtime-b" : "bfb-realtime-a");
  const workspaceId = actor.workspaceId ?? FIX.workspace;
  const response = await worker.fetch(`${origin}/workspaces/${workspaceId}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandName: name,
      request: {
        workspaceId,
        idempotencyKey: randomUlid(),
        authorizationEpoch: 1,
        now,
        ...actor,
        input,
      },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as CommandOutcome<T>;
}
function success<T>(outcome: CommandOutcome<T>): T {
  assert(outcome.ok, JSON.stringify(outcome));
  return outcome.result;
}
async function human<T>(name: string, input: unknown) {
  return success(await execute<T>(name, input));
}

const runner = randomUlid(),
  checkout = randomUlid(),
  tokenId = randomUlid(),
  stream = randomUlid();
let sourceSequence = 0;
const principal: RunnerPrincipal = {
  kind: "runner",
  workspaceId: FIX.workspace,
  runnerId: runner,
  ownerHumanId: FIX.owner,
  authorizationEpoch: 1,
  ownerAuthorizationEpoch: 1,
  grantEpoch: 1,
  tokenEpoch: 1,
  tokenId,
  keyThumbprint: "synthetic-e02-harness-key",
  // Ingest authority uses the queued transaction's real clock, not fixture time.
  authExpiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 300_000).toISOString(),
  projectIds: [FIX.projectA],
};

async function nativeIngest(
  kinds: string[],
  extra: Record<string, unknown> = {},
): Promise<IngestRunnerEventsResult> {
  const events = kinds.map((kind) => {
    sourceSequence += 1;
    return {
      schema_version: 1,
      event_id: randomUlid(),
      source_stream_id: stream,
      source_sequence: sourceSequence,
      run_execution_id: executionId,
      assignment_generation: generation,
      kind,
      occurred_at: now,
      capture_origin: "runner_observed",
      payload: {},
      ...extra,
    };
  });
  return success(
    await execute<IngestRunnerEventsResult>(
      ingestRunnerEventsCommand.name,
      { principal, events },
      { actorRunnerId: runner },
    ),
  );
}

let executionId = "",
  generation = 0;

interface SocketTap {
  messages: string[];
  closes: Array<{ code: number }>;
  close(): void;
  send(data: string): void;
  readyState(): number;
}

async function connect(
  handshake: Record<string, unknown>,
): Promise<{ status: number; tap: SocketTap | null }> {
  const worker = server.getWorker("bfb-realtime-a");
  const response = await worker.fetch(`${origin}/realtime-test/${FIX.workspace}/connect`, {
    method: "GET",
    headers: {
      Upgrade: "websocket",
      "sec-websocket-protocol": "bfb.browser.v1",
      "x-bfb-browser-principal": JSON.stringify(handshake),
    },
  });
  if (response.status !== 101 || !response.webSocket) return { status: response.status, tap: null };
  const socket = response.webSocket as unknown as {
    accept(): void;
    send(data: string): void;
    close(): void;
    readonly readyState: number;
    addEventListener(
      type: string,
      listener: (event: { data?: unknown; code?: number }) => void,
    ): void;
  };
  const tap: SocketTap = {
    messages: [],
    closes: [],
    close: () => socket.close(),
    send: (data: string) => socket.send(data),
    readyState: () => socket.readyState,
  };
  socket.addEventListener("message", (event) => tap.messages.push(String(event.data)));
  socket.addEventListener("close", (event) => tap.closes.push({ code: event.code ?? 0 }));
  socket.accept();
  return { status: 101, tap };
}

function browserPrincipal(
  humanId: string,
  sessionId: string,
  role: string,
  sessionExpiresAt: string,
): Record<string, unknown> {
  return {
    schema_version: 1,
    workspaceId: FIX.workspace,
    humanId,
    authorizationEpoch: 1,
    role,
    sessionId,
    sessionExpiresAt,
  };
}

try {
  await server.listen();
  const hub = server.getWorker("bfb-realtime-hub");
  await hub.applyD1Migrations("DB");
  const env = (await hub.getEnv()) as unknown as { DB: D1Like },
    db = adaptD1(env.DB);

  await seedSyntheticWorkspace(db, now, "eu");
  for (const [humanId, userId, sessionId] of [
    [FIX.owner, "auth-owner-e02", "e02-harness-owner-session"],
    [FIX.member, "auth-member-e02", "e02-harness-member-session"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO better_auth_users (id, name, email, email_verified, image, created_at, updated_at)
         VALUES (?, ?, ?, 1, NULL, ?, ?)`,
      )
      .run(userId, `E02 ${humanId}`, `${userId}@synthetic.test`, now, now);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions
         (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(sessionId, sessionExpiry, `synthetic-token-${sessionId}`, now, now, userId);
    await db.prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`).run(userId, humanId);
  }

  const policy: Omit<PolicySettings, "offlineAgentWork" | "offlineAgentResults"> = {
    allowedProviders: ["fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(
    updateWorkspacePolicyCommand.name,
    await authorizeSyntheticPolicyUpdate(
      db,
      {
        workspaceId: FIX.workspace,
        humanId: FIX.owner,
      },
      { ...policy, expectedVersion: 1 },
    ),
  );
  await human(
    updateProjectPolicyCommand.name,
    await authorizeSyntheticPolicyUpdate(
      db,
      {
        workspaceId: FIX.workspace,
        humanId: FIX.owner,
      },
      {
        ...policy,
        expectedVersion: 1,
        projectId: FIX.projectA,
      },
    ),
  );
  await human(reportRepositoryConfigCommand.name, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: emptyConfig,
  });
  const profile = await human<{ id: string }>(createAgentProfileCommand.name, {
    name: "Synthetic E02 harness provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<TaskRecord>(createTaskCommand.name, {
    projectId: FIX.projectA,
    title: "Synthetic E02 harness run",
    priority: "P2",
  });
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic E02 harness Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, principal.keyThumbprint, now);
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
      runnerHash("synthetic-e02-harness-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(now) / 1000,
        exp: Date.parse(principal.authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: principal.keyThumbprint },
      }),
      principal.authExpiresAt,
    );
  const inventory: RunnerInventory = {
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
        label: "Synthetic E02 checkout",
        repository_identity: "synthetic/e02",
        workspace_subpath: ".",
        physical_worktree_hash: digest,
        repository_config_hash: emptyConfig,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: now,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: digest,
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
  await success(
    await execute(
      replaceRunnerInventoryCommand.name,
      { principal, inventory },
      { actorRunnerId: runner },
    ),
  );
  const launch = await human<{ launch_id: string }>(startLaunchCommand.name, {
    schema_version: 1,
    idempotency_key: randomUlid(),
    task_id: task.id,
    expected_task_version: 1,
    runner_id: runner,
    checkout_id: checkout,
    agent_profile_id: profile.id,
    agent_profile_version: 1,
    workspace_policy_version: 2,
    project_policy_version: 2,
    repository_config_version: 2,
  });
  const claimed = success(
    await execute<{
      state: string;
      claim: { specification: { run_execution_id: string; assignment_generation: number } };
    }>(
      claimLaunchCommand.name,
      {
        principal,
        claim: {
          schema_version: 1,
          launch_id: launch.launch_id,
          runner_id: runner,
          idempotency_key: randomUlid(),
          claimed_at: now,
        },
      },
      { actorRunnerId: runner },
    ),
  );
  assert.equal(claimed.state, "claimed");
  executionId = claimed.claim.specification.run_execution_id;
  generation = claimed.claim.specification.assignment_generation;

  const ownerHandshake = browserPrincipal(
    FIX.owner,
    "e02-harness-owner-session",
    "owner",
    sessionExpiry,
  );
  const memberHandshake = browserPrincipal(
    FIX.member,
    "e02-harness-member-session",
    "member",
    sessionExpiry,
  );

  // New DO browser admissions are held before ready frames or socket allocation.
  for (const handshake of [ownerHandshake, memberHandshake]) {
    const admitted = await connect(handshake);
    assert.equal(admitted.status, 409);
    assert.equal(admitted.tap, null);
  }
  const committed = await nativeIngest(["heartbeat", "turn_started"]);
  assert.deepEqual(
    committed.dispositions.map((entry) => entry.disposition),
    ["accepted", "accepted"],
  );
  const hostile = "<script>alert(document.cookie)</script>";
  const hostileCommitted = await nativeIngest(["heartbeat"], { provider_session_id: hostile });
  assert.equal(hostileCommitted.dispositions[0]?.disposition, "accepted");
  const memberAuth = createAuthorizationContext({
    workspaceId: FIX.workspace,
    principalId: FIX.member,
    authorizationEpoch: 1,
    jurisdiction: "eu",
  });
  await assert.rejects(listLedgerEvents(db, memberAuth, { afterCursor: 0, throughCursor: 100 }), {
    code: "request_rejected",
    message: "event feeds are unavailable",
  });
  const retained = (await db
    .prepare(
      "SELECT event_id,provider_session_id FROM event_ledger WHERE workspace_id=? ORDER BY workspace_cursor",
    )
    .all(FIX.workspace)) as Array<{ event_id: string; provider_session_id: string | null }>;
  assert.equal(retained.length, 3);
  assert(retained.some((row) => row.provider_session_id === hostile));
  const again = await connect(ownerHandshake);
  assert.equal(again.status, 409);
  assert.equal(again.tap, null);
  const expired = await connect(
    browserPrincipal(FIX.owner, "e02-harness-owner-session", "owner", sessionExpiredAt),
  );
  assert.equal(expired.status, 403);
  console.log(
    JSON.stringify({
      checks: [
        "real_do_owner_and_member_admission_held_before_ready",
        "runner_ingest_dispositions_and_retained_history_unchanged",
        "public_replay_held_without_exposing_hostile_retained_metadata",
        "reconnect_remains_held_after_commit",
        "pure_expired_handshake_rejection_preserved",
      ],
      outcome: "passed",
      limits: [
        "No available public replay/realtime claim",
        "Legacy attachment no-command-effects and independent retirement are owned by focused manager tests",
        "No enrolled Mac, provider operation or private activation",
      ],
    }),
  );
  console.log("E02_PUBLIC_POSITION_HOLD_OK");
} catch (error) {
  server.debug();
  throw error;
} finally {
  await server.close();
}
