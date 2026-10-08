// ABOUTME: Serves Owner-gated operations reads, privileged recovery, retention, and diagnostics.
// ABOUTME: Upload recovery uses retained authority while unsupported recovery and diagnostics remain unavailable.

import { createHash, createHmac, randomUUID } from "node:crypto";

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  assertOperationsUploadRecoveryAccess,
  assertRole,
  checkOperationsTables,
  collectWorkspaceHealth,
  consumeAbuseBudget,
  diagnosticR2Key,
  DomainError,
  isUlid,
  issueSecurityAuditPositionCommand,
  listRetentionEligibleChunks,
  listStuckLaunches,
  listStuckUploads,
  loadPrincipal,
  OPS_RECOVERY_KINDS,
  readOperationsProjection,
  readSecurityAudit,
  resolveStuckUploadCommand,
  setRetentionPolicyCommand,
  type HubCommand,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import { executePublicWorkspaceCommand as executeWorkspaceCommand } from "../public-command-outcome.js";
import { readBoundedJson } from "./request.js";

export interface OpsBrowserDeps {
  db: SqlDatabase;
  now: string;
  jurisdiction: Jurisdiction;
  abuseSecret: string;
  principal: BrowserPrincipal;
  workspaceId: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
  opsJobs?: Queue | undefined;
}

const OPS_POLICY = {
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
  deps: OpsBrowserDeps,
  subject: string,
  surface: string,
): Promise<void> {
  if (typeof deps.abuseSecret !== "string" || deps.abuseSecret.length < 32) {
    throw new DomainError("request_rejected", "request rejected");
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const expiresAt = new Date(Date.parse(deps.now) + OPS_POLICY.windowSeconds * 1000).toISOString();
  for (const [bucketSubject, seed] of [
    ["all", createHmac("sha256", deps.abuseSecret).update(`ops-ip:${ip}`).digest("hex")],
    [subject, createHmac("sha256", deps.abuseSecret).update("ops-subject").digest("hex")],
  ] as const) {
    const decision = await consumeAbuseBudget(
      deps.db,
      {
        bucketKey: abuseBucketKey({
          ipHashSeed: seed,
          subject: bucketSubject,
          surface: `ops:${surface}`,
        }),
        activity: "attempt",
        bodyBytes: 0,
        now: deps.now,
        expiresAt,
      },
      OPS_POLICY,
    );
    if (!decision.allowed) {
      throw new DomainError("request_rejected", "request rejected");
    }
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
  deps: OpsBrowserDeps,
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
  return json(outcome);
}

function rejectDiagnostics(): never {
  throw new DomainError("request_rejected", "diagnostic bundles are unavailable");
}

/**
 * Browser operations surface under /api/v1/workspaces/:ws/operations.
 * Security audit and every mutation are Owner-only; activity, queues,
 * health, retention reads, and diagnostics availability are owner/member, with
 * reviewers scoped to their projects on activity.
 */
export async function handleOperationsApi(
  request: Request,
  deps: OpsBrowserDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const workspaceId = deps.workspaceId;
    const prefix = `/api/v1/workspaces/${workspaceId}/operations`;
    if (!url.pathname.startsWith(prefix)) {
      return json({ error: "not_found" }, 404);
    }
    const principal = await loadPrincipal(deps.db, workspaceId, deps.principal.humanId);
    const tail = url.pathname.slice(prefix.length);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? 50 : Number(limitRaw);

    if (request.method === "GET" && (tail === "/activity" || tail === "/activity/")) {
      assertRole(principal, ["owner", "member", "reviewer"]);
      const afterRaw = url.searchParams.get("after_cursor");
      if (afterRaw !== null && (!Number.isSafeInteger(Number(afterRaw)) || Number(afterRaw) < 0)) {
        throw new DomainError("invalid_argument", "activity cursor is invalid");
      }
      return json({ error: "request_rejected", message: "event feeds are unavailable" }, 409);
    }
    if (request.method === "GET" && (tail === "/security-audit" || tail === "/security-audit/")) {
      assertRole(principal, ["owner"]);
      const after = url.searchParams.get("after") ?? undefined;
      const audit = await readSecurityAudit(
        deps.db,
        workspaceId,
        {
          access: principal,
          limit: Number.isSafeInteger(limit) ? limit : 50,
          ...(after === undefined ? {} : { after }),
        },
        async (input) => {
          const outcome = await executeWorkspaceCommand(
            {
              db: deps.db,
              workspaceHubNs: deps.workspaceHubNs,
              authorization: createAuthorizationContext({
                workspaceId,
                principalId: principal.humanId,
                authorizationEpoch: principal.authorizationEpoch,
                jurisdiction: deps.jurisdiction,
              }),
            },
            issueSecurityAuditPositionCommand,
            {
              workspaceId,
              idempotencyKey: `ops.audit-position.${randomUUID()}`,
              actorHumanId: principal.humanId,
              authorizationEpoch: principal.authorizationEpoch,
              input,
            },
          );
          if (!outcome.ok) throw new DomainError(outcome.error.code, outcome.error.message);
        },
      );
      return json({ ok: true, ...audit });
    }
    if (request.method === "GET" && (tail === "/queues" || tail === "/queues/")) {
      assertRole(principal, ["owner", "member"]);
      const uploads = await listStuckUploads(deps.db, workspaceId, deps.now, principal);
      const launches = await listStuckLaunches(deps.db, workspaceId, deps.now, principal);
      const projection = await readOperationsProjection(
        deps.db,
        workspaceId,
        deps.now,
        {
          uploads,
          launches,
        },
        principal,
      );
      return json({
        ok: true,
        queues: projection.queues,
        stuck_uploads: projection.work.uploads,
        stuck_launches: projection.work.launches,
      });
    }
    if (request.method === "GET" && (tail === "/health" || tail === "/health/")) {
      assertRole(principal, ["owner", "member"]);
      const tables = await checkOperationsTables(deps.db);
      const health = await collectWorkspaceHealth(deps.db, workspaceId, deps.now, principal);
      return json({ ok: true, health, migrations: tables });
    }
    if (request.method === "GET" && (tail === "/retention" || tail === "/retention/")) {
      assertRole(principal, ["owner", "member"]);
      const { policy, ...candidates } = await listRetentionEligibleChunks(
        deps.db,
        workspaceId,
        deps.now,
        principal,
      );
      return json({ ok: true, policy, eligible: candidates });
    }
    if (request.method === "GET" && (tail === "/diagnostics" || tail === "/diagnostics/")) {
      assertRole(principal, ["owner", "member"]);
      rejectDiagnostics();
    }
    const bundleMatch = /^\/diagnostics\/([^/]+)\/?$/.exec(tail);
    if (request.method === "GET" && bundleMatch?.[1]) {
      assertRole(principal, ["owner", "member"]);
      decodeURIComponent(bundleMatch[1]);
      rejectDiagnostics();
    }
    if (request.method !== "POST" && request.method !== "PUT") {
      return json({ error: "method_not_allowed" }, 405);
    }
    await budget(request, deps, `${workspaceId}:${principal.humanId}`, "operations");
    const body = objectBody(await readBoundedJson(request, BODY_LIMIT), [
      "request_id",
      "raw_log_retention_days",
      "kind",
      "target",
      "bundle_id",
      "step_up_proof_id",
    ]);
    if (request.method === "PUT" && (tail === "/retention" || tail === "/retention/")) {
      assertRole(principal, ["owner"]);
      const days = body.raw_log_retention_days;
      if (!Number.isInteger(days)) {
        throw new DomainError("invalid_argument", "raw_log_retention_days is required");
      }
      return mutate(deps, principal, setRetentionPolicyCommand, `ops.${requestId(body)}`, {
        rawLogRetentionDays: days as number,
        stepUpProofId: requiredString(body, "step_up_proof_id"),
      });
    }
    if (request.method === "POST" && tail === "/recovery") {
      assertRole(principal, ["owner"]);
      const kind = body.kind;
      if (typeof kind !== "string" || !(OPS_RECOVERY_KINDS as readonly string[]).includes(kind)) {
        throw new DomainError("invalid_argument", "recovery kind is invalid");
      }
      const target = body.target;
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new DomainError("invalid_argument", "recovery target is required");
      }
      const typedTarget = target as Record<string, unknown>;
      const recoveryRequestId = requestId(body);
      const proofId = requiredString(body, "step_up_proof_id");
      if (kind === "resolve_stuck_upload") {
        const uploadTarget = objectBody(typedTarget, ["version_ids"]);
        if (!Array.isArray(uploadTarget.version_ids)) {
          throw new DomainError("invalid_argument", "version_ids must be an array");
        }
        const versionIds = uploadTarget.version_ids as string[];
        const key = createHash("sha256")
          .update(JSON.stringify([recoveryRequestId, proofId]))
          .digest("hex");
        const outcome = await executeWorkspaceCommand(
          {
            db: deps.db,
            workspaceHubNs: deps.workspaceHubNs,
            authorization: createAuthorizationContext({
              workspaceId,
              principalId: principal.humanId,
              authorizationEpoch: principal.authorizationEpoch,
              jurisdiction: deps.jurisdiction,
            }),
          },
          resolveStuckUploadCommand,
          {
            workspaceId,
            idempotencyKey: `ops.recovery.${key}`,
            actorHumanId: principal.humanId,
            authorizationEpoch: principal.authorizationEpoch,
            now: deps.now,
            input: { versionIds, stepUpProofId: proofId },
          },
        );
        if (!outcome.ok) {
          return failure(new DomainError(outcome.error.code, outcome.error.message));
        }
        await assertOperationsUploadRecoveryAccess(deps.db, workspaceId, versionIds, principal);
        return json({ ok: true, result: outcome.result });
      }
      throw new DomainError("request_rejected", "recovery kind is unavailable");
    }
    if (request.method === "POST" && tail === "/diagnostics") {
      assertRole(principal, ["owner"]);
      requestId(body);
      requiredString(body, "step_up_proof_id");
      rejectDiagnostics();
    }
    const consentMatch = /^\/diagnostics\/([^/]+)\/consent\/?$/.exec(tail);
    if (request.method === "POST" && consentMatch?.[1]) {
      assertRole(principal, ["owner"]);
      const bundleId = decodeURIComponent(consentMatch[1]);
      requestId(body);
      requiredString(body, "step_up_proof_id");
      if (!isUlid(bundleId)) {
        throw new DomainError("invalid_argument", "bundleId must be a ULID");
      }
      rejectDiagnostics();
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return failure(error);
  }
}

/** R2 key helper re-export for the queue consumer and sweep. */
export { diagnosticR2Key };
