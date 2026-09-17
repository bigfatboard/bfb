// ABOUTME: Serves GitHub App webhook ingest, Owner management, and Queue reconcile.
// ABOUTME: HMAC is verified before parsing; tokens stay in memory and never reach D1, queues, or logs.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  assertProjectAccess,
  assertRole,
  claimGitHubOutboxBatch,
  consumeAbuseBudget,
  DomainError,
  extractWebhookEffect,
  getEvidenceVerificationStatus,
  getGitHubStatus,
  githubOutboxBackoffSeconds,
  GITHUB_OUTBOX_MAX_ATTEMPTS,
  GITHUB_QUEUE_SYSTEM_ID,
  GITHUB_WEBHOOK_BODY_LIMIT,
  GITHUB_WEBHOOK_SYSTEM_ID,
  githubQueueMessage,
  installGitHubCommand,
  linkGitHubEvidenceCommand,
  listGitHubEvidence,
  loadPrincipal,
  mapGitHubRepositoryCommand,
  markGitHubInstallationRevoked,
  noteGitHubOutboxAttempt,
  parseGitHubQueueMessage,
  receiveGitHubWebhookCommand,
  reclaimStaleGitHubOutbox,
  reconcileGitHubCommand,
  removeGitHubCommand,
  updateGitHubPermissionsCommand,
  verifyGitHubWebhookSignature,
  workspaceHub,
  writeGitHubDlqRow,
  type CommandRequest,
  type GitHubDeliveryEffect,
  type GitHubQueueMessage,
  type HubCommand,
  type LinkGitHubEvidenceInput,
  type ReconcileGitHubObserved,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedBytes, readBoundedJson } from "./request.js";

export interface GitHubApiDeps {
  db: SqlDatabase;
  now: string;
  jurisdiction: Jurisdiction;
  appOrigin: string;
  abuseSecret: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
  jobs?: Queue | undefined;
  githubWebhookSecret?: string | undefined;
  githubApiBase?: string | undefined;
  githubAppId?: string | undefined;
  githubAppPrivateKey?: string | undefined;
}

export interface GitHubBrowserDeps extends GitHubApiDeps {
  principal: BrowserPrincipal;
  workspaceId: string;
}

const WEBHOOK_POLICY = {
  attemptLimit: 120,
  pollLimit: 120,
  windowSeconds: 60,
  maxBodyBytes: GITHUB_WEBHOOK_BODY_LIMIT,
} as const;

const APPROVAL_POLICY = {
  attemptLimit: 20,
  pollLimit: 60,
  windowSeconds: 60,
  maxBodyBytes: 32_768,
} as const;

const BODY_LIMIT = 32_768;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    },
  });
}

function rejected(): Response {
  return json({ error: "request_rejected", message: "request rejected" }, 403);
}

function failure(error: unknown): Response {
  if (error instanceof DomainError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden" || error.code === "unauthenticated"
          ? 403
          : error.code.startsWith("step_up_")
            ? 403
            : error.code === "body_too_large"
              ? 413
              : error.code === "invalid_argument" || error.code === "invalid_json"
                ? 400
                : 409;
    return json({ error: error.code, message: error.message }, status);
  }
  return json({ error: "request_failed", message: "request failed" }, 500);
}

async function budget(
  request: Request,
  deps: GitHubApiDeps,
  subject: string,
  surface: string,
  policy: typeof WEBHOOK_POLICY | typeof APPROVAL_POLICY,
): Promise<void> {
  if (typeof deps.abuseSecret !== "string" || deps.abuseSecret.length < 32) {
    throw new DomainError("request_rejected", "request rejected");
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const expiresAt = new Date(Date.parse(deps.now) + policy.windowSeconds * 1000).toISOString();
  for (const [bucketSubject, seed] of [
    ["all", createHmac("sha256", deps.abuseSecret).update(`github-ip:${ip}`).digest("hex")],
    [subject, createHmac("sha256", deps.abuseSecret).update("github-subject").digest("hex")],
  ] as const) {
    const decision = await consumeAbuseBudget(
      deps.db,
      {
        bucketKey: abuseBucketKey({
          ipHashSeed: seed,
          subject: bucketSubject,
          surface: `github:${surface}`,
        }),
        activity: "attempt",
        bodyBytes: 0,
        now: deps.now,
        expiresAt,
      },
      policy,
    );
    if (!decision.allowed) {
      throw new DomainError("request_rejected", "request rejected");
    }
  }
}

function isHubNamespace(value: unknown): value is DurableObjectNamespace {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as DurableObjectNamespace).idFromName === "function" &&
    typeof (value as DurableObjectNamespace).get === "function"
  );
}

/** System-lane dispatch shared by the webhook route, the Queue consumer, and Cron. */
export async function executeGitHubSystemCommand<TInput, TResult>(
  deps: GitHubApiDeps,
  workspaceId: string,
  command: HubCommand<TInput, TResult>,
  input: TInput,
  systemId: string,
  idempotencyKey: string,
): Promise<{ ok: true; result: TResult; replayed: boolean } | { ok: false; error: { code: string; message: string } }> {
  const request: CommandRequest<TInput> = {
    workspaceId,
    idempotencyKey,
    authorizationEpoch: 1,
    actorSystemId: systemId,
    now: deps.now,
    input,
  };
  if (isHubNamespace(deps.workspaceHubNs)) {
    try {
      const stub = deps.workspaceHubNs.get(deps.workspaceHubNs.idFromName(workspaceId));
      const response = await stub.fetch("https://bfb-hub.internal/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandName: command.name, request }),
      });
      const body = (await response.json()) as
        | { ok: true; result: TResult; replayed: boolean }
        | { ok: false; error: { code: string; message: string } };
      if (!response.ok) {
        return { ok: false, error: { code: "hub_rpc_failed", message: `hub DO returned ${response.status}` } };
      }
      return body;
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "hub_rpc_failed",
          message: error instanceof Error ? error.message : "hub DO call failed",
        },
      };
    }
  }
  return workspaceHub(deps.db, workspaceId).execute(command, request);
}

function webhookSecret(deps: GitHubApiDeps): string {
  if (!deps.githubWebhookSecret) {
    throw new DomainError("github_not_configured", "github webhook secret is not configured");
  }
  return deps.githubWebhookSecret;
}

async function resolveWorkspaceForInstallation(
  deps: GitHubApiDeps,
  installationId: string,
): Promise<string | null> {
  const row = (await deps.db
    .prepare(`SELECT workspace_id FROM github_app_installations WHERE installation_id = ?`)
    .get(installationId)) as { workspace_id: string } | undefined;
  return row?.workspace_id ?? null;
}

/** POST /webhooks/github: HMAC verified over raw bytes before any parsing. */
export async function handleGitHubWebhook(
  request: Request,
  deps: GitHubApiDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }
  try {
    await budget(request, deps, "webhook", "webhook", WEBHOOK_POLICY);
    const raw = await readBoundedBytes(request, GITHUB_WEBHOOK_BODY_LIMIT);
    verifyGitHubWebhookSignature(
      webhookSecret(deps),
      raw,
      request.headers.get("x-hub-signature-256"),
    );
    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? "";
    if (!event || event.length > 64) {
      return json({ error: "webhook_event_invalid", message: "webhook event is invalid" }, 400);
    }
    if (!/^[A-Za-z0-9._:~-]{8,128}$/.test(deliveryId)) {
      return json({ error: "webhook_delivery_invalid", message: "webhook delivery is invalid" }, 400);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
    } catch {
      return json({ error: "invalid_json", message: "webhook body is not valid JSON" }, 400);
    }
    let extracted: { supported: boolean; effect?: GitHubDeliveryEffect };
    try {
      extracted = extractWebhookEffect(event, payload, deps.now);
    } catch (error) {
      if (error instanceof DomainError) {
        return json({ error: error.code, message: error.message }, 400);
      }
      throw error;
    }
    if (!extracted.supported || !extracted.effect) {
      // Unsubscribed event: acknowledged without state so GitHub stops retrying.
      return json({ received: true, ignored: "event_not_subscribed" }, 202);
    }
    const effect = extracted.effect;
    await budget(request, deps, `installation:${effect.installationId}`, "webhook", WEBHOOK_POLICY);
    const workspaceId = await resolveWorkspaceForInstallation(deps, effect.installationId);
    if (!workspaceId) {
      return json({ error: "unknown_installation", message: "github installation is not registered" }, 404);
    }
    const outcome = await executeGitHubSystemCommand(
      deps,
      workspaceId,
      receiveGitHubWebhookCommand,
      { deliveryId, event, supported: true, effect },
      GITHUB_WEBHOOK_SYSTEM_ID,
      `github-delivery.${deliveryId}`,
    );
    if (!outcome.ok) {
      if (outcome.error.code === "installation_suspended") {
        // Temporary: no state committed, GitHub redelivery converges later.
        return json({ error: outcome.error.code, message: outcome.error.message }, 503);
      }
      if (
        outcome.error.code === "command_failed" ||
        outcome.error.code === "hub_execute_failed" ||
        outcome.error.code === "hub_rpc_failed"
      ) {
        // A racing lane may have committed first: converge to its duplicate.
        const current = (await deps.db
          .prepare(
            `SELECT state FROM github_webhook_deliveries WHERE workspace_id = ? AND delivery_id = ?`,
          )
          .get(workspaceId, deliveryId)) as { state: string } | undefined;
        if (current) {
          return json({ received: true, duplicate: true, state: current.state }, 202);
        }
      }
      const status =
        outcome.error.code === "unknown_installation"
          ? 404
          : outcome.error.code === "workspace_mismatch" ||
              outcome.error.code === "webhook_payload_invalid" ||
              outcome.error.code === "invalid_argument"
            ? 400
            : 500;
      return json({ error: outcome.error.code, message: outcome.error.message }, status);
    }
    if (outcome.result.state === "ignored" || outcome.result.outbox_id === null) {
      return json({ received: true, ignored: true, state: outcome.result.state }, 202);
    }
    if (!deps.jobs) {
      return json({ error: "github_not_configured", message: "github queue is not configured" }, 500);
    }
    const message = githubQueueMessage({
      workspaceId,
      outboxId: outcome.result.outbox_id,
      deliveryId,
      attempt: 0,
    });
    try {
      await deps.jobs.send(message, { contentType: "json" });
    } catch {
      // D1 committed; the send failed. Cron recovery re-enqueues the pending
      // outbox row and GitHub redelivery converges on the duplicate path.
      return json({ error: "github_enqueue_failed", message: "delivery committed, enqueue failed" }, 500);
    }
    return json(
      { received: true, duplicate: outcome.result.duplicate, outbox_id: outcome.result.outbox_id },
      202,
    );
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === "request_rejected") {
        return rejected();
      }
      if (error.code === "webhook_signature_invalid") {
        return json({ error: error.code, message: "webhook signature is invalid" }, 401);
      }
      if (error.code === "body_too_large") {
        return json({ error: error.code, message: error.message }, 413);
      }
      if (error.code === "github_not_configured") {
        return json({ error: error.code, message: error.message }, 503);
      }
      return failure(error);
    }
    return json({ error: "request_failed", message: "request failed" }, 500);
  }
}

function objectBody(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("invalid_argument", "request body must be an object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new DomainError("invalid_argument", "request body contains an unsupported field");
  }
  return body;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value) {
    throw new DomainError("invalid_argument", `${key} is required`);
  }
  return value;
}

function requestId(body: Record<string, unknown>): string {
  const value = requiredString(body, "request_id");
  if (value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:~-]+$/.test(value)) {
    throw new DomainError("invalid_argument", "request_id is invalid");
  }
  return value;
}

async function mutate<TInput, TResult>(
  deps: GitHubBrowserDeps,
  principal: { humanId: string; authorizationEpoch: number },
  command: HubCommand<TInput, TResult>,
  key: string,
  input: TInput,
): Promise<Response> {
  const outcome = await executeWorkspaceCommand(
    {
      db: deps.db,
      workspaceHubNs: deps.workspaceHubNs,
      authorization: createAuthorizationContext({
        workspaceId: deps.workspaceId,
        principalId: principal.humanId,
        authorizationEpoch: principal.authorizationEpoch,
        jurisdiction: deps.jurisdiction,
      }),
    },
    command,
    {
      workspaceId: deps.workspaceId,
      idempotencyKey: key,
      actorHumanId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      now: deps.now,
      input,
    },
  );
  if (!outcome.ok) {
    return failure(new DomainError(outcome.error.code, outcome.error.message));
  }
  return json({ ok: true, result: outcome.result, replayed: outcome.replayed });
}

/**
 * Browser management and reads under /api/v1/workspaces/:ws/github.
 * Mutations are Owner-only inside the domain commands with fresh step-up.
 */
export async function handleGitHubBrowserApi(
  request: Request,
  deps: GitHubBrowserDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const workspaceId = deps.workspaceId;
    const prefix = `/api/v1/workspaces/${workspaceId}/github`;
    if (!url.pathname.startsWith(prefix)) {
      return json({ error: "not_found" }, 404);
    }
    const principal = await loadPrincipal(deps.db, workspaceId, deps.principal.humanId);
    const tail = url.pathname.slice(prefix.length);
    if (request.method === "GET" && (tail === "/status" || tail === "/status/")) {
      assertRole(principal, ["owner", "member"]);
      return json({ ok: true, ...(await getGitHubStatus(deps.db, workspaceId)) });
    }
    if (request.method === "GET" && tail.startsWith("/evidence")) {
      const projectId = url.searchParams.get("project_id") ?? undefined;
      const taskId = url.searchParams.get("task_id") ?? undefined;
      const repositoryId = url.searchParams.get("repository_id") ?? undefined;
      const limitRaw = url.searchParams.get("limit");
      if (principal.role === "reviewer" && !projectId) {
        return json({ error: "forbidden", message: "reviewers read evidence per project" }, 403);
      }
      assertRole(principal, ["owner", "member", "reviewer"]);
      if (projectId) {
        assertProjectAccess(principal, projectId);
      }
      const evidence = await listGitHubEvidence(deps.db, workspaceId, {
        ...(projectId === undefined ? {} : { projectId }),
        ...(taskId === undefined ? {} : { taskId }),
        ...(repositoryId === undefined ? {} : { repositoryId }),
        ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
      });
      return json({ ok: true, evidence });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    await budget(request, deps, `${workspaceId}:${principal.humanId}`, "approval", APPROVAL_POLICY);
    const body = objectBody(await readBoundedJson(request, BODY_LIMIT), [
      "request_id",
      "installation_id",
      "app_id",
      "app_slug",
      "account_id",
      "account_login",
      "account_type",
      "permissions",
      "events",
      "expected_version",
      "repository_id",
      "project_id",
      "full_name",
      "default_branch",
      "task_id",
      "kind",
      "ref",
      "version_token",
      "state",
      "observed_by",
      "refs",
      "step_up_proof_id",
    ]);
    if (tail === "/evidence/verification") {
      if (!Array.isArray(body.refs)) {
        throw new DomainError("invalid_argument", "refs must be an array");
      }
      assertRole(principal, ["owner", "member", "reviewer"]);
      const statuses = await getEvidenceVerificationStatus(
        deps.db,
        workspaceId,
        body.refs as Array<{ kind: string; ref: string; version?: string }>,
      );
      return json({ ok: true, statuses });
    }
    const key = `github.${requestId(body)}`;
    // Only the four installation management actions consume a step-up proof;
    // evidence reads and runner/human-observed links are role-gated.
    const proof = () => requiredString(body, "step_up_proof_id");
    if (tail === "/installations") {
      return mutate(deps, principal, installGitHubCommand, key, {
        installationId: requiredString(body, "installation_id"),
        appId: requiredString(body, "app_id"),
        appSlug: requiredString(body, "app_slug"),
        accountId: requiredString(body, "account_id"),
        accountLogin: requiredString(body, "account_login"),
        accountType: requiredString(body, "account_type"),
        permissions: body.permissions,
        events: body.events,
        stepUpProofId: proof(),
      });
    }
    const remove = /^\/installations\/([^/]+)\/remove\/?$/.exec(tail);
    if (remove?.[1]) {
      return mutate(deps, principal, removeGitHubCommand, key, {
        installationId: decodeURIComponent(remove[1]),
        stepUpProofId: proof(),
      });
    }
    const permissions = /^\/installations\/([^/]+)\/permissions\/?$/.exec(tail);
    if (permissions?.[1]) {
      const expected = body.expected_version;
      if (!Number.isSafeInteger(expected) || Number(expected) < 1) {
        throw new DomainError("invalid_argument", "expected_version is required");
      }
      return mutate(deps, principal, updateGitHubPermissionsCommand, key, {
        installationId: decodeURIComponent(permissions[1]),
        expectedVersion: Number(expected),
        permissions: body.permissions,
        events: body.events,
        stepUpProofId: proof(),
      });
    }
    if (tail === "/repository-links") {
      return mutate(deps, principal, mapGitHubRepositoryCommand, key, {
        installationId: requiredString(body, "installation_id"),
        repositoryId: requiredString(body, "repository_id"),
        projectId: requiredString(body, "project_id"),
        fullName: requiredString(body, "full_name"),
        defaultBranch: requiredString(body, "default_branch"),
        stepUpProofId: proof(),
      });
    }
    if (tail === "/evidence/links") {
      const state = body.state === undefined ? undefined : (body.state as Record<string, string | null>);
      return mutate(deps, principal, linkGitHubEvidenceCommand, key, {
        projectId: requiredString(body, "project_id"),
        ...(body.task_id === undefined ? {} : { taskId: body.task_id as string }),
        repositoryId: requiredString(body, "repository_id"),
        kind: requiredString(body, "kind") as LinkGitHubEvidenceInput["kind"],
        ref: requiredString(body, "ref"),
        versionToken: requiredString(body, "version_token"),
        ...(state === undefined ? {} : { state }),
        observedBy: requiredString(body, "observed_by") as LinkGitHubEvidenceInput["observedBy"],
      });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return failure(error);
  }
}

/** Short-lived installation token plus its absolute expiry. In memory only. */
export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
}

export interface GitHubRestClient {
  mintInstallationToken(installationId: string): Promise<GitHubInstallationToken>;
  fetchRepository(
    token: string,
    repositoryId: string,
  ): Promise<{ fullName: string; defaultBranch: string } | { revoked: true }>;
}

const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

/** Test hook: drops cached installation tokens. Tokens are never persisted. */
export function clearGitHubTokenCache(): void {
  tokenCache.clear();
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .split("\n")
    .filter((line) => line && !line.startsWith("-----"))
    .join("");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function signGitHubAppJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown): string => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({
    iat: Math.floor(nowMs / 1000) - 60,
    exp: Math.floor(nowMs / 1000) + 600,
    iss: appId,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)),
  );
  let binary = "";
  for (const byte of signature) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${header}.${claims}.${encoded}`;
}

/** Production GitHub App client. Tokens are cached in memory and never logged. */
export function createGitHubRestClient(deps: {
  githubApiBase?: string | undefined;
  githubAppId?: string | undefined;
  githubAppPrivateKey?: string | undefined;
}): GitHubRestClient {
  const apiBase = (deps.githubApiBase ?? "https://api.github.com").replace(/\/+$/, "");
  return {
    async mintInstallationToken(installationId: string): Promise<GitHubInstallationToken> {
      const cached = tokenCache.get(installationId);
      if (cached && cached.expiresAtMs - Date.now() > 60_000) {
        return { token: cached.token, expiresAt: new Date(cached.expiresAtMs).toISOString() };
      }
      tokenCache.delete(installationId);
      if (!deps.githubAppId || !deps.githubAppPrivateKey) {
        throw new DomainError("github_not_configured", "github app credentials are not configured");
      }
      const jwt = await signGitHubAppJwt(deps.githubAppId, deps.githubAppPrivateKey, Date.now());
      const response = await fetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "bfb-github/v1",
        },
      });
      if (response.status === 404) {
        throw new DomainError("installation_revoked", "github installation is revoked");
      }
      if (response.status === 401) {
        throw new DomainError("github_app_auth_invalid", "github app authentication failed");
      }
      if (response.status === 403 || response.status === 429 || response.status >= 500) {
        throw new DomainError("github_unreachable", "github token endpoint is unavailable");
      }
      if (!response.ok) {
        throw new DomainError("github_unreachable", "github token endpoint failed");
      }
      const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
      if (typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string") {
        throw new DomainError("github_unreachable", "github token response is invalid");
      }
      const expiresAtMs = Math.min(
        Date.parse(body.expires_at),
        Date.now() + 10 * 60 * 1000,
      );
      tokenCache.set(installationId, { token: body.token, expiresAtMs });
      return { token: body.token, expiresAt: new Date(expiresAtMs).toISOString() };
    },
    async fetchRepository(token: string, repositoryId: string) {
      const response = await fetch(`${apiBase}/repositories/${repositoryId}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "bfb-github/v1",
        },
      });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        return { revoked: true as const };
      }
      if (!response.ok) {
        throw new DomainError("github_unreachable", "github repository read failed");
      }
      const body = (await response.json()) as {
        full_name?: unknown;
        default_branch?: unknown;
      };
      if (typeof body.full_name !== "string" || typeof body.default_branch !== "string") {
        throw new DomainError("github_unreachable", "github repository response is invalid");
      }
      return { fullName: body.full_name, defaultBranch: body.default_branch };
    },
  };
}

export interface GitHubConsumerDeps extends GitHubApiDeps {
  client: GitHubRestClient;
}

export interface GitHubQueueHandle {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface DeliveryContext {
  workspaceId: string;
  outboxId: string;
  deliveryId: string;
  event: string;
  installationId: string;
  repositoryId: string | null;
  deliveryState: string;
  outboxState: string;
  attempts: number;
}

async function loadDeliveryContext(
  db: SqlDatabase,
  message: GitHubQueueMessage,
): Promise<DeliveryContext | null> {
  const outbox = (await db
    .prepare(
      `SELECT workspace_id, delivery_id, state, attempts FROM github_integration_outbox WHERE workspace_id = ? AND outbox_id = ?`,
    )
    .get(message.workspace_id, message.outbox_id)) as {
    workspace_id: string;
    delivery_id: string;
    state: string;
    attempts: number;
  } | undefined;
  if (!outbox || outbox.delivery_id !== message.delivery_id) {
    return null;
  }
  const delivery = (await db
    .prepare(
      `SELECT event, effect_json, state FROM github_webhook_deliveries WHERE workspace_id = ? AND delivery_id = ?`,
    )
    .get(message.workspace_id, message.delivery_id)) as {
    event: string;
    effect_json: string;
    state: string;
  } | undefined;
  if (!delivery) {
    return null;
  }
  const effect = JSON.parse(delivery.effect_json) as { installationId: string; repositoryId: string | null };
  return {
    workspaceId: message.workspace_id,
    outboxId: message.outbox_id,
    deliveryId: message.delivery_id,
    event: delivery.event,
    installationId: effect.installationId,
    repositoryId: effect.repositoryId,
    deliveryState: delivery.state,
    outboxState: outbox.state,
    attempts: outbox.attempts,
  };
}

async function reconcileThroughHub(
  deps: GitHubConsumerDeps,
  context: DeliveryContext,
  observed: ReconcileGitHubObserved | undefined,
): Promise<{ ok: true; effect: string } | { ok: false; code: string }> {
  const outcome = await executeGitHubSystemCommand(
    deps,
    context.workspaceId,
    reconcileGitHubCommand,
    { outboxId: context.outboxId, deliveryId: context.deliveryId, observed },
    GITHUB_QUEUE_SYSTEM_ID,
    `github-reconcile.${context.outboxId}`,
  );
  if (!outcome.ok) {
    return { ok: false, code: outcome.error.code };
  }
  return { ok: true, effect: outcome.result.effect };
}

/**
 * Consumes one Queue message with explicit per-message disposition. Success
 * and terminal states ack exactly once; retryable failures retry with
 * backoff; poison content lands in visible DLQ state and then acks so
 * successful siblings never replay.
 */
export async function consumeGitHubQueueMessage(
  handle: GitHubQueueHandle,
  deps: GitHubConsumerDeps,
): Promise<void> {
  let message: GitHubQueueMessage;
  try {
    message = parseGitHubQueueMessage(handle.body);
  } catch {
    // Malformed envelope: no outbox row can be attributed. Retry into the
    // platform DLQ, which is monitored, rather than looping forever.
    handle.retry();
    return;
  }
  const context = await loadDeliveryContext(deps.db, message);
  if (!context) {
    await writeGitHubDlqRow(
      deps.db,
      message.workspace_id,
      message.outbox_id,
      message.delivery_id,
      "outbox_missing",
      message.attempt,
      deps.now,
    );
    handle.ack();
    return;
  }
  if (context.outboxState === "done" || context.outboxState === "dlq") {
    handle.ack();
    return;
  }
  if (
    context.deliveryState === "applied" ||
    context.deliveryState === "superseded" ||
    context.deliveryState === "ignored"
  ) {
    // Terminal delivery without a finished outbox (crashed finisher): close it.
    const link = context.repositoryId
      ? ((await deps.db
          .prepare(
            `SELECT full_name, default_branch FROM github_repository_links WHERE repository_id = ? AND link_state = 'active'`,
          )
          .get(context.repositoryId)) as { full_name: string; default_branch: string } | undefined)
      : undefined;
    await reconcileThroughHub(deps, context, link === undefined ? undefined : {
      repositoryFullName: link.full_name,
      defaultBranch: link.default_branch,
      fetchedAt: deps.now,
    });
    handle.ack();
    return;
  }
  if (context.event === "installation" || context.event === "installation_repositories") {
    // Lifecycle effects need no GitHub REST round trip and no token.
    const result = await reconcileThroughHub(deps, context, undefined);
    if (!result.ok) {
      await failAttempt(deps, handle, context, result.code);
      return;
    }
    handle.ack();
    return;
  }
  if (!context.repositoryId) {
    await writeGitHubDlqRow(deps.db, context.workspaceId, context.outboxId, context.deliveryId, "delivery_missing_repository", context.attempts, deps.now);
    handle.ack();
    return;
  }
  let token: string;
  try {
    ({ token } = await deps.client.mintInstallationToken(context.installationId));
  } catch (error) {
    if (error instanceof DomainError && error.code === "installation_revoked") {
      await markGitHubInstallationRevoked(deps.db, context.installationId, deps.now);
      try {
        await reconcileThroughHub(deps, context, undefined);
        handle.ack();
      } catch {
        await failAttempt(deps, handle, context, "installation_revoked");
      }
      return;
    }
    await failAttempt(deps, handle, context, error instanceof Error ? error.message : "mint failed");
    return;
  }
  let observed: ReconcileGitHubObserved;
  try {
    const repository = await deps.client.fetchRepository(token, context.repositoryId);
    if ("revoked" in repository) {
      await markGitHubInstallationRevoked(deps.db, context.installationId, deps.now);
      try {
        await reconcileThroughHub(deps, context, undefined);
        handle.ack();
      } catch {
        await failAttempt(deps, handle, context, "installation_revoked");
      }
      return;
    }
    observed = {
      repositoryFullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      fetchedAt: deps.now,
    };
  } catch {
    await failAttempt(deps, handle, context, "github_unreachable");
    return;
  }
  const result = await reconcileThroughHub(deps, context, observed);
  if (!result.ok) {
    // Reconcile throws only on retryable installation state or poison-missing
    // rows; the loads above rule out the poison cases, so every failure here
    // is a bounded retryable attempt.
    await failAttempt(deps, handle, context, result.code);
    return;
  }
  handle.ack();
}

async function failAttempt(
  deps: GitHubConsumerDeps,
  handle: GitHubQueueHandle,
  context: DeliveryContext,
  error: string,
): Promise<void> {
  const attempts = await noteGitHubOutboxAttempt(
    deps.db,
    context.workspaceId,
    context.outboxId,
    error,
    deps.now,
  );
  if (attempts >= GITHUB_OUTBOX_MAX_ATTEMPTS) {
    await writeGitHubDlqRow(
      deps.db,
      context.workspaceId,
      context.outboxId,
      context.deliveryId,
      error.slice(0, 200),
      attempts,
      deps.now,
    );
    handle.ack();
    return;
  }
  handle.retry({ delaySeconds: Math.min(githubOutboxBackoffSeconds(Math.max(attempts, 0)), 300) });
}

/** Consumes one Queue batch with per-message try/catch and explicit dispositions. */
export async function consumeGitHubQueueBatch(
  handles: GitHubQueueHandle[],
  deps: GitHubConsumerDeps,
): Promise<void> {
  for (const handle of handles) {
    try {
      await consumeGitHubQueueMessage(handle, deps);
    } catch {
      // Never let one message replay its successful siblings: park it for redelivery.
      try {
        handle.retry();
      } catch {
        // The runtime auto-retries unhandled messages; nothing else is safe here.
      }
    }
  }
}

export interface GitHubSweepResult {
  claimed: number;
  reclaimed: number;
  sent: number;
  sendFailures: number;
}

/**
 * Cron recovery: re-enqueues committed outbox rows whose Queue message never
 * arrived (including the D1-commit-before-enqueue crash gap) and rows whose
 * dispatch went stale. Bounded per tick; send failures stay recoverable.
 */
export async function runGitHubSweep(
  db: SqlDatabase,
  queue: { send(message: GitHubQueueMessage): Promise<unknown> } | undefined,
  now: string,
): Promise<GitHubSweepResult> {
  const claimed = await claimGitHubOutboxBatch(db, now);
  const reclaimed = await reclaimStaleGitHubOutbox(db, now);
  let sent = 0;
  let sendFailures = 0;
  for (const message of [...claimed, ...reclaimed]) {
    try {
      if (!queue) {
        throw new Error("github queue is not configured");
      }
      await queue.send(message);
      sent += 1;
    } catch {
      sendFailures += 1;
    }
  }
  return { claimed: claimed.length, reclaimed: reclaimed.length, sent, sendFailures };
}
