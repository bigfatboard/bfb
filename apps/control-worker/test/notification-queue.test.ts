// ABOUTME: Drives the X01 queue consumer against hub-seeded fixtures with scripted push endpoints.
// ABOUTME: Proves dedupe, retry budgets, DLQ copies, suppression, and batch isolation.

import { describe, expect, it } from "vitest";

import {
  claimLaunchCommand,
  createAgentProfileCommand,
  createTaskCommand,
  FIX,
  launchDeadline,
  notificationJobId,
  randomUlid,
  registerPushEndpointCommand,
  removeMemberCommand,
  replaceRunnerInventoryCommand,
  reportRepositoryConfigCommand,
  requestAttentionCommand,
  runnerHash,
  seedSyntheticWorkspace,
  startLaunchCommand,
  updateProjectPolicyCommand,
  updateWorkspacePolicyCommand,
  WorkspaceHub,
  type NotifyMessage,
  type RunnerPrincipal,
} from "@bfb/domain";
import type { RunnerInventory } from "@bfb/protocol";

import {
  handleNotifyQueue,
  type DlqCopy,
  type NotifyQueueDeps,
} from "../src/notifications/queue.js";
import { dispatchNotificationOutbox } from "../src/notifications/dispatch.js";
import type { VapidSecrets } from "../src/notifications/push.js";
import { openAuthTestContext, type AuthTestContext } from "./auth-helpers.js";

const NOW = "2026-09-12T12:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const EMPTY_CONFIG = `sha256:${runnerHash("{}")}`;
const APP_ORIGIN = "https://bfb.example.test";

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64decode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const full = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  return Uint8Array.from(atob(full), (char) => char.charCodeAt(0));
}

async function vapidSecrets(): Promise<VapidSecrets> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("vapid key export failed");
  return { publicKey: b64encode(raw), privateKey: jwk.d, subject: "mailto:x01@synthetic.test" };
}

async function receiverKeys(): Promise<{ p256dh: string; auth: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    p256dh: b64encode(raw),
    auth: b64encode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

interface FakeMessage {
  body: NotifyMessage;
  attempts: number;
  acked: boolean;
  retried: boolean;
}

function batch(messages: Array<{ body: unknown; attempts?: number }>): {
  batch: { messages: Array<FakeMessage & { ack: () => void; retry: () => void }> };
  fakes: FakeMessage[];
} {
  const fakes: FakeMessage[] = messages.map((entry) => ({
    body: entry.body as NotifyMessage,
    attempts: entry.attempts ?? 1,
    acked: false,
    retried: false,
  }));
  return {
    fakes,
    batch: {
      messages: fakes.map((fake) => ({
        ...fake,
        ack: () => {
          fake.acked = true;
        },
        retry: () => {
          fake.retried = true;
        },
      })),
    },
  };
}

interface PushCall {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

function scriptedFetch(status: number, calls: PushCall[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    calls.push({ url: String(url), headers, body: (init?.body as Uint8Array) ?? new Uint8Array() });
    return new Response(null, { status });
  }) as typeof fetch;
}

interface QueueWorld {
  context: AuthTestContext;
  principal: RunnerPrincipal;
  cursor: number;
}

async function seedQueueWorld(
  question: string,
  ownerHuman: string = FIX.owner,
): Promise<QueueWorld> {
  const context = openAuthTestContext();
  await seedSyntheticWorkspace(context.db, NOW);
  const db = context.db;
  const hub = new WorkspaceHub(db);
  const runner = randomUlid();
  const checkout = randomUlid();
  const tokenId = randomUlid();
  const principal: RunnerPrincipal = {
    kind: "runner",
    workspaceId: FIX.workspace,
    runnerId: runner,
    ownerHumanId: ownerHuman,
    authorizationEpoch: 1,
    ownerAuthorizationEpoch: 1,
    grantEpoch: 1,
    tokenEpoch: 1,
    tokenId,
    keyThumbprint: "synthetic-x01-key",
    authExpiresAt: launchDeadline(NOW, 300_000),
    projectIds: [FIX.projectA],
  };
  async function human<T>(command: Parameters<typeof hub.execute>[0], input: unknown): Promise<T> {
    const outcome = await hub.execute(command as never, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: input as never,
    });
    if (!outcome.ok) throw new Error(`seed human command failed: ${outcome.error.code}`);
    return outcome.result as T;
  }
  async function native<T>(command: Parameters<typeof hub.execute>[0], input: unknown): Promise<T> {
    const outcome = await hub.execute(command as never, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorRunnerId: runner,
      authorizationEpoch: 1,
      now: NOW,
      input: input as never,
    });
    if (!outcome.ok) throw new Error(`seed runner command failed: ${outcome.error.code}`);
    return outcome.result as T;
  }
  await db
    .prepare(
      `INSERT INTO runners (workspace_id, id, owner_human_id, device_label, public_key_json, key_thumbprint, token_epoch, enrolled_at)
       VALUES (?, ?, ?, 'Synthetic X01 Mac', '{}', ?, 1, ?)`,
    )
    .run(FIX.workspace, runner, ownerHuman, principal.keyThumbprint, NOW);
  await db
    .prepare(`INSERT INTO runner_project_grants VALUES (?, ?, ?)`)
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, NOW);
  await db
    .prepare(
      `INSERT INTO runner_tokens (workspace_id, runner_id, id, token_hash, claims_json, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      FIX.workspace,
      runner,
      tokenId,
      runnerHash("synthetic-x01-token"),
      JSON.stringify({
        v: 1,
        sub: runner,
        workspace_id: FIX.workspace,
        aud: "bfb-runner",
        iss: "https://bfb.example.test",
        jti: tokenId,
        iat: Date.parse(NOW) / 1000,
        exp: Date.parse(principal.authExpiresAt) / 1000,
        authorization_epoch: 1,
        owner_authorization_epoch: 1,
        grant_epoch: 1,
        token_epoch: 1,
        cnf: { jkt: principal.keyThumbprint },
      }),
      principal.authExpiresAt,
    );
  const policy = {
    allowedProviders: ["fake"],
    allowAgentRootPropose: false,
    allowPassToAgent: true,
    allowRunOverrides: true,
  };
  await human(updateWorkspacePolicyCommand, { ...policy, expectedVersion: 1 });
  await human(updateProjectPolicyCommand, {
    ...policy,
    projectId: FIX.projectA,
    expectedVersion: 1,
  });
  await human(reportRepositoryConfigCommand, {
    projectId: FIX.projectA,
    expectedVersion: 1,
    document: {},
    contentHash: EMPTY_CONFIG,
  });
  const profile = await human<{ id: string }>(createAgentProfileCommand, {
    name: "Synthetic X01 provider",
    provider: "fake",
    model: "synthetic",
    executionMode: "interactive",
    harnessMode: "restricted",
  });
  const task = await human<{ id: string }>(createTaskCommand, {
    projectId: FIX.projectA,
    title: `Synthetic X01 queue task ${question.length}`,
    priority: "P2",
  });
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
        label: "Synthetic X01 checkout",
        repository_identity: "synthetic/x01",
        workspace_subpath: ".",
        physical_worktree_hash: DIGEST,
        repository_config_hash: EMPTY_CONFIG,
        is_default: true,
        dirty: false,
        status: "validated",
        validated_at: NOW,
      },
    ],
    providers: [
      {
        provider: "fake",
        version: "1.0.0",
        manifest_id: DIGEST,
        status: "healthy",
        observed_at: NOW,
        expires_at: launchDeadline(NOW, 30_000),
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
  await native(replaceRunnerInventoryCommand, { principal, inventory });
  const launch = await human<{ launch_id: string }>(startLaunchCommand, {
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
  const claimed = await native<{
    state: string;
    claim: {
      specification: { run_execution_id: string; assignment_generation: number; run_id: string };
    };
  }>(claimLaunchCommand, {
    principal,
    claim: {
      schema_version: 1,
      launch_id: launch.launch_id,
      runner_id: runner,
      idempotency_key: randomUlid(),
      claimed_at: NOW,
    },
  });
  if (claimed.state !== "claimed") throw new Error(claimed.state);
  await native(requestAttentionCommand, {
    principal,
    runId: claimed.claim.specification.run_id,
    executionId: claimed.claim.specification.run_execution_id,
    assignmentGeneration: claimed.claim.specification.assignment_generation,
    kind: "clarification",
    question,
    blocking: true,
  });
  const cursor = (await db
    .prepare(
      `SELECT workspace_cursor FROM semantic_events
       WHERE workspace_id = ? AND kind = 'attention.request' ORDER BY workspace_cursor DESC LIMIT 1`,
    )
    .get(FIX.workspace)) as { workspace_cursor: number };
  return { context, principal, cursor: cursor.workspace_cursor };
}

function messageFor(cursor: number, kind = "attention.request"): NotifyMessage {
  return {
    schema_version: 1,
    job_id: notificationJobId(FIX.workspace, cursor),
    workspace_id: FIX.workspace,
    event_cursor: cursor,
    event_kind: kind,
  };
}

async function registerEndpoint(world: QueueWorld, humanId: string, tag: string): Promise<void> {
  const receiver = await receiverKeys();
  const hub = new WorkspaceHub(world.context.db);
  const outcome = await hub.execute(registerPushEndpointCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: humanId,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      endpoint: `https://push.synthetic.test/${tag}`,
      p256dh: receiver.p256dh,
      auth: receiver.auth,
    },
  });
  if (!outcome.ok) throw new Error(`endpoint registration failed: ${outcome.error.code}`);
}

async function deliveries(world: QueueWorld, cursor: number) {
  return (await world.context.db
    .prepare(
      `SELECT delivery_id, channel, state, attempt_count, last_error FROM notification_deliveries
       WHERE workspace_id = ? AND event_cursor = ? ORDER BY delivery_id`,
    )
    .all(FIX.workspace, cursor)) as Array<{
    delivery_id: string;
    channel: string;
    state: string;
    attempt_count: number;
    last_error: string | null;
  }>;
}

function depsFor(
  world: QueueWorld,
  input: { fetchImpl: typeof fetch; vapid: VapidSecrets | null; dlq: DlqCopy[]; calls: PushCall[] },
): NotifyQueueDeps {
  return {
    db: world.context.db,
    sendDlq: async (copy) => {
      input.dlq.push(copy);
    },
    appOrigin: APP_ORIGIN,
    vapid: input.vapid,
  };
}

describe("notification outbox dispatch", () => {
  it("sends one message per actionable event and advances the watermark", async () => {
    const world = await seedQueueWorld("Synthetic X01 dispatch");
    const sent: Array<{ workspace_id: string; event_cursor: number; event_kind: string }> = [];
    const first = await dispatchNotificationOutbox(
      world.context.db,
      async (message) => {
        sent.push(message);
      },
      NOW,
    );
    expect(first.workspaces).toBe(1);
    expect(first.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ workspace_id: FIX.workspace, event_kind: "attention.request" });
    const state = (await world.context.db
      .prepare(`SELECT last_cursor FROM notification_dispatch_state WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { last_cursor: number };
    expect(state.last_cursor).toBe(sent[0]?.event_cursor);
    const task = await new WorkspaceHub(world.context.db).execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { projectId: FIX.projectA, title: "Synthetic X01 telemetry task", priority: "P2" },
    });
    if (!task.ok) throw new Error(task.error.code);
    const second = await dispatchNotificationOutbox(
      world.context.db,
      async (message) => {
        sent.push(message);
      },
      NOW,
    );
    expect(second.sent).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe("notification queue consumer", () => {
  it("delivers once despite duplicate redelivery", async () => {
    const world = await seedQueueWorld("Synthetic X01 queue dedupe");
    await registerEndpoint(world, FIX.owner, "x01-dedupe");
    const message = messageFor(world.cursor);
    const calls: PushCall[] = [];
    const dlq: DlqCopy[] = [];
    const fetchImpl = scriptedFetch(201, calls);
    const deps = depsFor(world, { fetchImpl, vapid: await vapidSecrets(), dlq, calls });
    const first = batch([{ body: message, attempts: 1 }]);
    await handleNotifyQueue(first.batch as never, deps, NOW, fetchImpl);
    expect(first.fakes[0]?.acked).toBe(true);
    const second = batch([{ body: message, attempts: 2 }]);
    await handleNotifyQueue(second.batch as never, deps, NOW, fetchImpl);
    expect(second.fakes[0]?.acked).toBe(true);
    expect(calls.length).toBe(1);
    expect(dlq.length).toBe(0);
    const rows = await deliveries(world, world.cursor);
    const push = rows.find((row) => row.channel === "browser_push");
    expect(push?.state).toBe("delivered");
    expect(calls[0]?.headers["content-encoding"]).toBe("aes128gcm");
    expect(calls[0]?.headers["authorization"]).toMatch(/^vapid t=[^,]+, k=[A-Za-z0-9_-]+$/);
    expect(calls[0]?.url).toBe("https://push.synthetic.test/x01-dedupe");
  });

  it("retries failing endpoints into visible DLQ state", async () => {
    const world = await seedQueueWorld("Synthetic X01 queue poison");
    await registerEndpoint(world, FIX.owner, "x01-poison");
    const message = messageFor(world.cursor);
    const calls: PushCall[] = [];
    const dlq: DlqCopy[] = [];
    const fetchImpl = scriptedFetch(500, calls);
    const deps = depsFor(world, { fetchImpl, vapid: await vapidSecrets(), dlq, calls });
    for (let attempts = 1; attempts <= 4; attempts++) {
      const redelivery = batch([{ body: message, attempts }]);
      await handleNotifyQueue(redelivery.batch as never, deps, NOW, fetchImpl);
      expect(redelivery.fakes[0]?.retried).toBe(true);
      expect(redelivery.fakes[0]?.acked).toBe(false);
    }
    const exhausted = batch([{ body: message, attempts: 5 }]);
    await handleNotifyQueue(exhausted.batch as never, deps, NOW, fetchImpl);
    expect(exhausted.fakes[0]?.acked).toBe(true);
    expect(exhausted.fakes[0]?.retried).toBe(false);
    const rows = await deliveries(world, world.cursor);
    const push = rows.find((row) => row.channel === "browser_push");
    expect(push?.state).toBe("dead_lettered");
    expect(push?.attempt_count).toBe(4);
    expect(push?.last_error).toContain("push_status_500");
    expect(dlq).toHaveLength(1);
    expect(dlq[0]).toMatchObject({
      schema_version: 1,
      workspace_id: FIX.workspace,
      event_cursor: world.cursor,
      channel: "browser_push",
      category: "attention",
      code: "push_status_500",
    });
    expect(JSON.stringify(dlq[0])).not.toContain("push.synthetic.test");
  });

  it("deletes expired endpoints without retrying", async () => {
    const world = await seedQueueWorld("Synthetic X01 queue expired");
    await registerEndpoint(world, FIX.owner, "x01-gone");
    const calls: PushCall[] = [];
    const dlq: DlqCopy[] = [];
    const fetchImpl = scriptedFetch(410, calls);
    const deps = depsFor(world, { fetchImpl, vapid: await vapidSecrets(), dlq, calls });
    const redelivery = batch([{ body: messageFor(world.cursor), attempts: 1 }]);
    await handleNotifyQueue(redelivery.batch as never, deps, NOW, fetchImpl);
    expect(redelivery.fakes[0]?.acked).toBe(true);
    expect(calls.length).toBe(1);
    const rows = await deliveries(world, world.cursor);
    expect(rows.find((row) => row.channel === "browser_push")?.state).toBe("failed");
    const remaining = (await world.context.db
      .prepare(`SELECT COUNT(*) AS count FROM notification_push_endpoints WHERE workspace_id = ?`)
      .get(FIX.workspace)) as { count: number };
    expect(remaining.count).toBe(0);
  });

  it("isolates poison messages and stops without VAPID secrets", async () => {
    const world = await seedQueueWorld("Synthetic X01 queue isolation");
    await registerEndpoint(world, FIX.owner, "x01-isolation");
    const calls: PushCall[] = [];
    const dlq: DlqCopy[] = [];
    const fetchImpl = scriptedFetch(201, calls);
    const deps = depsFor(world, { fetchImpl, vapid: null, dlq, calls });
    const mixed = batch([
      { body: { nope: true }, attempts: 1 },
      { body: messageFor(world.cursor), attempts: 1 },
    ]);
    await handleNotifyQueue(mixed.batch as never, deps, NOW, fetchImpl);
    expect(mixed.fakes[0]?.acked).toBe(true);
    expect(mixed.fakes[1]?.acked).toBe(true);
    expect(calls.length).toBe(0);
    const rows = await deliveries(world, world.cursor);
    expect(rows.find((row) => row.channel === "browser_push")?.state).toBe("failed");
    expect(rows.find((row) => row.channel === "browser_push")?.last_error).toContain(
      "push_unconfigured",
    );
  });

  it("acks non-actionable events and suppresses revoked readers", async () => {
    const world = await seedQueueWorld("Synthetic X01 queue silent");
    await registerEndpoint(world, FIX.member, "x01-suppressed");
    const hub = new WorkspaceHub(world.context.db);
    const task = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { projectId: FIX.projectA, title: "Synthetic X01 silent task", priority: "P2" },
    });
    if (!task.ok) throw new Error(task.error.code);
    const silentCursor = (await world.context.db
      .prepare(
        `SELECT workspace_cursor FROM semantic_events
         WHERE workspace_id = ? AND kind = 'task.create' ORDER BY workspace_cursor DESC LIMIT 1`,
      )
      .get(FIX.workspace)) as { workspace_cursor: number };
    const calls: PushCall[] = [];
    const dlq: DlqCopy[] = [];
    const fetchImpl = scriptedFetch(201, calls);
    const deps = depsFor(world, { fetchImpl, vapid: await vapidSecrets(), dlq, calls });
    const silent = batch([
      { body: messageFor(silentCursor.workspace_cursor, "task.create"), attempts: 1 },
    ]);
    await handleNotifyQueue(silent.batch as never, deps, NOW, fetchImpl);
    expect(silent.fakes[0]?.acked).toBe(true);
    expect(calls.length).toBe(0);

    const { fanoutNotificationEvent } = await import("@bfb/domain");
    const fanout = await fanoutNotificationEvent(world.context.db, {
      workspaceId: FIX.workspace,
      eventCursor: world.cursor,
      eventKind: "attention.request",
      now: NOW,
    });
    expect(fanout.status).toBe("notified");
    const removed = await hub.execute(removeMemberCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { humanId: FIX.member },
    });
    if (!removed.ok) throw new Error(removed.error.code);
    const revoked = batch([{ body: messageFor(world.cursor), attempts: 1 }]);
    await handleNotifyQueue(revoked.batch as never, deps, NOW, fetchImpl);
    expect(revoked.fakes[0]?.acked).toBe(true);
    expect(calls.length).toBe(0);
    expect(dlq.length).toBe(0);
    const rows = await deliveries(world, world.cursor);
    const memberPush = rows.find((row) => row.channel === "browser_push");
    expect(memberPush?.state).toBe("suppressed");
  });
});
