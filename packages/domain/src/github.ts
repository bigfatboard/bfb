// ABOUTME: Owns GitHub App installation, repository link, delivery, outbox, and evidence records.
// ABOUTME: Owner step-up gates management; reconcile converges duplicates with latest-wins guards.

import { createHmac, timingSafeEqual } from "node:crypto";

import type { SqlDatabase } from "@bfb/db";

import { assertEpoch, assertProjectAccess, assertRole, loadPrincipal } from "./authorization.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { isUlid, randomUlid, syntheticUlid } from "./ids.js";
import { validateStepUpProof, type StepUpAction } from "./step-up.js";

/** System actor for unauthenticated webhook ingest (HMAC is the credential). */
export const GITHUB_WEBHOOK_SYSTEM_ID = syntheticUlid("GITHUBWEBHOOK");
/** System actor for Queue/Cron reconcile work. */
export const GITHUB_QUEUE_SYSTEM_ID = syntheticUlid("GITHUBQUEUE");

/** Raw webhook bodies larger than this are rejected before parsing. */
export const GITHUB_WEBHOOK_BODY_LIMIT = 262_144;
/** Extracted delivery effects are bounded so D1 rows and hub batches stay small. */
export const GITHUB_EFFECT_JSON_LIMIT = 2_048;
/** Reconcile observations from GitHub REST stay bounded. */
export const GITHUB_OBSERVED_JSON_LIMIT = 1_024;
/** A dispatch that starts processing this many times is poison. */
export const GITHUB_OUTBOX_MAX_ATTEMPTS = 5;
/** A dispatched outbox row this old is presumed lost and may be re-enqueued. */
export const GITHUB_OUTBOX_STALE_SECONDS = 300;
/** Cron claims at most this many outbox rows per tick. */
export const GITHUB_OUTBOX_CRON_LIMIT = 25;

/**
 * Least-privilege App permission inventory. Recorded at install time, enforced
 * on every permission change, and frozen in docs/contracts/github.md. v0.1 is
 * read-side only: no write permission may be granted without a later package.
 */
export const GITHUB_PERMISSIONS_ALLOWLIST: Record<string, readonly string[]> = {
  metadata: ["read"],
  pull_requests: ["read"],
  checks: ["read"],
  commit_statuses: ["read"],
  issues: ["read"],
  deployments: ["read"],
};

/** Webhook events BFB subscribes to. Anything else is recorded as ignored. */
export const GITHUB_WEBHOOK_EVENTS_ALLOWLIST = [
  "installation",
  "installation_repositories",
  "push",
  "pull_request",
  "check_run",
  "check_suite",
  "status",
  "issues",
  "deployment",
  "deployment_status",
] as const;

export type GitHubWebhookEvent = (typeof GITHUB_WEBHOOK_EVENTS_ALLOWLIST)[number];

export type GitHubInstallationStatus = "pending" | "active" | "suspended" | "revoked";
export type GitHubDeliveryState =
  | "received"
  | "queued"
  | "applied"
  | "superseded"
  | "ignored"
  | "failed";
export type GitHubOutboxState = "pending" | "dispatched" | "done" | "dlq";
export type GitHubEvidenceKind =
  | "issue"
  | "branch"
  | "commit"
  | "pull_request"
  | "check"
  | "deployment";
export type GitHubObserver = "github" | "runner" | "human";

export const GITHUB_STEP_UP_ACTIONS = {
  install: "github.install",
  remove: "github.remove",
  map: "github.repository.map",
  permissions: "github.permissions.update",
} as const;

const NUMERIC_ID_PATTERN = /^[0-9]{1,20}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:~-]{8,128}$/;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}\/[A-Za-z0-9_.-]{1,128}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9_./-]{1,256}$/;
const SHA_PATTERN = /^[0-9a-f]{4,64}$/;
const ACTION_PATTERN = /^[a-z_]{1,64}$/;

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function closedObject(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    fail("invalid_argument", `${what} must be an object with known fields`);
  }
  return value as Record<string, unknown>;
}

function numericId(value: unknown, field: string): string {
  // GitHub encodes ids as JSON numbers on the wire; fixtures may use strings.
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("invalid_argument", `${field} must be a numeric GitHub id`);
    }
    return String(value);
  }
  if (typeof value !== "string" || !NUMERIC_ID_PATTERN.test(value)) {
    fail("invalid_argument", `${field} must be a numeric GitHub id`);
  }
  return value;
}

function countText(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("invalid_argument", `${field} is invalid`);
    }
    return String(value);
  }
  return boundedText(value, field, 16, /^[0-9]{1,16}$/);
}

function boundedText(value: unknown, field: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    fail("invalid_argument", `${field} is invalid`);
  }
  if (pattern && !pattern.test(value)) {
    fail("invalid_argument", `${field} is invalid`);
  }
  if ([...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  })) {
    fail("invalid_argument", `${field} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  maximum: number,
  pattern?: RegExp,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return boundedText(value, field, maximum, pattern);
}

function utcTime(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("invalid_argument", `${field} must be an ISO timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}

/**
 * Verifies the GitHub webhook HMAC-SHA256 signature over the exact raw bytes
 * before any JSON parsing. Only `sha256=` signatures are accepted.
 */
export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
): void {
  if (!secret || !signatureHeader || !signatureHeader.startsWith("sha256=")) {
    fail("webhook_signature_invalid", "webhook signature is invalid");
  }
  const hex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    fail("webhook_signature_invalid", "webhook signature is invalid");
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(hex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    fail("webhook_signature_invalid", "webhook signature is invalid");
  }
}

/** Bounded effect extracted from one verified webhook payload. */
export interface GitHubDeliveryEffect {
  event: string;
  action: string | null;
  installationId: string;
  repositoryId: string | null;
  occurredAt: string;
  ref: string | null;
  version: string | null;
  detail: Record<string, string>;
}

function installationOf(payload: Record<string, unknown>): Record<string, unknown> {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object" || Array.isArray(installation)) {
    fail("webhook_payload_invalid", "webhook payload is missing its installation");
  }
  return installation as Record<string, unknown>;
}

function repositoryOf(payload: Record<string, unknown>): Record<string, unknown> | null {
  const repository = payload.repository;
  if (repository === undefined || repository === null) {
    return null;
  }
  if (typeof repository !== "object" || Array.isArray(repository)) {
    fail("webhook_payload_invalid", "webhook repository is invalid");
  }
  return repository as Record<string, unknown>;
}

function payloadTime(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("webhook_payload_invalid", "webhook timestamp is invalid");
  }
  return new Date(Date.parse(value)).toISOString();
}

/**
 * Extracts the bounded reconcile effect from a verified webhook payload.
 * Returns `{supported: false}` for events outside the subscribed set; throws
 * only for malformed payloads that can never reconcile.
 */
export function extractWebhookEffect(
  event: string,
  payload: unknown,
  receivedAt: string,
): { supported: boolean; effect?: GitHubDeliveryEffect } {
  if (!(GITHUB_WEBHOOK_EVENTS_ALLOWLIST as readonly string[]).includes(event)) {
    return { supported: false };
  }
  const body = closedObject(payload, knownPayloadKeys(event), "webhook payload");
  const installation = installationOf(body);
  const installationId = numericId(installation.id, "installation id");
  const repository = repositoryOf(body);
  const repositoryId =
    repository === null ? null : numericId(repository.id, "repository id");
  const action = optionalText(body.action, "webhook action", 64, ACTION_PATTERN);
  const detail: Record<string, string> = {};
  let ref: string | null = null;
  let version: string | null = null;
  let occurredAt: string | null = null;

  const take = (key: string, value: unknown, maximum: number, pattern?: RegExp): void => {
    if (value === undefined || value === null) {
      return;
    }
    detail[key] = boundedText(value, `webhook ${key}`, maximum, pattern);
  };

  switch (event) {
    case "installation": {
      take("account_login", (installation.account as Record<string, unknown> | undefined)?.login, 128, LOGIN_PATTERN);
      take("account_type", (installation.account as Record<string, unknown> | undefined)?.type, 32);
      occurredAt = payloadTime(installation.updated_at) ?? receivedAt;
      break;
    }
    case "installation_repositories": {
      for (const key of ["repositories_added", "repositories_removed"] as const) {
        const entries = body[key];
        if (entries === undefined) {
          continue;
        }
        if (!Array.isArray(entries) || entries.length > 100) {
          fail("webhook_payload_invalid", "webhook repository list is invalid");
        }
        detail[key] = entries
          .map((entry) => numericId((entry as Record<string, unknown>).id, "repository id"))
          .join(",");
      }
      occurredAt = receivedAt;
      break;
    }
    case "push": {
      const branch = String(body.ref ?? "").replace(/^refs\/heads\//, "");
      ref = boundedText(branch, "push branch", 256, BRANCH_PATTERN);
      if (body.head_commit === null || body.head_commit === undefined) {
        // Branch deletion: no head commit exists.
        version = "deleted";
        detail.push_deleted = "true";
        occurredAt = receivedAt;
        break;
      }
      const head = closedObject(body.head_commit, ["id", "timestamp", "message", "author", "url", "distinct", "added", "removed", "modified"], "push head commit");
      const sha = boundedText(head.id, "push sha", 64, SHA_PATTERN);
      version = sha;
      occurredAt = payloadTime(head.timestamp) ?? receivedAt;
      break;
    }
    case "pull_request": {
      const pull = closedObject(body.pull_request ?? {}, ["number", "head", "base", "state", "merged", "updated_at", "title"], "pull request");
      const number = countText(pull.number, "pull request number");
      const head = (pull.head ?? {}) as Record<string, unknown>;
      ref = number;
      version = boundedText(head.sha, "pull request sha", 64, SHA_PATTERN);
      take("pr_state", pull.state, 32);
      take("pr_title", pull.title, 256);
      occurredAt = payloadTime(pull.updated_at) ?? receivedAt;
      break;
    }
    case "check_run": {
      const check = closedObject(body.check_run ?? {}, ["id", "name", "head_sha", "status", "conclusion", "started_at", "completed_at"], "check run");
      ref = countText(check.id, "check run id");
      take("check_name", check.name, 256);
      take("check_status", check.status, 32);
      take("check_conclusion", check.conclusion, 32);
      take("head_sha", check.head_sha, 64, SHA_PATTERN);
      version = [take2(check.status), take2(check.conclusion), take2(check.head_sha)]
        .filter((part) => part !== "")
        .join(":");
      occurredAt = payloadTime(check.completed_at) ?? payloadTime(check.started_at) ?? receivedAt;
      break;
    }
    case "check_suite": {
      const suite = closedObject(body.check_suite ?? {}, ["id", "head_sha", "status", "conclusion", "updated_at", "created_at"], "check suite");
      ref = countText(suite.id, "check suite id");
      take("check_status", suite.status, 32);
      take("check_conclusion", suite.conclusion, 32);
      take("head_sha", suite.head_sha, 64, SHA_PATTERN);
      version = [take2(suite.status), take2(suite.conclusion), take2(suite.head_sha)]
        .filter((part) => part !== "")
        .join(":");
      occurredAt = payloadTime(suite.updated_at) ?? receivedAt;
      break;
    }
    case "status": {
      ref = boundedText(body.context ?? body.name, "status context", 256);
      version = [take2(body.state), take2(body.sha)].filter((part) => part !== "").join(":");
      take("status_state", body.state, 32);
      take("head_sha", body.sha, 64, SHA_PATTERN);
      occurredAt = payloadTime(body.updated_at) ?? receivedAt;
      break;
    }
    case "issues": {
      const issue = closedObject(body.issue ?? {}, ["number", "state", "title", "updated_at"], "issue");
      ref = countText(issue.number, "issue number");
      version = boundedText(issue.state, "issue state", 32);
      take("issue_title", issue.title, 256);
      occurredAt = payloadTime(issue.updated_at) ?? receivedAt;
      break;
    }
    case "deployment": {
      const deployment = closedObject(body.deployment ?? {}, ["id", "sha", "environment", "created_at"], "deployment");
      ref = countText(deployment.id, "deployment id");
      take("deployment_environment", deployment.environment, 128);
      take("head_sha", deployment.sha, 64, SHA_PATTERN);
      version = take2(deployment.sha);
      occurredAt = payloadTime(deployment.created_at) ?? receivedAt;
      break;
    }
    case "deployment_status": {
      const status = closedObject(
        body.deployment_status ?? {},
        ["id", "state", "deployment", "updated_at", "created_at"],
        "deployment status",
      );
      const deployment = (status.deployment ?? {}) as Record<string, unknown>;
      ref = countText(deployment.id ?? status.id, "deployment id");
      version = boundedText(status.state, "deployment state", 32);
      occurredAt = payloadTime(status.updated_at) ?? payloadTime(status.created_at) ?? receivedAt;
      break;
    }
    default: {
      return { supported: false };
    }
  }

  const effect: GitHubDeliveryEffect = {
    event,
    action,
    installationId,
    repositoryId,
    occurredAt: occurredAt ?? receivedAt,
    ref,
    version: version === "" ? null : version,
    detail,
  };
  if (JSON.stringify(effect).length > GITHUB_EFFECT_JSON_LIMIT) {
    fail("webhook_payload_invalid", "webhook effect exceeds its bound");
  }
  return { supported: true, effect };
}

function take2(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function requireOwner(ctx: HubContext) {
  if (!ctx.actorHumanId) {
    fail("unauthenticated", "human actor required");
  }
  const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
  assertEpoch(principal, ctx.authorizationEpoch);
  assertRole(principal, ["owner"]);
  return principal;
}

/** Predicate SQL is compiled by this module, never provided by a caller. */
async function guard(db: SqlDatabase, predicate: string, params: unknown[]): Promise<void> {
  const guardId = randomUlid();
  await db
    .prepare(`INSERT INTO runner_mutation_guards (id, valid) VALUES (?, (${predicate}))`)
    .run(guardId, ...params);
  await db.prepare(`DELETE FROM runner_mutation_guards WHERE id = ?`).run(guardId);
}

function stepUpTarget(kind: string, id: string): string {
  return `github-${kind}:${id}`;
}

async function prepareStepUp(
  ctx: HubContext,
  proofId: string,
  action: string,
  targetId: string,
): Promise<() => Promise<void>> {
  if (typeof proofId !== "string" || !proofId) {
    fail("step_up_invalid", "step-up proof is required");
  }
  const proof = (await ctx.db
    .prepare(`SELECT expires_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
    .get(proofId)) as { expires_at: string } | undefined;
  if (!proof || !ctx.actorHumanId) {
    fail("step_up_invalid", "step-up proof is invalid");
  }
  const expected: StepUpAction = {
    action,
    workspaceId: ctx.workspaceId,
    targetId,
    scopes: [],
    authorizationEpoch: ctx.authorizationEpoch,
    expiresAt: proof.expires_at,
  };
  await validateStepUpProof(ctx.db, proofId, expected, ctx.now, ctx.actorHumanId);
  const stamp = randomUlid();
  return async () => {
    await ctx.db
      .prepare(
        `UPDATE passkey_step_up_proofs SET consumed_at = ? WHERE proof_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(stamp, proofId, ctx.now);
    await guard(
      ctx.db,
      `SELECT COUNT(*) = 1 FROM passkey_step_up_proofs WHERE proof_id = ? AND consumed_at = ?`,
      [proofId, stamp],
    );
  };
}

function assertPermissionsSubset(permissions: unknown): Record<string, string> {
  const body = closedObject(permissions, Object.keys(GITHUB_PERMISSIONS_ALLOWLIST), "github permissions");
  const result: Record<string, string> = {};
  for (const [name, access] of Object.entries(body)) {
    const allowed = GITHUB_PERMISSIONS_ALLOWLIST[name];
    if (!allowed || typeof access !== "string" || !allowed.includes(access)) {
      fail("github_permission_forbidden", `github permission ${name} is outside the v0.1 inventory`);
    }
    result[name] = access;
  }
  return result;
}

function assertEventsSubset(events: unknown): string[] {
  if (!Array.isArray(events) || events.length < 1 || events.length > 32) {
    fail("invalid_argument", "github webhook events must be a non-empty list");
  }
  const result = [...new Set(events)].sort();
  for (const event of result) {
    if (typeof event !== "string" || !(GITHUB_WEBHOOK_EVENTS_ALLOWLIST as readonly string[]).includes(event)) {
      fail("github_event_forbidden", `github webhook event ${String(event)} is not subscribed`);
    }
  }
  return result;
}

export interface GitHubInstallationSummary {
  installation_id: string;
  workspace_id: string;
  app_id: string;
  app_slug: string;
  account_login: string;
  status: GitHubInstallationStatus;
  resource_version: number;
}

export interface InstallGitHubInput {
  installationId: string;
  appId: string;
  appSlug: string;
  accountId: string;
  accountLogin: string;
  accountType: string;
  permissions: unknown;
  events: unknown;
  stepUpProofId: string;
}

export const installGitHubCommand: HubCommand<InstallGitHubInput, GitHubInstallationSummary> = {
  name: "github.install",
  replay: "reject",
  auditInput: (input) => ({ installationId: input.installationId }),
  async run(input, ctx) {
    closedObject(input, ["installationId", "appId", "appSlug", "accountId", "accountLogin", "accountType", "permissions", "events", "stepUpProofId"], "github install");
    await requireOwner(ctx);
    const installationId = numericId(input.installationId, "installation id");
    const appId = numericId(input.appId, "app id");
    const appSlug = boundedText(input.appSlug, "app slug", 128, SLUG_PATTERN);
    const accountId = numericId(input.accountId, "account id");
    const accountLogin = boundedText(input.accountLogin, "account login", 128, LOGIN_PATTERN);
    if (input.accountType !== "User" && input.accountType !== "Organization") {
      fail("invalid_argument", "account type is invalid");
    }
    const permissions = assertPermissionsSubset(input.permissions);
    const events = assertEventsSubset(input.events);
    // All reads precede the step-up consume: D1 batches forbid reads after a queued write.
    const existing = (await ctx.db
      .prepare(
        `SELECT status, resource_version FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(installationId)) as
      | { status: GitHubInstallationStatus; resource_version: number }
      | undefined;
    if (existing && existing.status !== "revoked") {
      fail("already_exists", "github installation is already registered");
    }
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      GITHUB_STEP_UP_ACTIONS.install,
      stepUpTarget("installation", installationId),
    );
    await consume();
    if (existing) {
      await ctx.db
        .prepare(
          `UPDATE github_app_installations
           SET workspace_id = ?, app_id = ?, app_slug = ?, account_id = ?, account_login = ?,
               account_type = ?, status = 'pending', permissions_json = ?, events_json = ?,
               installed_by_human_id = ?, updated_at = ?, revoked_at = NULL,
               resource_version = resource_version + 1
           WHERE installation_id = ?`,
        )
        .run(
          ctx.workspaceId, appId, appSlug, accountId, accountLogin, input.accountType,
          JSON.stringify(permissions), JSON.stringify(events), ctx.actorHumanId, ctx.now,
          installationId,
        );
    } else {
      await ctx.db
        .prepare(
          `INSERT INTO github_app_installations
           (installation_id, workspace_id, app_id, app_slug, account_id, account_login,
            account_type, status, permissions_json, events_json, installed_by_human_id,
            created_at, updated_at, revoked_at, resource_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, 1)`,
        )
        .run(
          installationId, ctx.workspaceId, appId, appSlug, accountId, accountLogin,
          input.accountType, JSON.stringify(permissions), JSON.stringify(events),
          ctx.actorHumanId, ctx.now, ctx.now,
        );
    }
    const row = (await ctx.db
      .prepare(
        `SELECT status, resource_version FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(installationId)) as { status: GitHubInstallationStatus; resource_version: number };
    return {
      installation_id: installationId,
      workspace_id: ctx.workspaceId,
      app_id: appId,
      app_slug: appSlug,
      account_login: accountLogin,
      status: row.status,
      resource_version: row.resource_version,
    };
  },
};

export interface RemoveGitHubInput {
  installationId: string;
  stepUpProofId: string;
}

export const removeGitHubCommand: HubCommand<RemoveGitHubInput, GitHubInstallationSummary> = {
  name: "github.remove",
  replay: "reject",
  auditInput: (input) => ({ installationId: input.installationId }),
  async run(input, ctx) {
    closedObject(input, ["installationId", "stepUpProofId"], "github remove");
    await requireOwner(ctx);
    const installationId = numericId(input.installationId, "installation id");
    // All reads precede the step-up consume: D1 batches forbid reads after a queued write.
    const row = (await ctx.db
      .prepare(
        `SELECT workspace_id, status, resource_version FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(installationId)) as
      | { workspace_id: string; status: GitHubInstallationStatus; resource_version: number }
      | undefined;
    if (!row || row.workspace_id !== ctx.workspaceId) {
      fail("not_found", "github installation not found");
    }
    if (row.status === "revoked") {
      fail("already_revoked", "github installation is already revoked");
    }
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      GITHUB_STEP_UP_ACTIONS.remove,
      stepUpTarget("installation", installationId),
    );
    await consume();
    await guard(
      ctx.db,
      `SELECT COUNT(*) = 1 FROM github_app_installations WHERE installation_id = ? AND resource_version = ? AND status != 'revoked'`,
      [installationId, row.resource_version],
    );
    await ctx.db
      .prepare(
        `UPDATE github_app_installations
         SET status = 'revoked', revoked_at = ?, updated_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ?`,
      )
      .run(ctx.now, ctx.now, installationId);
    await ctx.db
      .prepare(
        `UPDATE github_repository_links
         SET link_state = 'closed', closed_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ? AND link_state = 'active'`,
      )
      .run(ctx.now, installationId);
    const after = (await ctx.db
      .prepare(
        `SELECT app_id, app_slug, account_login, status, resource_version FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(installationId)) as {
      app_id: string;
      app_slug: string;
      account_login: string;
      status: GitHubInstallationStatus;
      resource_version: number;
    };
    return {
      installation_id: installationId,
      workspace_id: ctx.workspaceId,
      app_id: after.app_id,
      app_slug: after.app_slug,
      account_login: after.account_login,
      status: after.status,
      resource_version: after.resource_version,
    };
  },
};

export interface GitHubRepositoryLinkSummary {
  link_id: string;
  workspace_id: string;
  repository_id: string;
  installation_id: string;
  project_id: string;
  full_name: string;
  default_branch: string;
  link_state: "active" | "closed";
  resource_version: number;
}

export interface MapGitHubRepositoryInput {
  installationId: string;
  repositoryId: string;
  projectId: string;
  fullName: string;
  defaultBranch: string;
  stepUpProofId: string;
}

export const mapGitHubRepositoryCommand: HubCommand<MapGitHubRepositoryInput, GitHubRepositoryLinkSummary> = {
  name: "github.repository.map",
  replay: "reject",
  auditInput: (input) => ({ repositoryId: input.repositoryId, projectId: input.projectId }),
  async run(input, ctx) {
    closedObject(input, ["installationId", "repositoryId", "projectId", "fullName", "defaultBranch", "stepUpProofId"], "github repository map");
    const principal = await requireOwner(ctx);
    const installationId = numericId(input.installationId, "installation id");
    const repositoryId = numericId(input.repositoryId, "repository id");
    if (!isUlid(input.projectId)) {
      fail("invalid_argument", "project id is invalid");
    }
    const fullName = boundedText(input.fullName, "repository full name", 256, FULL_NAME_PATTERN);
    const defaultBranch = boundedText(input.defaultBranch, "default branch", 256, BRANCH_PATTERN);
    assertProjectAccess(principal, input.projectId);
    const installation = (await ctx.db
      .prepare(
        `SELECT workspace_id, status FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(installationId)) as { workspace_id: string; status: GitHubInstallationStatus } | undefined;
    if (!installation || installation.workspace_id !== ctx.workspaceId) {
      fail("not_found", "github installation not found");
    }
    if (installation.status !== "active") {
      fail("installation_not_active", "github installation is not active");
    }
    const project = (await ctx.db
      .prepare(
        `SELECT repository_host, hosted_repository_id FROM projects WHERE workspace_id = ? AND id = ?`,
      )
      .get(ctx.workspaceId, input.projectId)) as
      | { repository_host: string; hosted_repository_id: string }
      | undefined;
    if (!project) {
      fail("not_found", "project not found");
    }
    // The immutable GitHub repository id strengthens project identity: the
    // project must already declare this exact repository.
    if (project.repository_host !== "github.com" || project.hosted_repository_id !== repositoryId) {
      fail("repository_identity_mismatch", "project does not declare this GitHub repository");
    }
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      GITHUB_STEP_UP_ACTIONS.map,
      stepUpTarget("link", repositoryId),
    );
    await consume();
    // Remap: close any active link for this repository or this project first.
    await ctx.db
      .prepare(
        `UPDATE github_repository_links
         SET link_state = 'closed', closed_at = ?, resource_version = resource_version + 1
         WHERE link_state = 'active' AND (repository_id = ? OR (workspace_id = ? AND project_id = ?))`,
      )
      .run(ctx.now, repositoryId, ctx.workspaceId, input.projectId);
    const linkId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO github_repository_links
         (workspace_id, id, repository_id, installation_id, project_id, full_name,
          default_branch, link_state, created_at, closed_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, 1)`,
      )
      .run(
        ctx.workspaceId, linkId, repositoryId, installationId, input.projectId,
        fullName, defaultBranch, ctx.now,
      );
    return {
      link_id: linkId,
      workspace_id: ctx.workspaceId,
      repository_id: repositoryId,
      installation_id: installationId,
      project_id: input.projectId,
      full_name: fullName,
      default_branch: defaultBranch,
      link_state: "active",
      resource_version: 1,
    };
  },
};

export interface UpdateGitHubPermissionsInput {
  installationId: string;
  expectedVersion: number;
  permissions: unknown;
  events: unknown;
  stepUpProofId: string;
}

export const updateGitHubPermissionsCommand: HubCommand<UpdateGitHubPermissionsInput, GitHubInstallationSummary> = {
  name: "github.permissions.update",
  replay: "reject",
  auditInput: (input) => ({ installationId: input.installationId }),
  async run(input, ctx) {
    closedObject(input, ["installationId", "expectedVersion", "permissions", "events", "stepUpProofId"], "github permissions update");
    await requireOwner(ctx);
    const installationId = numericId(input.installationId, "installation id");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      fail("invalid_argument", "expected version is invalid");
    }
    const permissions = assertPermissionsSubset(input.permissions);
    const events = assertEventsSubset(input.events);
    const row = (await ctx.db
      .prepare(
        `SELECT workspace_id, status, resource_version, app_id, app_slug, account_login
         FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(installationId)) as
      | {
          workspace_id: string;
          status: GitHubInstallationStatus;
          resource_version: number;
          app_id: string;
          app_slug: string;
          account_login: string;
        }
      | undefined;
    if (!row || row.workspace_id !== ctx.workspaceId) {
      fail("not_found", "github installation not found");
    }
    if (row.status === "revoked") {
      fail("installation_revoked", "github installation is revoked");
    }
    if (row.resource_version !== input.expectedVersion) {
      fail("stale_version", "github installation version conflict");
    }
    const consume = await prepareStepUp(
      ctx,
      input.stepUpProofId,
      GITHUB_STEP_UP_ACTIONS.permissions,
      stepUpTarget("installation", installationId),
    );
    await consume();
    await guard(
      ctx.db,
      `SELECT COUNT(*) = 1 FROM github_app_installations WHERE installation_id = ? AND resource_version = ?`,
      [installationId, input.expectedVersion],
    );
    await ctx.db
      .prepare(
        `UPDATE github_app_installations
         SET permissions_json = ?, events_json = ?, updated_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ?`,
      )
      .run(JSON.stringify(permissions), JSON.stringify(events), ctx.now, installationId);
    return {
      installation_id: installationId,
      workspace_id: ctx.workspaceId,
      app_id: row.app_id,
      app_slug: row.app_slug,
      account_login: row.account_login,
      status: row.status,
      resource_version: input.expectedVersion + 1,
    };
  },
};

function assertSystem(ctx: HubContext, expected: string): void {
  if (ctx.actorSystemId !== expected || ctx.actorHumanId || ctx.actorDelegationId || ctx.actorRunnerId) {
    fail("forbidden", "github pipeline commands require their system actor");
  }
}

export interface ReceiveGitHubWebhookInput {
  deliveryId: string;
  event: string;
  supported: boolean;
  effect: GitHubDeliveryEffect | null;
}

export interface ReceiveGitHubWebhookResult {
  workspace_id: string;
  delivery_id: string;
  outbox_id: string | null;
  duplicate: boolean;
  state: GitHubDeliveryState;
}

/**
 * Atomically commits one unique received delivery plus its integration outbox
 * row. The Queue enqueue happens after this command commits; a crash between
 * the two is recovered by Cron redelivery of `pending` outbox rows.
 */
export const receiveGitHubWebhookCommand: HubCommand<ReceiveGitHubWebhookInput, ReceiveGitHubWebhookResult> = {
  name: "github.webhook.receive",
  auditInput: (input) => ({ deliveryId: input.deliveryId, event: input.event }),
  async run(input, ctx) {
    assertSystem(ctx, GITHUB_WEBHOOK_SYSTEM_ID);
    closedObject(input, ["deliveryId", "event", "supported", "effect"], "github webhook receive");
    if (typeof input.deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(input.deliveryId)) {
      fail("invalid_argument", "delivery id is invalid");
    }
    if (typeof input.event !== "string" || input.event.length < 1 || input.event.length > 64) {
      fail("invalid_argument", "webhook event is invalid");
    }
    if (typeof input.supported !== "boolean") {
      fail("invalid_argument", "webhook support flag is invalid");
    }
    if (!input.supported || !input.effect) {
      // The installation is unknown before extraction, so unsupported events
      // without an effect cannot be attributed and never reach this command.
      fail("webhook_event_unsupported", "webhook event is not subscribed");
    }
    const effect = input.effect;
    if (effect.installationId.length < 1) {
      fail("invalid_argument", "webhook installation is invalid");
    }
    const installation = (await ctx.db
      .prepare(
        `SELECT workspace_id, status FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(effect.installationId)) as
      | { workspace_id: string; status: GitHubInstallationStatus }
      | undefined;
    if (!installation) {
      fail("unknown_installation", "github installation is not registered");
    }
    if (installation.workspace_id !== ctx.workspaceId) {
      fail("workspace_mismatch", "github installation belongs to another workspace");
    }
    const effectJson = JSON.stringify(effect);
    if (effectJson.length > GITHUB_EFFECT_JSON_LIMIT) {
      fail("webhook_payload_invalid", "webhook effect exceeds its bound");
    }
    if (installation.status === "revoked") {
      await ctx.db
        .prepare(
          `INSERT INTO github_webhook_deliveries
           (workspace_id, delivery_id, event, action, installation_id, repository_id,
            effect_json, state, received_at, processed_at, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ignored', ?, ?, 'installation_revoked')
           ON CONFLICT (workspace_id, delivery_id) DO NOTHING`,
        )
        .run(
          ctx.workspaceId, input.deliveryId, input.event, effect.action, effect.installationId,
          effect.repositoryId, effectJson, ctx.now, ctx.now,
        );
      return {
        workspace_id: ctx.workspaceId,
        delivery_id: input.deliveryId,
        outbox_id: null,
        duplicate: false,
        state: "ignored",
      };
    }
    if (installation.status === "suspended") {
      // Temporary: no state is committed so GitHub redelivery converges later.
      fail("installation_suspended", "github installation is suspended");
    }
    // Duplicate deliveries converge here: the pre-read keeps every read
    // before the queued writes, and the hub FIFO serializes same-workspace
    // receives so the conflict below only fires across racing lanes.
    const current = (await ctx.db
      .prepare(
        `SELECT state FROM github_webhook_deliveries WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .get(ctx.workspaceId, input.deliveryId)) as { state: GitHubDeliveryState } | undefined;
    if (current) {
      const outbox = (await ctx.db
        .prepare(
          `SELECT outbox_id FROM github_integration_outbox WHERE workspace_id = ? AND delivery_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(ctx.workspaceId, input.deliveryId)) as { outbox_id: string } | undefined;
      return {
        workspace_id: ctx.workspaceId,
        delivery_id: input.deliveryId,
        outbox_id: outbox?.outbox_id ?? null,
        duplicate: true,
        state: current.state,
      };
    }
    const outboxId = randomUlid();
    await ctx.db
      .prepare(
        `INSERT INTO github_webhook_deliveries
         (workspace_id, delivery_id, event, action, installation_id, repository_id,
          effect_json, state, received_at, processed_at, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, NULL, NULL)`,
      )
      .run(
        ctx.workspaceId, input.deliveryId, input.event, effect.action, effect.installationId,
        effect.repositoryId, effectJson, ctx.now,
      );
    await ctx.db
      .prepare(
        `INSERT INTO github_integration_outbox
         (workspace_id, outbox_id, delivery_id, kind, state, attempts,
          next_attempt_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, 'github.reconcile', 'pending', 0, ?, NULL, ?, ?)`,
      )
      .run(ctx.workspaceId, outboxId, input.deliveryId, ctx.now, ctx.now, ctx.now);
    return {
      workspace_id: ctx.workspaceId,
      delivery_id: input.deliveryId,
      outbox_id: outboxId,
      duplicate: false,
      state: "received",
    };
  },
};

export interface ReconcileGitHubObserved {
  repositoryFullName: string;
  defaultBranch: string;
  fetchedAt: string;
}

export interface ReconcileGitHubInput {
  outboxId: string;
  deliveryId: string;
  observed: ReconcileGitHubObserved;
}

export interface ReconcileGitHubResult {
  effect: "applied" | "superseded" | "ignored" | "already_done" | "dlq";
  reason: string;
}

function observedState(input: unknown): ReconcileGitHubObserved {
  const body = closedObject(input, ["repositoryFullName", "defaultBranch", "fetchedAt"], "reconcile observation");
  return {
    repositoryFullName: boundedText(body.repositoryFullName, "repository full name", 256, FULL_NAME_PATTERN),
    defaultBranch: boundedText(body.defaultBranch, "default branch", 256, BRANCH_PATTERN),
    fetchedAt: utcTime(body.fetchedAt, "fetched at"),
  };
}

async function finishOutbox(
  db: SqlDatabase,
  workspaceId: string,
  outboxId: string,
  outboxState: GitHubOutboxState,
  deliveryId: string,
  deliveryState: GitHubDeliveryState,
  errorCode: string | null,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE github_integration_outbox SET state = ?, updated_at = ? WHERE workspace_id = ? AND outbox_id = ?`,
    )
    .run(outboxState, now, workspaceId, outboxId);
  await db
    .prepare(
      `UPDATE github_webhook_deliveries SET state = ?, processed_at = ?, error_code = ? WHERE workspace_id = ? AND delivery_id = ?`,
    )
    .run(deliveryState, now, errorCode, workspaceId, deliveryId);
}

function evidenceKindForEvent(event: string): GitHubEvidenceKind | null {
  switch (event) {
    case "push":
      return null; // push writes both branch and commit rows below.
    case "pull_request":
      return "pull_request";
    case "check_run":
    case "check_suite":
    case "status":
      return "check";
    case "issues":
      return "issue";
    case "deployment":
    case "deployment_status":
      return "deployment";
    default:
      return null;
  }
}

/**
 * Idempotently converges one delivery to current GitHub state. Duplicate and
 * out-of-order deliveries share one domain effect through the per-repository
 * latest-wins guard; stale deliveries are marked superseded without writes.
 */
export const reconcileGitHubCommand: HubCommand<ReconcileGitHubInput, ReconcileGitHubResult> = {
  name: "github.reconcile",
  auditInput: (input) => ({ outboxId: input.outboxId, deliveryId: input.deliveryId }),
  async run(input, ctx) {
    assertSystem(ctx, GITHUB_QUEUE_SYSTEM_ID);
    closedObject(input, ["outboxId", "deliveryId", "observed"], "github reconcile");
    if (typeof input.outboxId !== "string" || !DELIVERY_ID_PATTERN.test(input.outboxId)) {
      fail("invalid_argument", "outbox id is invalid");
    }
    if (typeof input.deliveryId !== "string" || !DELIVERY_ID_PATTERN.test(input.deliveryId)) {
      fail("invalid_argument", "delivery id is invalid");
    }
    const observed = observedState(input.observed);
    const outbox = (await ctx.db
      .prepare(
        `SELECT delivery_id, state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
      )
      .get(ctx.workspaceId, input.outboxId)) as
      | { delivery_id: string; state: GitHubOutboxState; attempts: number }
      | undefined;
    if (!outbox) {
      fail("outbox_missing", "github outbox row is missing");
    }
    if (outbox.delivery_id !== input.deliveryId) {
      fail("outbox_mismatch", "github outbox row does not match its delivery");
    }
    if (outbox.state === "done" || outbox.state === "dlq") {
      return { effect: "already_done", reason: `outbox is ${outbox.state}` };
    }
    const delivery = (await ctx.db
      .prepare(
        `SELECT event, effect_json, state FROM github_webhook_deliveries WHERE workspace_id = ? AND delivery_id = ?`,
      )
      .get(ctx.workspaceId, input.deliveryId)) as
      | { event: string; effect_json: string; state: GitHubDeliveryState }
      | undefined;
    if (!delivery) {
      fail("delivery_missing", "github delivery is missing");
    }
    if (delivery.state === "applied" || delivery.state === "superseded" || delivery.state === "ignored") {
      await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, delivery.state, null, ctx.now);
      return { effect: "already_done", reason: `delivery is ${delivery.state}` };
    }
    if (outbox.attempts >= GITHUB_OUTBOX_MAX_ATTEMPTS) {
      await ctx.db
        .prepare(
          `INSERT INTO github_dlq (workspace_id, outbox_id, delivery_id, kind, error, attempts, created_at)
           VALUES (?, ?, ?, 'github.reconcile', 'attempts_exhausted', ?, ?)`,
        )
        .run(ctx.workspaceId, input.outboxId, input.deliveryId, outbox.attempts, ctx.now);
      await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "dlq", input.deliveryId, "failed", "attempts_exhausted", ctx.now);
      return { effect: "dlq", reason: "attempts exhausted" };
    }
    const effect = JSON.parse(delivery.effect_json) as GitHubDeliveryEffect;
    const installation = (await ctx.db
      .prepare(
        `SELECT status FROM github_app_installations WHERE installation_id = ?`,
      )
      .get(effect.installationId)) as { status: GitHubInstallationStatus } | undefined;
    if (!installation || installation.status === "revoked") {
      await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, "ignored", "installation_revoked", ctx.now);
      return { effect: "ignored", reason: "installation revoked" };
    }
    if (effect.event === "installation") {
      // Lifecycle events carry their own state guards (pending can activate;
      // only active can suspend), so they apply before the active check.
      return await applyInstallationEvent(ctx, input, effect);
    }
    if (installation.status === "suspended" || installation.status === "pending") {
      fail("installation_not_active", "github installation is not active");
    }
    if (effect.event === "installation_repositories") {
      // Repository mapping stays Owner-only: record the delivery, change no link.
      await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, "applied", null, ctx.now);
      return { effect: "applied", reason: "recorded without link change" };
    }
    if (!effect.repositoryId) {
      fail("delivery_missing", "github delivery names no repository");
    }
    const link = (await ctx.db
      .prepare(
        `SELECT project_id, default_branch FROM github_repository_links
         WHERE repository_id = ? AND link_state = 'active'`,
      )
      .get(effect.repositoryId)) as { project_id: string; default_branch: string } | undefined;
    if (!link) {
      await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, "ignored", "repository_unmapped", ctx.now);
      return { effect: "ignored", reason: "repository is not mapped" };
    }
    const guard = (await ctx.db
      .prepare(
        `SELECT last_event_time, last_delivery_id FROM github_reconcile_state WHERE workspace_id = ? AND repository_id = ?`,
      )
      .get(ctx.workspaceId, effect.repositoryId)) as
      | { last_event_time: string; last_delivery_id: string }
      | undefined;
    if (
      guard &&
      (guard.last_event_time > effect.occurredAt ||
        (guard.last_event_time === effect.occurredAt && guard.last_delivery_id >= input.deliveryId))
    ) {
      await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, "superseded", null, ctx.now);
      return { effect: "superseded", reason: "a newer delivery already applied" };
    }
    if (observed.defaultBranch !== link.default_branch) {
      await ctx.db
        .prepare(
          `UPDATE github_repository_links SET default_branch = ?, resource_version = resource_version + 1
           WHERE repository_id = ? AND link_state = 'active'`,
        )
        .run(observed.defaultBranch, effect.repositoryId);
    }
    if (effect.event === "push" && effect.ref && effect.version) {
      await upsertEvidence(ctx.db, ctx.workspaceId, {
        projectId: link.project_id,
        repositoryId: effect.repositoryId,
        kind: "branch",
        ref: effect.ref,
        versionToken: effect.version,
        state: { branch: effect.ref, sha: effect.version, full_name: observed.repositoryFullName },
        observedBy: "github",
        observedAt: ctx.now,
      });
      await upsertEvidence(ctx.db, ctx.workspaceId, {
        projectId: link.project_id,
        repositoryId: effect.repositoryId,
        kind: "commit",
        ref: effect.version === "deleted" ? `${effect.ref}:deleted` : effect.version,
        versionToken: effect.version,
        state: { branch: effect.ref, sha: effect.version, full_name: observed.repositoryFullName },
        observedBy: "github",
        observedAt: ctx.now,
      });
    } else {
      const kind = evidenceKindForEvent(effect.event);
      if (kind && effect.ref && effect.version) {
        await upsertEvidence(ctx.db, ctx.workspaceId, {
          projectId: link.project_id,
          repositoryId: effect.repositoryId,
          kind,
          ref: effect.ref,
          versionToken: effect.version,
          state: { action: effect.action, ...effect.detail, full_name: observed.repositoryFullName },
          observedBy: "github",
          observedAt: ctx.now,
        });
      }
    }
    await ctx.db
      .prepare(
        `INSERT INTO github_reconcile_state (workspace_id, repository_id, last_event_time, last_delivery_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, repository_id) DO UPDATE SET
           last_event_time = excluded.last_event_time,
           last_delivery_id = excluded.last_delivery_id,
           updated_at = excluded.updated_at`,
      )
      .run(ctx.workspaceId, effect.repositoryId, effect.occurredAt, input.deliveryId, ctx.now);
    await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, "applied", null, ctx.now);
    return { effect: "applied", reason: "converged to current github state" };
  },
};

async function applyInstallationEvent(
  ctx: HubContext,
  input: ReconcileGitHubInput,
  effect: GitHubDeliveryEffect,
): Promise<ReconcileGitHubResult> {
  const action = effect.action;
  if (action === "created") {
    await ctx.db
      .prepare(
        `UPDATE github_app_installations SET status = 'active', updated_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ? AND status = 'pending'`,
      )
      .run(ctx.now, effect.installationId);
  } else if (action === "deleted") {
    await ctx.db
      .prepare(
        `UPDATE github_app_installations
         SET status = 'revoked', revoked_at = ?, updated_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ? AND status != 'revoked'`,
      )
      .run(ctx.now, ctx.now, effect.installationId);
    await ctx.db
      .prepare(
        `UPDATE github_repository_links
         SET link_state = 'closed', closed_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ? AND link_state = 'active'`,
      )
      .run(ctx.now, effect.installationId);
  } else if (action === "suspend") {
    await ctx.db
      .prepare(
        `UPDATE github_app_installations SET status = 'suspended', updated_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ? AND status = 'active'`,
      )
      .run(ctx.now, effect.installationId);
  } else if (action === "unsuspend") {
    await ctx.db
      .prepare(
        `UPDATE github_app_installations SET status = 'active', updated_at = ?, resource_version = resource_version + 1
         WHERE installation_id = ? AND status = 'suspended'`,
      )
      .run(ctx.now, effect.installationId);
  }
  await finishOutbox(ctx.db, ctx.workspaceId, input.outboxId, "done", input.deliveryId, "applied", null, ctx.now);
  return { effect: "applied", reason: `installation ${action ?? "event"} applied` };
}

async function upsertEvidence(
  db: SqlDatabase,
  workspaceId: string,
  input: {
    projectId: string;
    taskId?: string | undefined;
    repositoryId: string;
    kind: GitHubEvidenceKind;
    ref: string;
    versionToken: string;
    state: Record<string, string | null>;
    observedBy: GitHubObserver;
    observedAt: string;
  },
): Promise<void> {
  const stateJson = JSON.stringify(input.state);
  if (input.ref.length > 512 || input.versionToken.length > 128 || stateJson.length > 2048) {
    fail("invalid_argument", "github evidence exceeds its bounds");
  }
  await db
    .prepare(
      `INSERT INTO github_evidence
       (workspace_id, id, project_id, task_id, repository_id, kind, ref,
        version_token, state_json, observed_by, observed_at, resource_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (workspace_id, repository_id, kind, ref, observed_by) DO UPDATE SET
         version_token = excluded.version_token,
         state_json = excluded.state_json,
         observed_at = excluded.observed_at,
         task_id = COALESCE(github_evidence.task_id, excluded.task_id),
         resource_version = github_evidence.resource_version + 1`,
    )
    .run(
      workspaceId, randomUlid(), input.projectId, input.taskId ?? null, input.repositoryId,
      input.kind, input.ref, input.versionToken, stateJson, input.observedBy, input.observedAt,
    );
}

export interface LinkGitHubEvidenceInput {
  projectId: string;
  taskId?: string | undefined;
  repositoryId: string;
  kind: GitHubEvidenceKind;
  ref: string;
  versionToken: string;
  state?: Record<string, string | null> | undefined;
  observedBy: "runner" | "human";
}

export interface GitHubEvidenceRecord {
  id: string;
  workspace_id: string;
  project_id: string;
  task_id: string | null;
  repository_id: string;
  kind: GitHubEvidenceKind;
  ref: string;
  version_token: string;
  state: Record<string, unknown>;
  observed_by: GitHubObserver;
  observed_at: string;
  resource_version: number;
}

/**
 * Links issue/branch/commit/PR/check/deployment evidence to BFB work. The
 * `github` observer is reserved for webhook reconcile; human and runner
 * callers record their own provenance, and task state is never touched.
 */
export const linkGitHubEvidenceCommand: HubCommand<LinkGitHubEvidenceInput, GitHubEvidenceRecord> = {
  name: "github.evidence.link",
  auditInput: (input) => ({ projectId: input.projectId, kind: input.kind, ref: input.ref }),
  async run(input, ctx) {
    closedObject(input, ["projectId", "taskId", "repositoryId", "kind", "ref", "versionToken", "state", "observedBy"], "github evidence link");
    if (!ctx.actorHumanId) {
      fail("unauthenticated", "human actor required");
    }
    const principal = await loadPrincipal(ctx.db, ctx.workspaceId, ctx.actorHumanId);
    assertEpoch(principal, ctx.authorizationEpoch);
    assertRole(principal, ["owner", "member"]);
    if (!isUlid(input.projectId)) {
      fail("invalid_argument", "project id is invalid");
    }
    assertProjectAccess(principal, input.projectId);
    let taskId: string | null = null;
    if (input.taskId !== undefined) {
      if (!isUlid(input.taskId)) {
        fail("invalid_argument", "task id is invalid");
      }
      const task = (await ctx.db
        .prepare(`SELECT project_id FROM tasks WHERE workspace_id = ? AND id = ?`)
        .get(ctx.workspaceId, input.taskId)) as { project_id: string } | undefined;
      if (!task) {
        fail("not_found", "task not found");
      }
      if (task.project_id !== input.projectId) {
        fail("invalid_argument", "task does not belong to the project");
      }
      taskId = input.taskId;
    }
    const repositoryId = numericId(input.repositoryId, "repository id");
    if (!["issue", "branch", "commit", "pull_request", "check", "deployment"].includes(input.kind)) {
      fail("invalid_argument", "evidence kind is invalid");
    }
    const ref = boundedText(input.ref, "evidence ref", 512);
    const versionToken = boundedText(input.versionToken, "evidence version", 128);
    if (input.observedBy !== "runner" && input.observedBy !== "human") {
      fail("invalid_argument", "evidence observer is invalid");
    }
    const state = input.state === undefined ? {} : closedObject(input.state, Object.keys(input.state), "evidence state");
    for (const [key, value] of Object.entries(state)) {
      if (value !== null && typeof value !== "string") {
        fail("invalid_argument", `evidence state ${key} is invalid`);
      }
      if (typeof value === "string" && (value.length > 512 || [...value].some((c) => {
        const code = c.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      }))) {
        fail("invalid_argument", `evidence state ${key} is invalid`);
      }
    }
    // Read-first upsert: D1 batches forbid reads after a queued write.
    const prior = (await ctx.db
      .prepare(
        `SELECT id, task_id, resource_version FROM github_evidence
         WHERE workspace_id = ? AND repository_id = ? AND kind = ? AND ref = ? AND observed_by = ?`,
      )
      .get(ctx.workspaceId, repositoryId, input.kind, ref, input.observedBy)) as {
      id: string;
      task_id: string | null;
      resource_version: number;
    } | undefined;
    const stateJson = JSON.stringify(state);
    if (ref.length > 512 || versionToken.length > 128 || stateJson.length > 2048) {
      fail("invalid_argument", "github evidence exceeds its bounds");
    }
    if (!prior) {
      const id = randomUlid();
      await ctx.db
        .prepare(
          `INSERT INTO github_evidence
           (workspace_id, id, project_id, task_id, repository_id, kind, ref,
            version_token, state_json, observed_by, observed_at, resource_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          ctx.workspaceId, id, input.projectId, taskId, repositoryId, input.kind, ref,
          versionToken, stateJson, input.observedBy, ctx.now,
        );
      return {
        id,
        workspace_id: ctx.workspaceId,
        project_id: input.projectId,
        task_id: taskId,
        repository_id: repositoryId,
        kind: input.kind,
        ref,
        version_token: versionToken,
        state: state as Record<string, unknown>,
        observed_by: input.observedBy,
        observed_at: ctx.now,
        resource_version: 1,
      };
    }
    await ctx.db
      .prepare(
        `UPDATE github_evidence
         SET version_token = ?, state_json = ?, observed_at = ?,
             task_id = COALESCE(task_id, ?), resource_version = resource_version + 1
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(versionToken, stateJson, ctx.now, taskId, ctx.workspaceId, prior.id);
    return {
      id: prior.id,
      workspace_id: ctx.workspaceId,
      project_id: input.projectId,
      task_id: prior.task_id ?? taskId,
      repository_id: repositoryId,
      kind: input.kind,
      ref,
      version_token: versionToken,
      state: state as Record<string, unknown>,
      observed_by: input.observedBy,
      observed_at: ctx.now,
      resource_version: prior.resource_version + 1,
    };
  },
};

function knownPayloadKeys(event: string): readonly string[] {
  switch (event) {
    case "installation":
      return ["action", "installation", "sender"];
    case "installation_repositories":
      return ["action", "installation", "repositories_added", "repositories_removed", "sender"];
    case "push":
      return ["ref", "head_commit", "repository", "installation", "sender"];
    case "pull_request":
      return ["action", "pull_request", "repository", "installation", "sender"];
    case "check_run":
      return ["action", "check_run", "repository", "installation", "sender"];
    case "check_suite":
      return ["action", "check_suite", "repository", "installation", "sender"];
    case "status":
      return ["state", "sha", "context", "name", "updated_at", "repository", "installation", "sender"];
    case "issues":
      return ["action", "issue", "repository", "installation", "sender"];
    case "deployment":
      return ["deployment", "repository", "installation", "sender"];
    case "deployment_status":
      return ["deployment_status", "deployment", "repository", "installation", "sender"];
    default:
      return [];
  }
}

export interface GitHubStatusView {
  installations: Array<{
    installation_id: string;
    app_slug: string;
    account_login: string;
    status: GitHubInstallationStatus;
    permissions: Record<string, string>;
    events: string[];
    resource_version: number;
  }>;
  links: GitHubRepositoryLinkSummary[];
}

/** Workspace-scoped installation and link status for Owner/member reads. */
export async function getGitHubStatus(db: SqlDatabase, workspaceId: string): Promise<GitHubStatusView> {
  const installations = (await db
    .prepare(
      `SELECT installation_id, app_slug, account_login, status, permissions_json, events_json, resource_version
       FROM github_app_installations WHERE workspace_id = ? ORDER BY installation_id`,
    )
    .all(workspaceId)) as Array<{
    installation_id: string;
    app_slug: string;
    account_login: string;
    status: GitHubInstallationStatus;
    permissions_json: string;
    events_json: string;
    resource_version: number;
  }>;
  const links = (await db
    .prepare(
      `SELECT id, repository_id, installation_id, project_id, full_name, default_branch,
              link_state, resource_version
       FROM github_repository_links WHERE workspace_id = ? AND link_state = 'active' ORDER BY repository_id`,
    )
    .all(workspaceId)) as Array<{
    id: string;
    repository_id: string;
    installation_id: string;
    project_id: string;
    full_name: string;
    default_branch: string;
    link_state: "active" | "closed";
    resource_version: number;
  }>;
  return {
    installations: installations.map((row) => ({
      installation_id: row.installation_id,
      app_slug: row.app_slug,
      account_login: row.account_login,
      status: row.status,
      permissions: JSON.parse(row.permissions_json) as Record<string, string>,
      events: JSON.parse(row.events_json) as string[],
      resource_version: row.resource_version,
    })),
    links: links.map((row) => ({
      link_id: row.id,
      workspace_id: workspaceId,
      repository_id: row.repository_id,
      installation_id: row.installation_id,
      project_id: row.project_id,
      full_name: row.full_name,
      default_branch: row.default_branch,
      link_state: row.link_state,
      resource_version: row.resource_version,
    })),
  };
}

export interface ListGitHubEvidenceFilter {
  projectId?: string | undefined;
  taskId?: string | undefined;
  repositoryId?: string | undefined;
  limit?: number | undefined;
}

/** Newest-first linked evidence. Runner and GitHub observations stay separate rows. */
export async function listGitHubEvidence(
  db: SqlDatabase,
  workspaceId: string,
  filter: ListGitHubEvidenceFilter = {},
): Promise<GitHubEvidenceRecord[]> {
  const limit = filter.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail("invalid_argument", "evidence limit is invalid");
  }
  const clauses = ["workspace_id = ?"];
  const params: unknown[] = [workspaceId];
  if (filter.projectId !== undefined) {
    if (!isUlid(filter.projectId)) {
      fail("invalid_argument", "project id is invalid");
    }
    clauses.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.taskId !== undefined) {
    if (!isUlid(filter.taskId)) {
      fail("invalid_argument", "task id is invalid");
    }
    clauses.push("task_id = ?");
    params.push(filter.taskId);
  }
  if (filter.repositoryId !== undefined) {
    numericId(filter.repositoryId, "repository id");
    clauses.push("repository_id = ?");
    params.push(filter.repositoryId);
  }
  const rows = (await db
    .prepare(
      `SELECT id, project_id, task_id, repository_id, kind, ref, version_token,
              state_json, observed_by, observed_at, resource_version
       FROM github_evidence WHERE ${clauses.join(" AND ")}
       ORDER BY observed_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit)) as Array<{
    id: string;
    project_id: string;
    task_id: string | null;
    repository_id: string;
    kind: GitHubEvidenceKind;
    ref: string;
    version_token: string;
    state_json: string;
    observed_by: GitHubObserver;
    observed_at: string;
    resource_version: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    workspace_id: workspaceId,
    project_id: row.project_id,
    task_id: row.task_id,
    repository_id: row.repository_id,
    kind: row.kind,
    ref: row.ref,
    version_token: row.version_token,
    state: JSON.parse(row.state_json) as Record<string, unknown>,
    observed_by: row.observed_by,
    observed_at: row.observed_at,
    resource_version: row.resource_version,
  }));
}

export interface EvidenceRefInput {
  kind: string;
  ref: string;
  version?: string | undefined;
}

export interface EvidenceVerification {
  kind: string;
  ref: string;
  provenance: "github_verified" | "runner_observed" | "unverified" | "opaque";
}

function parseGitHubRef(ref: string): { repositoryId: string; kind: string; name: string } | null {
  const match = /^github:([0-9]{1,20}):([a-z_]{1,32}):(.{1,512})$/.exec(ref);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return { repositoryId: match[1], kind: match[2], name: match[3] };
}

/**
 * Resolves A03-style generic evidence refs against GitHub observations.
 * A runner claim is never upgraded to GitHub verification without a matching
 * github-observed row; unknown kinds stay opaque per the results contract.
 */
export async function getEvidenceVerificationStatus(
  db: SqlDatabase,
  workspaceId: string,
  refs: EvidenceRefInput[],
): Promise<EvidenceVerification[]> {
  if (!Array.isArray(refs) || refs.length > 20) {
    fail("invalid_argument", "evidence refs must be a bounded list");
  }
  const out: EvidenceVerification[] = [];
  for (const item of refs) {
    if (!item || typeof item.kind !== "string" || typeof item.ref !== "string") {
      fail("invalid_argument", "evidence ref is invalid");
    }
    if (item.kind !== "github") {
      out.push({ kind: item.kind, ref: item.ref, provenance: "opaque" });
      continue;
    }
    const parsed = parseGitHubRef(item.ref);
    if (!parsed) {
      out.push({ kind: item.kind, ref: item.ref, provenance: "unverified" });
      continue;
    }
    const rows = (await db
      .prepare(
        `SELECT observed_by, version_token FROM github_evidence
         WHERE workspace_id = ? AND repository_id = ? AND kind = ? AND ref = ?`,
      )
      .all(workspaceId, parsed.repositoryId, parsed.kind, parsed.name)) as Array<{
      observed_by: GitHubObserver;
      version_token: string;
    }>;
    const verified = rows.some(
      (row) =>
        row.observed_by === "github" && (item.version === undefined || row.version_token === item.version),
    );
    if (verified) {
      out.push({ kind: item.kind, ref: item.ref, provenance: "github_verified" });
    } else if (rows.some((row) => row.observed_by === "runner")) {
      out.push({ kind: item.kind, ref: item.ref, provenance: "runner_observed" });
    } else {
      out.push({ kind: item.kind, ref: item.ref, provenance: "unverified" });
    }
  }
  return out;
}

/**
 * Typed Queue envelope. Messages carry bounded IDs only: never a token, a
 * private key, a payload body, or any other secret.
 */
export interface GitHubQueueMessage {
  schema_version: 1;
  kind: "github.outbox.dispatch";
  workspace_id: string;
  outbox_id: string;
  delivery_id: string;
  attempt: number;
}

export function githubQueueMessage(input: {
  workspaceId: string;
  outboxId: string;
  deliveryId: string;
  attempt: number;
}): GitHubQueueMessage {
  if (!isUlid(input.workspaceId)) {
    fail("invalid_argument", "queue workspace is invalid");
  }
  if (!DELIVERY_ID_PATTERN.test(input.outboxId) || !DELIVERY_ID_PATTERN.test(input.deliveryId)) {
    fail("invalid_argument", "queue ids are invalid");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) {
    fail("invalid_argument", "queue attempt is invalid");
  }
  return {
    schema_version: 1,
    kind: "github.outbox.dispatch",
    workspace_id: input.workspaceId,
    outbox_id: input.outboxId,
    delivery_id: input.deliveryId,
    attempt: input.attempt,
  };
}

/** Parses one Queue body; anything else is a poison envelope. */
export function parseGitHubQueueMessage(body: unknown): GitHubQueueMessage {
  const envelope = closedObject(body, ["schema_version", "kind", "workspace_id", "outbox_id", "delivery_id", "attempt"], "queue message");
  if (envelope.schema_version !== 1 || envelope.kind !== "github.outbox.dispatch") {
    fail("queue_message_poison", "queue message envelope is unknown");
  }
  return githubQueueMessage({
    workspaceId: envelope.workspace_id as string,
    outboxId: envelope.outbox_id as string,
    deliveryId: envelope.delivery_id as string,
    attempt: envelope.attempt as number,
  });
}

export function githubOutboxBackoffSeconds(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    fail("invalid_argument", "outbox attempts are invalid");
  }
  return Math.min(60 * 2 ** Math.min(attempts, 5), 1800);
}

function outboxMessage(row: {
  workspace_id: string;
  outbox_id: string;
  delivery_id: string;
  attempts: number;
}): GitHubQueueMessage {
  return githubQueueMessage({
    workspaceId: row.workspace_id,
    outboxId: row.outbox_id,
    deliveryId: row.delivery_id,
    attempt: row.attempts,
  });
}

/**
 * Claims due `pending` rows (missed enqueue after a D1 commit, including the
 * commit-before-enqueue crash gap) for Queue dispatch. Each claim moves
 * pending to dispatched with a bounded attempt increment.
 */
export async function claimGitHubOutboxBatch(
  db: SqlDatabase,
  now: string,
  limit: number = GITHUB_OUTBOX_CRON_LIMIT,
): Promise<GitHubQueueMessage[]> {
  utcTime(now, "claim time");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GITHUB_OUTBOX_CRON_LIMIT) {
    fail("invalid_argument", "claim limit is invalid");
  }
  const due = (await db
    .prepare(
      `SELECT workspace_id, outbox_id, delivery_id, attempts FROM github_integration_outbox
       WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?`,
    )
    .all(now, limit)) as Array<{
    workspace_id: string;
    outbox_id: string;
    delivery_id: string;
    attempts: number;
  }>;
  const claimed: GitHubQueueMessage[] = [];
  for (const row of due) {
    const backoff = githubOutboxBackoffSeconds(row.attempts + 1);
    const next = new Date(Date.parse(now) + backoff * 1000).toISOString();
    // The conditional UPDATE is the atomic claim: concurrent Cron ticks race
    // here and exactly one of them matches the still-pending row.
    const claimedRow = await db
      .prepare(
        `UPDATE github_integration_outbox
         SET state = 'dispatched', attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
         WHERE workspace_id = ? AND outbox_id = ? AND state = 'pending'
         RETURNING workspace_id, outbox_id, delivery_id, attempts`,
      )
      .get(next, now, row.workspace_id, row.outbox_id) as {
      workspace_id: string;
      outbox_id: string;
      delivery_id: string;
      attempts: number;
    } | undefined;
    if (claimedRow) {
      claimed.push(outboxMessage(claimedRow));
    }
  }
  return claimed;
}

/**
 * Reclaims `dispatched` rows whose consumer never finished (lost Queue
 * message or crashed consumer). Rows that exhaust attempts move to visible
 * DLQ state instead of retrying forever.
 */
export async function reclaimStaleGitHubOutbox(
  db: SqlDatabase,
  now: string,
  limit: number = GITHUB_OUTBOX_CRON_LIMIT,
): Promise<GitHubQueueMessage[]> {
  utcTime(now, "reclaim time");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GITHUB_OUTBOX_CRON_LIMIT) {
    fail("invalid_argument", "reclaim limit is invalid");
  }
  const cutoff = new Date(Date.parse(now) - GITHUB_OUTBOX_STALE_SECONDS * 1000).toISOString();
  const stale = (await db
    .prepare(
      `SELECT workspace_id, outbox_id, delivery_id, attempts FROM github_integration_outbox
       WHERE state = 'dispatched' AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(cutoff, limit)) as Array<{
    workspace_id: string;
    outbox_id: string;
    delivery_id: string;
    attempts: number;
  }>;
  const redriven: GitHubQueueMessage[] = [];
  for (const row of stale) {
    if (row.attempts >= GITHUB_OUTBOX_MAX_ATTEMPTS) {
      await writeGitHubDlqRow(db, row.workspace_id, row.outbox_id, row.delivery_id, "stale_attempts_exhausted", row.attempts, now);
      continue;
    }
    const backoff = githubOutboxBackoffSeconds(row.attempts + 1);
    const next = new Date(Date.parse(now) + backoff * 1000).toISOString();
    await db
      .prepare(
        `UPDATE github_integration_outbox
         SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
         WHERE workspace_id = ? AND outbox_id = ? AND state = 'dispatched'`,
      )
      .run(next, now, row.workspace_id, row.outbox_id);
    redriven.push(outboxMessage({ ...row, attempts: row.attempts + 1 }));
  }
  return redriven;
}

/** Records visible DLQ state and parks the delivery as failed. */
export async function writeGitHubDlqRow(
  db: SqlDatabase,
  workspaceId: string,
  outboxId: string,
  deliveryId: string,
  error: string,
  attempts: number,
  now: string,
): Promise<void> {
  if (typeof error !== "string" || error.length < 1 || error.length > 512) {
    fail("invalid_argument", "dlq error is invalid");
  }
  await db
    .prepare(
      `INSERT INTO github_dlq (workspace_id, outbox_id, delivery_id, kind, error, attempts, created_at)
       VALUES (?, ?, ?, 'github.reconcile', ?, ?, ?)
       ON CONFLICT (workspace_id, outbox_id) DO NOTHING`,
    )
    .run(workspaceId, outboxId, deliveryId, error, attempts, now);
  await db
    .prepare(
      `UPDATE github_integration_outbox SET state = 'dlq', last_error = ?, updated_at = ?
       WHERE workspace_id = ? AND outbox_id = ?`,
    )
    .run(error, now, workspaceId, outboxId);
  await db
    .prepare(
      `UPDATE github_webhook_deliveries SET state = 'failed', processed_at = ?, error_code = 'dlq'
       WHERE workspace_id = ? AND delivery_id = ? AND state IN ('received', 'queued')`,
    )
    .run(now, workspaceId, deliveryId);
}

/** Consumer bookkeeping: one more processing attempt with backoff. */
export async function noteGitHubOutboxAttempt(
  db: SqlDatabase,
  workspaceId: string,
  outboxId: string,
  error: string,
  now: string,
): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT attempts, state FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
    )
    .get(workspaceId, outboxId)) as { attempts: number; state: GitHubOutboxState } | undefined;
  if (!row || row.state === "done" || row.state === "dlq") {
    return -1;
  }
  const backoff = githubOutboxBackoffSeconds(row.attempts + 1);
  const next = new Date(Date.parse(now) + backoff * 1000).toISOString();
  await db
    .prepare(
      `UPDATE github_integration_outbox
       SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, updated_at = ?
       WHERE workspace_id = ? AND outbox_id = ? AND state != 'done' AND state != 'dlq'`,
    )
    .run(next, error.slice(0, 512), now, workspaceId, outboxId);
  return row.attempts + 1;
}
