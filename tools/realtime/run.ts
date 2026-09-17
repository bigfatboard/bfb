// ABOUTME: Proves E02 browser realtime over real Workers, D1, and hibernating-style sockets.
// ABOUTME: All identities are synthetic; invalidations stay cursor-only while replay stays authoritative.

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { adaptD1, createAuthorizationContext, type D1Like } from "@bfb/db";
import {
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
  authExpiresAt: launchDeadline(now, 300_000),
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

async function waitFor(tap: SocketTap, count: number, label: string): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (tap.messages.length >= count) return tap.messages.slice();
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitMessages(tap: SocketTap, count: number, label: string): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (tap.messages.length >= count) return tap.messages.slice();
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

  const policy = {
    allowedProviders: ["fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand.name, { ...policy, expectedVersion: 1 });
  await human(updateProjectPolicyCommand.name, {
    ...policy,
    expectedVersion: 1,
    projectId: FIX.projectA,
  });
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

  // R1 subscribe handshake: ready carries the D1 high-water, attachments stay secret-free.
  const owner = await connect(ownerHandshake);
  assert.equal(owner.status, 101);
  const ownerTap = owner.tap as SocketTap;
  const member = await connect(memberHandshake);
  assert.equal(member.status, 101);
  const memberTap = member.tap as SocketTap;
  const ownerReady = (await waitFor(ownerTap, 1, "owner ready")).map((raw) => JSON.parse(raw));
  assert.deepEqual(Object.keys(ownerReady[0]).sort(), [
    "connection_id",
    "high_water_cursor",
    "kind",
    "schema_version",
    "server_time",
    "workspace_id",
  ]);
  assert.equal(ownerReady[0].kind, "browser.realtime.ready");
  const readyWater = ownerReady[0].high_water_cursor as number;
  const memberReady = (await waitFor(memberTap, 1, "member ready")).map((raw) => JSON.parse(raw));
  assert.equal(memberReady[0].kind, "browser.realtime.ready");
  assert.equal(memberReady[0].high_water_cursor, readyWater);

  // R2 commit fan-out: cursor-only invalidations reach every subscriber.
  // (Heartbeat framing rides the same dispatch; its gap rule is unit-tested
  // with injected clocks and browser-tested against the shared manager.)
  const committed = await nativeIngest(["heartbeat", "turn_started"]);
  assert.deepEqual(
    committed.dispositions.map((entry) => entry.disposition),
    ["accepted", "accepted"],
  );
  const ownerAfter = await waitFor(ownerTap, 2, "owner invalidation");
  const memberAfter = await waitFor(memberTap, 2, "member invalidation");
  for (const raw of [ownerAfter[1], memberAfter[1]]) {
    const frame = JSON.parse(raw as string) as Record<string, unknown>;
    assert.deepEqual(Object.keys(frame).sort(), [
      "high_water_cursor",
      "kind",
      "schema_version",
      "workspace_id",
    ]);
    assert.equal(frame.kind, "event.committed");
    assert.equal(frame.high_water_cursor, committed.high_water_cursor);
    assert.ok(!(raw as string).includes("token"));
    assert.ok(!(raw as string).includes("cookie"));
  }

  // R6 hostile strings ride replay as data, never in invalidations.
  const hostile = "<script>alert(document.cookie)</script>";
  const hostileCommitted = await nativeIngest(["heartbeat"], { provider_session_id: hostile });
  const hostileFrames = await waitFor(memberTap, 3, "hostile invalidation");
  assert.ok(!(hostileFrames[2] as string).includes("<script>"));
  const memberAuth = createAuthorizationContext({
    workspaceId: FIX.workspace,
    principalId: FIX.member,
    authorizationEpoch: 1,
    jurisdiction: "eu",
  });
  const replayed = await listLedgerEvents(db, memberAuth, { afterCursor: 0, throughCursor: 100 });
  assert.ok(replayed.some((row) => row.provider_session_id === hostile));

  // R3 reconnect: a new connection recovers the same authority without secret replay.
  ownerTap.close();
  const ownerAgain = await connect(ownerHandshake);
  assert.equal(ownerAgain.status, 101);
  const ownerAgainTap = ownerAgain.tap as SocketTap;
  const againReady = (await waitFor(ownerAgainTap, 1, "reconnect ready")).map((raw) =>
    JSON.parse(raw),
  );
  assert.equal(againReady[0].kind, "browser.realtime.ready");
  assert.equal(againReady[0].high_water_cursor, hostileCommitted.high_water_cursor);
  assert.notEqual(againReady[0].connection_id, ownerReady[0].connection_id);

  // R5 expired sessions never subscribe.
  const expired = await connect(
    browserPrincipal(FIX.owner, "e02-harness-owner-session", "owner", sessionExpiredAt),
  );
  assert.equal(expired.status, 403);

  // R4 revocation closes only the affected socket on the next committed command.
  // The member is revoked (not the owner) so the owner-bound runner keeps
  // its ingest authority for the survivor assertion below.
  await db
    .prepare(
      `UPDATE workspace_authorization_epochs SET revoked_at = ?, updated_at = ?
       WHERE workspace_id = ? AND human_id = ?`,
    )
    .run(now, now, FIX.workspace, FIX.member);
  await nativeIngest(["heartbeat"]);
  // The miniflare test client never observes server-initiated closes, so the
  // harness proves teardown by attrition: the close frame arrives, then a
  // later commit reaches only the survivor. Exact close codes ride unit tests.
  const memberClosed = await waitMessages(memberTap, 4, "revoked member close");
  const closeFrame = JSON.parse(memberClosed[3] as string) as Record<string, unknown>;
  assert.equal(closeFrame.kind, "browser.realtime.close");
  assert.equal(closeFrame.reason, "authorization_revoked");
  await nativeIngest(["heartbeat"]);
  const ownerLatest = await waitFor(ownerAgainTap, 2, "survivor invalidation");
  assert.equal((JSON.parse(ownerLatest[1] as string) as { kind: string }).kind, "event.committed");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(memberTap.messages.length, 4);

  console.log(
    JSON.stringify({
      readyHighWater: readyWater,
      committedHighWater: committed.high_water_cursor,
      invalidationsPerSubscriber: 3,
      reconnectRecovered: true,
      expiredRejected: true,
      revokedCloseFrame: "authorization_revoked",
      survivorInvalidations: 1,
      hostileKeptOutOfInvalidations: true,
      hostileInReplayAsData: true,
    }),
  );
  console.log("E02_REALTIME_OK");
} catch (error) {
  server.debug();
  throw error;
} finally {
  await server.close();
}
