// ABOUTME: Exercises X04 Queue per-message ack/retry, poison isolation, and DLQ state.
// ABOUTME: Synthetic handles prove siblings ack once while poison retries or parks visibly.

import { describe, expect, it } from "vitest";

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";
import {
  createProjectCommand,
  DomainError,
  FIX,
  GITHUB_QUEUE_SYSTEM_ID,
  GITHUB_WEBHOOK_SYSTEM_ID,
  installGitHubCommand,
  issueStepUpProof,
  mapGitHubRepositoryCommand,
  randomUlid,
  receiveGitHubWebhookCommand,
  reconcileGitHubCommand,
  seedSyntheticWorkspace,
  WorkspaceHub,
  type GitHubDeliveryEffect,
  type GitHubQueueMessage,
} from "@bfb/domain";

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/d1",
);

async function openDomainDb(): Promise<SqlDatabase> {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(raw, migrationsDir);
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db, NOW);
  return db;
}

import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import {
  consumeGitHubQueueBatch,
  consumeGitHubQueueMessage,
  runGitHubSweep,
  type GitHubConsumerDeps,
  type GitHubQueueHandle,
  type GitHubRestClient,
} from "../src/api/github.js";

const NOW = "2026-09-18T12:00:00.000Z";
const INSTALLATION = "12345678";
const REPOSITORY = "87654321";

function spyHandle(
  body: unknown,
): GitHubQueueHandle & { acked: number; retried: number; delays: number[] } {
  const handle = {
    body,
    acked: 0,
    retried: 0,
    delays: [] as number[],
    ack() {
      handle.acked += 1;
    },
    retry(options?: { delaySeconds?: number }) {
      handle.retried += 1;
      handle.delays.push(options?.delaySeconds ?? 0);
    },
  };
  return handle;
}

function fakeClient(
  mode: { fetch?: "ok" | "revoked" | "throw"; mint?: "ok" | "revoked" | "throw" } = {},
): GitHubRestClient & { minted: string[]; fetched: string[] } {
  const client = {
    minted: [] as string[],
    fetched: [] as string[],
    async mintInstallationToken(installationId: string) {
      client.minted.push(installationId);
      if ((mode.mint ?? "ok") === "revoked") {
        throw new DomainError("installation_revoked", "github installation is revoked");
      }
      if ((mode.mint ?? "ok") === "throw") {
        throw new DomainError("github_unreachable", "github token endpoint is unavailable");
      }
      return { token: "synthetic-test-token", expiresAt: "2026-09-18T13:00:00.000Z" };
    },
    async fetchRepository(token: string, repositoryId: string) {
      void token;
      client.fetched.push(repositoryId);
      if ((mode.fetch ?? "ok") === "revoked") {
        return { revoked: true as const };
      }
      if ((mode.fetch ?? "ok") === "throw") {
        throw new DomainError("github_unreachable", "github repository read failed");
      }
      return { fullName: "synthetic-org/synthetic-repo", defaultBranch: "main" };
    },
  };
  return client;
}

function depsFor(db: SqlDatabase, client: GitHubRestClient, now: string = NOW): GitHubConsumerDeps {
  return {
    db,
    now,
    jurisdiction: "eu",
    appOrigin: "https://bfb.example.test",
    abuseSecret: "x04-queue-test-abuse-secret-0123456789abcdef",
    workspaceHubNs: createTestWorkspaceHubNamespace(db),
    client,
  };
}

async function stepUp(db: SqlDatabase, action: string, targetId: string): Promise<string> {
  return issueStepUpProof(
    db,
    FIX.owner,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: new Date(Date.parse(NOW) + 5 * 60 * 1000).toISOString(),
    },
    NOW,
  );
}

async function install(db: SqlDatabase): Promise<void> {
  const hub = new WorkspaceHub(db);
  const proof = await stepUp(db, "github.install", `github-installation:${INSTALLATION}`);
  const installed = await hub.execute(installGitHubCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      installationId: INSTALLATION,
      appId: "999000",
      appSlug: "synthetic-app",
      accountId: "555666",
      accountLogin: "synthetic-org",
      accountType: "Organization",
      permissions: { metadata: "read" },
      events: ["push", "installation"],
      stepUpProofId: proof,
    },
  });
  if (!installed.ok) {
    throw new Error(`install failed: ${JSON.stringify(installed)}`);
  }
}

async function receive(
  db: SqlDatabase,
  deliveryId: string,
  effect: GitHubDeliveryEffect,
): Promise<{ outbox_id: string }> {
  const hub = new WorkspaceHub(db);
  const outcome = await hub.execute(receiveGitHubWebhookCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: `github-delivery.${deliveryId}`,
    actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
    authorizationEpoch: 1,
    now: NOW,
    input: { deliveryId, event: effect.event, supported: true, effect },
  });
  if (!outcome.ok || !outcome.result.outbox_id) {
    throw new Error(`receive failed: ${JSON.stringify(outcome)}`);
  }
  return { outbox_id: outcome.result.outbox_id };
}

async function reconcileDirect(
  db: SqlDatabase,
  outboxId: string,
  deliveryId: string,
  observed: { repositoryFullName: string; defaultBranch: string; fetchedAt: string } | undefined,
): Promise<string> {
  const hub = new WorkspaceHub(db);
  const outcome = await hub.execute(reconcileGitHubCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: `github-reconcile.${outboxId}`,
    actorSystemId: GITHUB_QUEUE_SYSTEM_ID,
    authorizationEpoch: 1,
    now: NOW,
    input: { outboxId, deliveryId, observed },
  });
  if (!outcome.ok) {
    throw new Error(`reconcile failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.result.effect;
}

async function setupLinked(db: SqlDatabase): Promise<{ projectId: string }> {
  await install(db);
  const createdId = randomUlid();
  const created = await receive(db, createdId, {
    event: "installation",
    action: "created",
    installationId: INSTALLATION,
    repositoryId: null,
    occurredAt: NOW,
    ref: null,
    version: null,
    detail: {},
  });
  await reconcileDirect(db, created.outbox_id, createdId, undefined);
  const hub = new WorkspaceHub(db);
  const project = await hub.execute(createProjectCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      name: "Synthetic GitHub Queue",
      slug: `github-queue-${randomUlid().slice(0, 8).toLowerCase()}`,
      tint: "#3B82F6",
      accessMode: "workspace",
      repositoryHost: "github.com",
      hostedRepositoryId: REPOSITORY,
      repositorySubpath: ".",
    },
  });
  if (!project.ok) {
    throw new Error(`project failed: ${JSON.stringify(project)}`);
  }
  const proof = await stepUp(db, "github.repository.map", `github-link:${REPOSITORY}`);
  const mapped = await hub.execute(mapGitHubRepositoryCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      projectId: project.result.id,
      fullName: "synthetic-org/synthetic-repo",
      defaultBranch: "main",
      stepUpProofId: proof,
    },
  });
  if (!mapped.ok) {
    throw new Error(`map failed: ${JSON.stringify(mapped)}`);
  }
  return { projectId: project.result.id };
}

function pushMessage(deliveryId: string, outboxId: string): GitHubQueueMessage {
  return {
    schema_version: 1,
    kind: "github.outbox.dispatch",
    workspace_id: FIX.workspace,
    outbox_id: outboxId,
    delivery_id: deliveryId,
    attempt: 0,
  };
}

describe("X04 github queue consumer", () => {
  it("acks successful siblings once while poison retries independently", async () => {
    const db = await openDomainDb();
    await setupLinked(db);
    const client = fakeClient();
    const deps = depsFor(db, client);
    const first = randomUlid();
    const second = randomUlid();
    const firstOutbox = await receive(db, first, {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: NOW,
      ref: "main",
      version: "a".repeat(40),
      detail: {},
    });
    const secondOutbox = await receive(db, second, {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: "2026-09-18T12:01:00.000Z",
      ref: "main",
      version: "b".repeat(40),
      detail: {},
    });
    const goodFirst = spyHandle(pushMessage(first, firstOutbox.outbox_id));
    const poison = spyHandle({ kind: "nope" });
    const goodSecond = spyHandle(pushMessage(second, secondOutbox.outbox_id));
    await consumeGitHubQueueBatch([goodFirst, poison, goodSecond], deps);
    expect(goodFirst.acked).toBe(1);
    expect(goodSecond.acked).toBe(1);
    expect(poison.retried).toBe(1);
    expect(poison.acked).toBe(0);
    // Exactly one effect per delivery; the token minted once per live message.
    expect(client.minted).toEqual([INSTALLATION, INSTALLATION]);
    expect(client.fetched).toEqual([REPOSITORY, REPOSITORY]);
    const states = (await db
      .prepare(
        `SELECT delivery_id, state FROM github_webhook_deliveries WHERE delivery_id IN (?, ?) ORDER BY delivery_id`,
      )
      .all(first, second)) as Array<{ delivery_id: string; state: string }>;
    expect(states.map((row) => row.state)).toEqual(["applied", "applied"]);
  });

  it("parks missing outbox rows in DLQ state and acks", async () => {
    const db = await openDomainDb();
    const deps = depsFor(db, fakeClient());
    const handle = spyHandle({
      schema_version: 1,
      kind: "github.outbox.dispatch",
      workspace_id: FIX.workspace,
      outbox_id: randomUlid(),
      delivery_id: randomUlid(),
      attempt: 3,
    });
    await consumeGitHubQueueMessage(handle, deps);
    expect(handle.acked).toBe(1);
    const dlq = (await db.prepare(`SELECT error, attempts FROM github_dlq`).all()) as Array<{
      error: string;
      attempts: number;
    }>;
    expect(dlq).toHaveLength(1);
    expect(dlq[0]?.error).toBe("outbox_missing");
  });

  it("retries unreachable github with backoff and exhausts into DLQ", async () => {
    const db = await openDomainDb();
    await setupLinked(db);
    const deliveryId = randomUlid();
    const received = await receive(db, deliveryId, {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: NOW,
      ref: "main",
      version: "a".repeat(40),
      detail: {},
    });
    const deps = depsFor(db, fakeClient({ fetch: "throw" }));
    const handle = spyHandle(pushMessage(deliveryId, received.outbox_id));
    await consumeGitHubQueueMessage(handle, deps);
    expect(handle.retried).toBe(1);
    expect(handle.delays[0]).toBeGreaterThan(0);
    const attempts = (await db
      .prepare(`SELECT attempts FROM github_integration_outbox WHERE outbox_id = ?`)
      .get(received.outbox_id)) as { attempts: number };
    expect(attempts.attempts).toBe(1);
    // Exhaustion parks the message visibly and acks instead of looping.
    await db
      .prepare(`UPDATE github_integration_outbox SET attempts = 4 WHERE outbox_id = ?`)
      .run(received.outbox_id);
    const exhausted = spyHandle(pushMessage(deliveryId, received.outbox_id));
    await consumeGitHubQueueMessage(exhausted, depsFor(db, fakeClient({ fetch: "throw" })));
    expect(exhausted.acked).toBe(1);
    expect(exhausted.retried).toBe(0);
    const dlq = (await db
      .prepare(`SELECT error FROM github_dlq WHERE outbox_id = ?`)
      .get(received.outbox_id)) as { error: string };
    expect(dlq.error).toBe("github_unreachable");
  });

  it("revokes the installation when github rejects it, without leaking the token", async () => {
    const db = await openDomainDb();
    await setupLinked(db);
    const deliveryId = randomUlid();
    const received = await receive(db, deliveryId, {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: NOW,
      ref: "main",
      version: "a".repeat(40),
      detail: {},
    });
    const client = fakeClient({ fetch: "revoked" });
    const deps = depsFor(db, client);
    const handle = spyHandle(pushMessage(deliveryId, received.outbox_id));
    await consumeGitHubQueueMessage(handle, deps);
    expect(handle.acked).toBe(1);
    const installation = (await db
      .prepare(`SELECT status FROM github_app_installations WHERE installation_id = ?`)
      .get(INSTALLATION)) as { status: string };
    expect(installation.status).toBe("revoked");
    const delivery = (await db
      .prepare(`SELECT state FROM github_webhook_deliveries WHERE delivery_id = ?`)
      .get(deliveryId)) as { state: string };
    expect(delivery.state).toBe("ignored");
    expect(client.minted).toEqual([INSTALLATION]);
  });

  it("recovers the commit-before-enqueue gap through the sweep", async () => {
    const db = await openDomainDb();
    await setupLinked(db);
    const deliveryId = randomUlid();
    const received = await receive(db, deliveryId, {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: NOW,
      ref: "main",
      version: "a".repeat(40),
      detail: {},
    });
    // The crash: D1 committed, no Queue message was ever sent.
    const sent: GitHubQueueMessage[] = [];
    const sweep = await runGitHubSweep(
      db,
      {
        async send(message) {
          sent.push(message);
        },
      },
      NOW,
    );
    expect(sweep).toEqual({ claimed: 1, reclaimed: 0, sent: 1, sendFailures: 0 });
    expect(sent[0]?.delivery_id).toBe(deliveryId);
    // A failed send stays recoverable: the row is dispatched with backoff.
    const secondDelivery = randomUlid();
    await receive(db, secondDelivery, {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: NOW,
      ref: "main",
      version: "b".repeat(40),
      detail: {},
    });
    const failed = await runGitHubSweep(
      db,
      {
        async send() {
          throw new Error("queue unavailable");
        },
      },
      NOW,
    );
    // The first message is already dispatched (claimed above), so only the
    // second pending row is claimed; its send fails but stays recoverable.
    expect(failed.claimed).toBe(1);
    expect(failed.sendFailures).toBe(1);
    void received;
  });
});
