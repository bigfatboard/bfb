// ABOUTME: Covers X04 GitHub domain rules without any transport.
// ABOUTME: HMAC, step-up matrix, mapping invariants, outbox, and provenance live here.

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { SqlDatabase } from "@bfb/db";

import {
  claimGitHubOutboxBatch,
  extractWebhookEffect,
  getEvidenceVerificationStatus,
  getGitHubStatus,
  GITHUB_PERMISSIONS_ALLOWLIST,
  GITHUB_QUEUE_SYSTEM_ID,
  GITHUB_WEBHOOK_EVENTS_ALLOWLIST,
  GITHUB_WEBHOOK_SYSTEM_ID,
  githubQueueMessage,
  installGitHubCommand,
  linkGitHubEvidenceCommand,
  listGitHubEvidence,
  mapGitHubRepositoryCommand,
  noteGitHubOutboxAttempt,
  parseGitHubQueueMessage,
  receiveGitHubWebhookCommand,
  reclaimStaleGitHubOutbox,
  reconcileGitHubCommand,
  removeGitHubCommand,
  updateGitHubPermissionsCommand,
  verifyGitHubWebhookSignature,
  writeGitHubDlqRow,
  type GitHubDeliveryEffect,
  type ReceiveGitHubWebhookResult,
  type ReconcileGitHubResult,
} from "../src/github.js";
import { DomainError, WorkspaceHub } from "../src/hub.js";
import { createProjectCommand } from "../src/projects.js";
import { createTaskCommand } from "../src/work-commands.js";
import { issueStepUpProof } from "../src/step-up.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-09-18T12:00:00.000Z";
const LATER = "2026-09-18T12:05:00.000Z";
const INSTALLATION = "12345678";
const REPOSITORY = "87654321";
const APP_ID = "999000";
const ACCOUNT = "synthetic-org";
const PERMISSIONS = { metadata: "read", pull_requests: "read", checks: "read" };
const EVENTS = ["push", "pull_request", "installation"];
const SECRET = "x04-synthetic-webhook-secret-0123456789abcdef";

function hub(db: SqlDatabase): WorkspaceHub {
  return new WorkspaceHub(db);
}

async function stepUp(
  db: SqlDatabase,
  humanId: string,
  action: string,
  targetId: string,
  epoch = 1,
  now: string = NOW,
): Promise<string> {
  return issueStepUpProof(
    db,
    humanId,
    {
      action,
      workspaceId: FIX.workspace,
      targetId,
      scopes: [],
      authorizationEpoch: epoch,
      expiresAt: new Date(Date.parse(now) + 5 * 60 * 1000).toISOString(),
    },
    now,
  );
}

async function install(
  db: SqlDatabase,
  overrides: Record<string, unknown> = {},
  humanId: string = FIX.owner,
): Promise<{ installation_id: string }> {
  const proof = await stepUp(db, humanId, "github.install", `github-installation:${INSTALLATION}`);
  const outcome = await hub(db).execute(installGitHubCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: humanId,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      installationId: INSTALLATION,
      appId: APP_ID,
      appSlug: "synthetic-app",
      accountId: "555666",
      accountLogin: ACCOUNT,
      accountType: "Organization",
      permissions: PERMISSIONS,
      events: EVENTS,
      stepUpProofId: proof,
      ...overrides,
    },
  });
  if (!outcome.ok) {
    throw new Error(`install failed: ${JSON.stringify(outcome)}`);
  }
  return outcome.result;
}

async function activate(db: SqlDatabase): Promise<void> {
  const effect: GitHubDeliveryEffect = {
    event: "installation",
    action: "created",
    installationId: INSTALLATION,
    repositoryId: null,
    occurredAt: NOW,
    ref: null,
    version: null,
    detail: {},
  };
  const received = await hub(db).execute(receiveGitHubWebhookCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: `github-delivery.${randomUlid()}`,
    actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
    authorizationEpoch: 1,
    now: NOW,
    input: { deliveryId: randomUlid(), event: "installation", supported: true, effect },
  });
  if (!received.ok) {
    throw new Error(`receive failed: ${JSON.stringify(received)}`);
  }
  const result = (received as { ok: true; result: ReceiveGitHubWebhookResult }).result;
  const reconciled = await hub(db).execute(reconcileGitHubCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: `github-reconcile.${result.outbox_id}`,
    actorSystemId: GITHUB_QUEUE_SYSTEM_ID,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      outboxId: result.outbox_id as string,
      deliveryId: result.delivery_id,
      observed: { repositoryFullName: "synthetic-org/synthetic-repo", defaultBranch: "main", fetchedAt: NOW },
    },
  });
  if (!reconciled.ok) {
    throw new Error(`reconcile failed: ${JSON.stringify(reconciled)}`);
  }
}

async function createGitHubProject(db: SqlDatabase): Promise<string> {
  const outcome = await hub(db).execute(createProjectCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      name: "Synthetic GitHub",
      slug: "github-app",
      tint: "#3B82F6",
      accessMode: "workspace",
      repositoryHost: "github.com",
      hostedRepositoryId: REPOSITORY,
      repositorySubpath: ".",
    },
  });
  if (!outcome.ok) {
    throw new Error(`project failed: ${JSON.stringify(outcome)}`);
  }
  return (outcome.result as { id: string }).id;
}

async function mapRepo(db: SqlDatabase, projectId: string): Promise<void> {
  const proof = await stepUp(db, FIX.owner, "github.repository.map", `github-link:${REPOSITORY}`);
  const outcome = await hub(db).execute(mapGitHubRepositoryCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey: randomUlid(),
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    input: {
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      projectId,
      fullName: "synthetic-org/synthetic-repo",
      defaultBranch: "main",
      stepUpProofId: proof,
    },
  });
  if (!outcome.ok) {
    throw new Error(`map failed: ${JSON.stringify(outcome)}`);
  }
}

function sign(body: Uint8Array, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("github webhook signature", () => {
  it("accepts a valid signature and rejects forgeries before parsing", () => {
    const body = new TextEncoder().encode(`{"not":"json`);
    expect(() =>
      verifyGitHubWebhookSignature(SECRET, body, sign(body)),
    ).not.toThrow();
    expect(() => verifyGitHubWebhookSignature("wrong-secret", body, sign(body))).toThrow(
      DomainError,
    );
    expect(() =>
      verifyGitHubWebhookSignature(SECRET, body, sign(new TextEncoder().encode("other"))),
    ).toThrow(DomainError);
    expect(() => verifyGitHubWebhookSignature(SECRET, body, null)).toThrow(DomainError);
    expect(() => verifyGitHubWebhookSignature(SECRET, body, "sha1=deadbeef")).toThrow(
      DomainError,
    );
    expect(() => verifyGitHubWebhookSignature("", body, sign(body, ""))).toThrow(DomainError);
  });

  it("freezes the read-side permission inventory", () => {
    expect(GITHUB_PERMISSIONS_ALLOWLIST.metadata).toEqual(["read"]);
    for (const accesses of Object.values(GITHUB_PERMISSIONS_ALLOWLIST)) {
      expect(accesses).toEqual(["read"]);
    }
    expect(GITHUB_WEBHOOK_EVENTS_ALLOWLIST).toContain("push");
    expect(GITHUB_WEBHOOK_EVENTS_ALLOWLIST).toContain("installation");
  });
});

describe("github effect extraction", () => {
  const installation = { id: INSTALLATION, account: { login: ACCOUNT, type: "Organization" } };
  const repository = { id: REPOSITORY, full_name: "synthetic-org/synthetic-repo" };

  it("extracts push, pull_request, check_run, and issues effects", () => {
    const push = extractWebhookEffect(
      "push",
      { ref: "refs/heads/main", head_commit: { id: "a".repeat(40), timestamp: NOW }, repository, installation },
      LATER,
    );
    expect(push.supported).toBe(true);
    expect(push.effect?.ref).toBe("main");
    expect(push.effect?.version).toBe("a".repeat(40));

    const deleted = extractWebhookEffect(
      "push",
      { ref: "refs/heads/gone", head_commit: null, repository, installation },
      LATER,
    );
    expect(deleted.effect?.version).toBe("deleted");

    const pull = extractWebhookEffect(
      "pull_request",
      {
        action: "synchronize",
        pull_request: { number: 7, head: { sha: "b".repeat(40) }, state: "open", updated_at: NOW },
        repository,
        installation,
      },
      LATER,
    );
    expect(pull.effect?.ref).toBe("7");
    expect(pull.effect?.version).toBe("b".repeat(40));

    const check = extractWebhookEffect(
      "check_run",
      {
        action: "completed",
        check_run: { id: 4242, name: "ci", head_sha: "c".repeat(40), status: "completed", conclusion: "success", completed_at: NOW },
        repository,
        installation,
      },
      LATER,
    );
    expect(check.effect?.kind).toBeUndefined();
    expect(check.effect?.ref).toBe("4242");

    const issue = extractWebhookEffect(
      "issues",
      { action: "closed", issue: { number: 9, state: "closed", title: "Synthetic", updated_at: NOW }, repository, installation },
      LATER,
    );
    expect(issue.effect?.ref).toBe("9");
    expect(issue.effect?.version).toBe("closed");
  });

  it("marks unsupported events and rejects malformed payloads", () => {
    expect(extractWebhookEffect("ping", {}, NOW).supported).toBe(false);
    expect(() => extractWebhookEffect("push", { repository }, NOW)).toThrow(DomainError);
    expect(() => extractWebhookEffect("push", "nope", NOW)).toThrow(DomainError);
  });
});

describe("github installation management", () => {
  it("installs for an Owner with a fresh action-bound proof", async () => {
    const db = await openDomainDb();
    const summary = await install(db);
    expect(summary.installation_id).toBe(INSTALLATION);
    const status = await getGitHubStatus(db, FIX.workspace);
    expect(status.installations).toHaveLength(1);
    expect(status.installations[0]?.status).toBe("pending");
  });

  it("rejects installs outside the permission inventory", async () => {
    const db = await openDomainDb();
    await expect(
      install(db, { permissions: { ...PERMISSIONS, metadata: "write" } }),
    ).rejects.toThrow(/outside the v0.1 inventory/);
    await expect(
      install(db, { permissions: { unknown_scope: "read" } }),
    ).rejects.toThrow(/must be an object with known fields/);
    await expect(install(db, { events: ["push", "secret_scanning_alert"] })).rejects.toThrow(
      /not subscribed/,
    );
  });

  it("enforces the Owner step-up authorization matrix", async () => {
    const db = await openDomainDb();
    const target = `github-installation:${INSTALLATION}`;
    const base = {
      installationId: INSTALLATION,
      appId: APP_ID,
      appSlug: "synthetic-app",
      accountId: "555666",
      accountLogin: ACCOUNT,
      accountType: "Organization",
      permissions: PERMISSIONS,
      events: EVENTS,
    };
    const attempt = (humanId: string | undefined, proof: string, epoch = 1) =>
      hub(db).execute(installGitHubCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: randomUlid(),
        ...(humanId === undefined ? {} : { actorHumanId: humanId }),
        authorizationEpoch: epoch,
        now: NOW,
        input: { ...base, stepUpProofId: proof },
      });

    // Non-Owner roles cannot install.
    const memberProof = await stepUp(db, FIX.member, "github.install", target);
    expect((await attempt(FIX.member, memberProof)).ok).toBe(false);
    const reviewerProof = await stepUp(db, FIX.reviewer, "github.install", target);
    expect((await attempt(FIX.reviewer, reviewerProof)).ok).toBe(false);
    // Missing proof fails.
    expect((await attempt(FIX.owner, "")).ok).toBe(false);
    // Stale authorization epoch fails.
    const epochProof = await stepUp(db, FIX.owner, "github.install", target, 1);
    expect((await attempt(FIX.owner, epochProof, 2)).ok).toBe(false);
    // Wrong action or target fails.
    const wrongAction = await stepUp(db, FIX.owner, "github.remove", target);
    expect((await attempt(FIX.owner, wrongAction)).ok).toBe(false);
    const wrongTarget = await stepUp(db, FIX.owner, "github.install", "github-installation:1");
    expect((await attempt(FIX.owner, wrongTarget)).ok).toBe(false);
    // A consumed proof cannot be reused.
    const proof = await stepUp(db, FIX.owner, "github.install", target);
    expect((await attempt(FIX.owner, proof)).ok).toBe(true);
    expect((await attempt(FIX.owner, proof)).ok).toBe(false);
  });

  it("removes with step-up, closes links, and refuses a second remove", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    await mapRepo(db, projectId);
    const proof = await stepUp(db, FIX.owner, "github.remove", `github-installation:${INSTALLATION}`, 1, LATER);
    const removed = await hub(db).execute(removeGitHubCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: LATER,
      input: { installationId: INSTALLATION, stepUpProofId: proof },
    });
    expect(removed.ok).toBe(true);
    const status = await getGitHubStatus(db, FIX.workspace);
    expect(status.installations[0]?.status).toBe("revoked");
    expect(status.links).toHaveLength(0);
    const proof2 = await stepUp(db, FIX.owner, "github.remove", `github-installation:${INSTALLATION}`, 1, LATER);
    const again = await hub(db).execute(removeGitHubCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: LATER,
      input: { installationId: INSTALLATION, stepUpProofId: proof2 },
    });
    expect(again.ok).toBe(false);
  });

  it("rejects permission changes outside the inventory or with stale versions", async () => {
    const db = await openDomainDb();
    await install(db);
    const attempt = (input: Record<string, unknown>) =>
      hub(db).execute(updateGitHubPermissionsCommand, {
        workspaceId: FIX.workspace,
        idempotencyKey: randomUlid(),
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        now: NOW,
        input: {
          installationId: INSTALLATION,
          expectedVersion: 1,
          permissions: PERMISSIONS,
          events: EVENTS,
          stepUpProofId: "",
          ...input,
        },
      });
    const proof = await stepUp(db, FIX.owner, "github.permissions.update", `github-installation:${INSTALLATION}`);
    expect(
      (await attempt({ permissions: { metadata: "write" }, stepUpProofId: proof })).ok,
    ).toBe(false);
    const proof2 = await stepUp(db, FIX.owner, "github.permissions.update", `github-installation:${INSTALLATION}`);
    expect(
      (await attempt({ expectedVersion: 9, stepUpProofId: proof2 })).ok,
    ).toBe(false);
    const memberProof = await stepUp(db, FIX.member, "github.permissions.update", `github-installation:${INSTALLATION}`);
    expect((await attempt({ stepUpProofId: memberProof })).ok).toBe(false);
    const proof3 = await stepUp(db, FIX.owner, "github.permissions.update", `github-installation:${INSTALLATION}`);
    const ok = await attempt({ stepUpProofId: proof3 });
    expect(ok.ok).toBe(true);
  });
});

describe("github repository mapping", () => {
  it("maps exactly one workspace/project and strengthens project identity", async () => {
    const db = await openDomainDb();
    await install(db);
    // Mapping requires an active installation: pending fails closed.
    const projectId = await createGitHubProject(db);
    const pendingProof = await stepUp(db, FIX.owner, "github.repository.map", `github-link:${REPOSITORY}`);
    const pending = await hub(db).execute(mapGitHubRepositoryCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        installationId: INSTALLATION,
        repositoryId: REPOSITORY,
        projectId,
        fullName: "synthetic-org/synthetic-repo",
        defaultBranch: "main",
        stepUpProofId: pendingProof,
      },
    });
    expect(pending.ok).toBe(false);
    await activate(db);
    await mapRepo(db, projectId);
    const status = await getGitHubStatus(db, FIX.workspace);
    expect(status.links).toHaveLength(1);
    expect(status.links[0]?.project_id).toBe(projectId);
  });

  it("rejects identity mismatches and non-Owner remaps", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    // A project declaring a different immutable repository cannot be mapped.
    const mismatchProof = await stepUp(db, FIX.owner, "github.repository.map", "github-link:11111111");
    const mismatch = await hub(db).execute(mapGitHubRepositoryCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        installationId: INSTALLATION,
        repositoryId: "11111111",
        projectId,
        fullName: "synthetic-org/other",
        defaultBranch: "main",
        stepUpProofId: mismatchProof,
      },
    });
    expect(mismatch.ok).toBe(false);
    // A member cannot remap even with a valid proof shape.
    const memberProof = await stepUp(db, FIX.member, "github.repository.map", `github-link:${REPOSITORY}`);
    const member = await hub(db).execute(mapGitHubRepositoryCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        installationId: INSTALLATION,
        repositoryId: REPOSITORY,
        projectId,
        fullName: "synthetic-org/synthetic-repo",
        defaultBranch: "main",
        stepUpProofId: memberProof,
      },
    });
    expect(member.ok).toBe(false);
  });

  it("remaps atomically with exactly one active link", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectA = await createGitHubProject(db);
    await mapRepo(db, projectA);
    // Second project declaring the same immutable repository.
    const second = await hub(db).execute(createProjectCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        name: "Synthetic GitHub Two",
        slug: "github-two",
        tint: "#10B981",
        accessMode: "workspace",
        repositoryHost: "github.com",
        hostedRepositoryId: REPOSITORY,
        repositorySubpath: "packages/app",
      },
    });
    // Same repository id with a different subpath is a distinct project identity.
    expect(second.ok).toBe(true);
    const projectB = (second as { ok: true; result: { id: string } }).result.id;
    const proof = await stepUp(db, FIX.owner, "github.repository.map", `github-link:${REPOSITORY}`, 1, LATER);
    const remapped = await hub(db).execute(mapGitHubRepositoryCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: LATER,
      input: {
        installationId: INSTALLATION,
        repositoryId: REPOSITORY,
        projectId: projectB,
        fullName: "synthetic-org/synthetic-repo",
        defaultBranch: "main",
        stepUpProofId: proof,
      },
    });
    expect(remapped.ok).toBe(true);
    const active = (await db
      .prepare(
        `SELECT project_id FROM github_repository_links WHERE repository_id = ? AND link_state = 'active'`,
      )
      .all(REPOSITORY)) as Array<{ project_id: string }>;
    expect(active.map((row) => row.project_id)).toEqual([projectB]);
    const closed = (await db
      .prepare(
        `SELECT COUNT(*) AS count FROM github_repository_links WHERE repository_id = ? AND link_state = 'closed'`,
      )
      .get(REPOSITORY)) as { count: number };
    expect(closed.count).toBe(1);
  });
});

describe("github webhook receive and reconcile", () => {
  async function setup(): Promise<{ db: SqlDatabase; projectId: string }> {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    await mapRepo(db, projectId);
    return { db, projectId };
  }

  async function receive(
    db: SqlDatabase,
    deliveryId: string,
    effect: GitHubDeliveryEffect,
    now: string = NOW,
  ): Promise<{ result: ReceiveGitHubWebhookResult; replayed: boolean }> {
    const outcome = await hub(db).execute(receiveGitHubWebhookCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-delivery.${deliveryId}`,
      actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
      authorizationEpoch: 1,
      now,
      input: { deliveryId, event: effect.event, supported: true, effect },
    });
    if (!outcome.ok) {
      throw new Error(`receive failed: ${JSON.stringify(outcome)}`);
    }
    return outcome;
  }

  async function reconcile(
    db: SqlDatabase,
    outboxId: string,
    deliveryId: string,
    now: string = NOW,
  ): Promise<{ result: ReconcileGitHubResult; replayed: boolean }> {
    const outcome = await hub(db).execute(reconcileGitHubCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-reconcile.${outboxId}`,
      actorSystemId: GITHUB_QUEUE_SYSTEM_ID,
      authorizationEpoch: 1,
      now,
      input: {
        outboxId,
        deliveryId,
        observed: {
          repositoryFullName: "synthetic-org/synthetic-repo",
          defaultBranch: "main",
          fetchedAt: now,
        },
      },
    });
    if (!outcome.ok) {
      throw new Error(`reconcile failed: ${JSON.stringify(outcome)}`);
    }
    return outcome;
  }

  function pushEffect(sha: string, at: string): GitHubDeliveryEffect {
    return {
      event: "push",
      action: null,
      installationId: INSTALLATION,
      repositoryId: REPOSITORY,
      occurredAt: at,
      ref: "main",
      version: sha,
      detail: {},
    };
  }

  it("rejects unknown installations and commits nothing", async () => {
    const db = await openDomainDb();
    const outcome = await hub(db).execute(receiveGitHubWebhookCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-delivery.${randomUlid()}`,
      actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        deliveryId: randomUlid(),
        event: "push",
        supported: true,
        effect: {
          event: "push",
          action: null,
          installationId: "00000000",
          repositoryId: REPOSITORY,
          occurredAt: NOW,
          ref: "main",
          version: "a".repeat(40),
          detail: {},
        },
      },
    });
    expect(outcome.ok).toBe(false);
    const rows = (await db
      .prepare(`SELECT COUNT(*) AS count FROM github_webhook_deliveries`)
      .get()) as { count: number };
    expect(rows.count).toBe(0);
  });

  it("deduplicates redeliveries with one outbox row", async () => {
    const { db } = await setup();
    const deliveryId = randomUlid();
    const first = await receive(db, deliveryId, pushEffect("a".repeat(40), NOW));
    expect(first.ok).toBe(true);
    // Same idempotency key: the hub replays the stored result, no new effect.
    const second = await receive(db, deliveryId, pushEffect("a".repeat(40), NOW));
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    expect(second.result.outbox_id).toBe(first.result.outbox_id);
    // Same delivery under a fresh key: the command converges to duplicate.
    const third = await hub(db).execute(receiveGitHubWebhookCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-delivery-retry.${deliveryId}`,
      actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        deliveryId,
        event: "push",
        supported: true,
        effect: pushEffect("a".repeat(40), NOW),
      },
    });
    expect(third.ok).toBe(true);
    expect(
      (third as { ok: true; result: ReceiveGitHubWebhookResult }).result.duplicate,
    ).toBe(true);
    const outbox = (await db
      .prepare(`SELECT COUNT(*) AS count FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(deliveryId)) as { count: number };
    expect(outbox.count).toBe(1);
  });

  it("converges out-of-order pushes to the newest sha with one effect", async () => {
    const { db } = await setup();
    const newerId = randomUlid();
    const olderId = randomUlid();
    const newer = (await receive(db, newerId, pushEffect("b".repeat(40), LATER))).ok;
    const older = (await receive(db, olderId, pushEffect("a".repeat(40), NOW))).ok;
    expect(newer && older).toBe(true);
    const newerOutbox = (await db
      .prepare(`SELECT outbox_id FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(newerId)) as { outbox_id: string };
    const olderOutbox = (await db
      .prepare(`SELECT outbox_id FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(olderId)) as { outbox_id: string };
    // Newer delivery applies first (out-of-order arrival).
    const applied = await reconcile(db, newerOutbox.outbox_id, newerId, LATER);
    expect(applied.result.effect).toBe("applied");
    const stale = await reconcile(db, olderOutbox.outbox_id, olderId, LATER);
    expect(stale.result.effect).toBe("superseded");
    const commits = (await db
      .prepare(
        `SELECT ref, version_token FROM github_evidence WHERE kind = 'commit' AND observed_by = 'github'`,
      )
      .all()) as Array<{ ref: string; version_token: string }>;
    expect(commits).toHaveLength(1);
    expect(commits[0]?.version_token).toBe("b".repeat(40));
  });

  it("replays reconcile idempotently and isolates poison outbox rows", async () => {
    const { db } = await setup();
    const deliveryId = randomUlid();
    await receive(db, deliveryId, pushEffect("a".repeat(40), NOW));
    const outbox = (await db
      .prepare(`SELECT outbox_id FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(deliveryId)) as { outbox_id: string };
    const first = await reconcile(db, outbox.outbox_id, deliveryId);
    expect(first.result.effect).toBe("applied");
    // Same idempotency key: the hub replays the stored applied result.
    const replay = await reconcile(db, outbox.outbox_id, deliveryId);
    expect(replay.replayed).toBe(true);
    expect(replay.result.effect).toBe("applied");
    // Same outbox under a fresh key: the command itself is a no-op.
    const noop = await hub(db).execute(reconcileGitHubCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-reconcile-retry.${outbox.outbox_id}`,
      actorSystemId: GITHUB_QUEUE_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        outboxId: outbox.outbox_id,
        deliveryId,
        observed: {
          repositoryFullName: "synthetic-org/synthetic-repo",
          defaultBranch: "main",
          fetchedAt: NOW,
        },
      },
    });
    expect(noop.ok).toBe(true);
    expect((noop as { ok: true; result: ReconcileGitHubResult }).result.effect).toBe(
      "already_done",
    );
    // A message naming a missing outbox row is poison, isolated per message.
    const poison = await hub(db).execute(reconcileGitHubCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-reconcile.${randomUlid()}`,
      actorSystemId: GITHUB_QUEUE_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        outboxId: randomUlid(),
        deliveryId: randomUlid(),
        observed: {
          repositoryFullName: "synthetic-org/synthetic-repo",
          defaultBranch: "main",
          fetchedAt: NOW,
        },
      },
    });
    expect(poison.ok).toBe(false);
  });

  it("parks exhausted attempts in visible DLQ state", async () => {
    const { db } = await setup();
    const deliveryId = randomUlid();
    await receive(db, deliveryId, pushEffect("a".repeat(40), NOW));
    const outbox = (await db
      .prepare(`SELECT outbox_id FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(deliveryId)) as { outbox_id: string };
    await db
      .prepare(`UPDATE github_integration_outbox SET attempts = 5 WHERE outbox_id = ?`)
      .run(outbox.outbox_id);
    const outcome = await reconcile(db, outbox.outbox_id, deliveryId);
    expect(outcome.result.effect).toBe("dlq");
    const dlq = (await db
      .prepare(`SELECT error, attempts FROM github_dlq WHERE outbox_id = ?`)
      .get(outbox.outbox_id)) as { error: string; attempts: number };
    expect(dlq.error).toBe("attempts_exhausted");
    expect(dlq.attempts).toBe(5);
  });

  it("parks suspended installations except for lifecycle recovery", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    await db
      .prepare(`UPDATE github_app_installations SET status = 'suspended' WHERE installation_id = ?`)
      .run(INSTALLATION);
    const hubLane = new WorkspaceHub(db);
    const parked = await hubLane.execute(receiveGitHubWebhookCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        deliveryId: randomUlid(),
        event: "push",
        supported: true,
        effect: {
          event: "push",
          action: null,
          installationId: INSTALLATION,
          repositoryId: REPOSITORY,
          occurredAt: NOW,
          ref: "main",
          version: "a".repeat(40),
          detail: {},
        },
      },
    });
    expect(parked.ok).toBe(false);
    const recoveryId = randomUlid();
    const recovery = await hubLane.execute(receiveGitHubWebhookCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-delivery.${recoveryId}`,
      actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        deliveryId: recoveryId,
        event: "installation",
        supported: true,
        effect: {
          event: "installation",
          action: "unsuspend",
          installationId: INSTALLATION,
          repositoryId: null,
          occurredAt: NOW,
          ref: null,
          version: null,
          detail: {},
        },
      },
    });
    expect(recovery.ok).toBe(true);
  });

  it("ignores deliveries for unmapped repositories without task effects", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const deliveryId = randomUlid();
    await receive(db, deliveryId, pushEffect("a".repeat(40), NOW));
    const outbox = (await db
      .prepare(`SELECT outbox_id FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(deliveryId)) as { outbox_id: string };
    const outcome = await reconcile(db, outbox.outbox_id, deliveryId);
    expect(outcome.result.effect).toBe("ignored");
  });

  it("applies the installation lifecycle and survives revocation", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    await mapRepo(db, projectId);
    // Deleted flips the installation to revoked and closes links.
    const deletedId = randomUlid();
    await receive(db, deletedId, {
      event: "installation",
      action: "deleted",
      installationId: INSTALLATION,
      repositoryId: null,
      occurredAt: LATER,
      ref: null,
      version: null,
      detail: {},
    }, LATER);
    const outbox = (await db
      .prepare(`SELECT outbox_id FROM github_integration_outbox WHERE delivery_id = ?`)
      .get(deletedId)) as { outbox_id: string };
    const outcome = await reconcile(db, outbox.outbox_id, deletedId, LATER);
    expect(outcome.result.effect).toBe("applied");
    const status = await getGitHubStatus(db, FIX.workspace);
    expect(status.installations[0]?.status).toBe("revoked");
    expect(status.links).toHaveLength(0);
    // Later deliveries for the revoked installation are recorded as ignored.
    const afterId = randomUlid();
    const ignored = await receive(db, afterId, pushEffect("c".repeat(40), LATER), LATER);
    expect(ignored.result.state).toBe("ignored");
    expect(ignored.result.outbox_id).toBe(null);
  });
});

describe("github evidence linking and provenance", () => {
  it("links runner-observed evidence without touching task state", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    await mapRepo(db, projectId);
    const task = await hub(db).execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      input: { projectId, title: "Synthetic evidence task", priority: "P2" },
    });
    const taskId = (task as { ok: true; result: { id: string } }).result.id;
    const linked = await hub(db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        projectId,
        taskId,
        repositoryId: REPOSITORY,
        kind: "commit",
        ref: "d".repeat(40),
        versionToken: "d".repeat(40),
        observedBy: "runner",
      },
    });
    expect(linked.ok).toBe(true);
    const state = (await db
      .prepare(`SELECT state FROM tasks WHERE workspace_id = ? AND id = ?`)
      .get(FIX.workspace, taskId)) as { state: string };
    expect(state.state).toBe("ready");
    // Reviewers cannot link; the github observer is reserved for reconcile.
    const reviewer = await hub(db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.reviewer,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        projectId,
        repositoryId: REPOSITORY,
        kind: "commit",
        ref: "e".repeat(40),
        versionToken: "e".repeat(40),
        observedBy: "runner",
      },
    });
    expect(reviewer.ok).toBe(false);
    const forged = await hub(db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        projectId,
        repositoryId: REPOSITORY,
        kind: "commit",
        ref: "e".repeat(40),
        versionToken: "e".repeat(40),
        observedBy: "github",
      },
    });
    expect(forged.ok).toBe(false);
    const listed = await listGitHubEvidence(db, FIX.workspace, { taskId });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.observed_by).toBe("runner");
  });

  it("never upgrades runner claims without matching github evidence", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    await mapRepo(db, projectId);
    const sha = "f".repeat(40);
    const ref = `github:${REPOSITORY}:commit:${sha}`;
    // No evidence at all: unverified.
    expect(
      await getEvidenceVerificationStatus(db, FIX.workspace, [{ kind: "github", ref }]),
    ).toEqual([{ kind: "github", ref, provenance: "unverified" }]);
    // Runner claim alone stays runner-observed.
    const linked = await hub(db).execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: randomUlid(),
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        projectId,
        repositoryId: REPOSITORY,
        kind: "commit",
        ref: sha,
        versionToken: sha,
        observedBy: "runner",
      },
    });
    expect(linked.ok).toBe(true);
    expect(
      await getEvidenceVerificationStatus(db, FIX.workspace, [{ kind: "github", ref }]),
    ).toEqual([{ kind: "github", ref, provenance: "runner_observed" }]);
    // A version mismatch is not verification either.
    expect(
      await getEvidenceVerificationStatus(db, FIX.workspace, [{ kind: "github", ref, version: "other" }]),
    ).toEqual([{ kind: "github", ref, provenance: "runner_observed" }]);
    // Non-github kinds stay opaque per the results contract.
    expect(
      await getEvidenceVerificationStatus(db, FIX.workspace, [{ kind: "artifact_version", ref: "x" }]),
    ).toEqual([{ kind: "artifact_version", ref: "x", provenance: "opaque" }]);
  });
});

describe("github queue envelope and outbox recovery", () => {
  it("round-trips valid envelopes and isolates poison ones", () => {
    const message = githubQueueMessage({
      workspaceId: FIX.workspace,
      outboxId: randomUlid(),
      deliveryId: randomUlid(),
      attempt: 0,
    });
    expect(parseGitHubQueueMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(() => parseGitHubQueueMessage({ ...message, kind: "other" })).toThrow(DomainError);
    expect(() => parseGitHubQueueMessage({ ...message, attempt: -1 })).toThrow(DomainError);
    expect(() => parseGitHubQueueMessage(null)).toThrow(DomainError);
  });

  it("claims pending rows once and reclaims stale dispatches", async () => {
    const db = await openDomainDb();
    await install(db);
    await activate(db);
    const projectId = await createGitHubProject(db);
    await mapRepo(db, projectId);
    const deliveryId = randomUlid();
    const received = await hub(db).execute(receiveGitHubWebhookCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: `github-delivery.${deliveryId}`,
      actorSystemId: GITHUB_WEBHOOK_SYSTEM_ID,
      authorizationEpoch: 1,
      now: NOW,
      input: {
        deliveryId,
        event: "push",
        supported: true,
        effect: {
          event: "push",
          action: null,
          installationId: INSTALLATION,
          repositoryId: REPOSITORY,
          occurredAt: NOW,
          ref: "main",
          version: "a".repeat(40),
          detail: {},
        },
      },
    });
    expect(received.ok).toBe(true);
    // The crash gap: D1 committed, enqueue never happened. Cron claims it once.
    const first = await claimGitHubOutboxBatch(db, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]?.delivery_id).toBe(deliveryId);
    const second = await claimGitHubOutboxBatch(db, NOW);
    expect(second).toHaveLength(0);
    // A dispatched row that never finishes is reclaimed after the stale window.
    const reclaimed = await reclaimStaleGitHubOutbox(db, "2026-09-18T12:20:00.000Z");
    expect(reclaimed).toHaveLength(1);
    // Consumer attempt bookkeeping advances with backoff.
    const attempts = await noteGitHubOutboxAttempt(
      db,
      FIX.workspace,
      first[0]?.outbox_id as string,
      "github_unreachable",
      "2026-09-18T12:20:00.000Z",
    );
    expect(attempts).toBeGreaterThan(1);
    // Exhausted rows move to visible DLQ state.
    await db
      .prepare(`UPDATE github_integration_outbox SET attempts = 5, updated_at = ? WHERE outbox_id = ?`)
      .run(NOW, first[0]?.outbox_id as string);
    await writeGitHubDlqRow(
      db,
      FIX.workspace,
      first[0]?.outbox_id as string,
      deliveryId,
      "poison",
      5,
      "2026-09-18T12:30:00.000Z",
    );
    const dlq = (await db
      .prepare(`SELECT error FROM github_dlq WHERE outbox_id = ?`)
      .get(first[0]?.outbox_id as string)) as { error: string };
    expect(dlq.error).toBe("poison");
    expect(await claimGitHubOutboxBatch(db, "2026-09-18T12:30:00.000Z")).toHaveLength(0);
  });
});
