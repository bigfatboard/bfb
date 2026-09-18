// ABOUTME: Serves Owner-gated operations reads, privileged recovery, retention, and diagnostics.
// ABOUTME: Recovery runs outside hub transactions; audit rows carry only sanitized fields.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  applyOpsRecovery,
  assertRole,
  checkOperationsTables,
  collectWorkspaceHealth,
  consentDiagnosticUploadCommand,
  consumeAbuseBudget,
  createDiagnosticBundleCommand,
  diagnosticR2Key,
  DomainError,
  getRetentionPolicy,
  listRetentionEligibleChunks,
  listStuckLaunches,
  listStuckUploads,
  loadPrincipal,
  OPS_RECOVERY_KINDS,
  readActivityFeed,
  readQueueState,
  readSecurityAudit,
  sanitizeDiagnosticValue,
  setRetentionPolicyCommand,
  validateStepUpProof,
  type DiagnosticBundleRecord,
  type HubCommand,
  type OpsQueueMessage,
  type OpsRecoveryKind,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";
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
  return json({ ok: true, result: outcome.result, replayed: outcome.replayed });
}

/**
 * Consumes one fresh action-bound step-up proof outside a hub transaction.
 * Recovery effects interleave reads and writes, which D1 batches forbid
 * inside a transaction, so the guarded consume runs here with the same
 * single-winner UPDATE semantics the hub commands use.
 */
async function consumeRecoveryProof(
  deps: OpsBrowserDeps,
  proofId: string,
  action: string,
  targetId: string,
  humanId: string,
  authorizationEpoch: number,
): Promise<void> {
  if (typeof proofId !== "string" || !proofId) {
    throw new DomainError("step_up_invalid", "step-up proof is required");
  }
  const proof = (await deps.db
    .prepare(`SELECT expires_at FROM passkey_step_up_proofs WHERE proof_id = ?`)
    .get(proofId)) as { expires_at: string } | undefined;
  if (!proof) {
    throw new DomainError("step_up_invalid", "step-up proof is invalid");
  }
  await validateStepUpProof(
    deps.db,
    proofId,
    {
      action,
      workspaceId: deps.workspaceId,
      targetId,
      scopes: [],
      authorizationEpoch,
      expiresAt: proof.expires_at,
    },
    deps.now,
    humanId,
  );
  const stamp = `${deps.now}#${proofId}`;
  const result = await deps.db
    .prepare(
      `UPDATE passkey_step_up_proofs SET consumed_at = ? WHERE proof_id = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(stamp, proofId, deps.now);
  if ((result.changes ?? 0) !== 1) {
    throw new DomainError("step_up_replayed", "step-up proof already consumed");
  }
}

function publicBundle(row: DiagnosticBundleRecord): Record<string, unknown> {
  return {
    bundle_id: row.id,
    state: row.state,
    redaction_status: row.redaction_status,
    bundle_hash: row.bundle_hash,
    inventory: JSON.parse(row.inventory_json) as unknown,
    created_at: row.created_at,
    consented_at: row.consented_at,
    uploaded_at: row.uploaded_at,
    expires_at: row.expires_at,
    r2_key: row.r2_key,
    last_error: row.last_error,
  };
}

/**
 * Browser operations surface under /api/v1/workspaces/:ws/operations.
 * Security audit and every mutation are Owner-only; activity, queues,
 * health, retention reads, and bundle inventory are owner/member, with
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
      const feed = await readActivityFeed(deps.db, workspaceId, {
        limit: Number.isSafeInteger(limit) ? limit : 50,
        ...(afterRaw === null ? {} : { afterCursor: Number(afterRaw) }),
        ...(principal.role === "reviewer" ? { projectIds: principal.projectIds } : {}),
      });
      return json({ ok: true, ...feed });
    }
    if (request.method === "GET" && (tail === "/security-audit" || tail === "/security-audit/")) {
      assertRole(principal, ["owner"]);
      const after = url.searchParams.get("after") ?? undefined;
      const audit = await readSecurityAudit(deps.db, workspaceId, {
        limit: Number.isSafeInteger(limit) ? limit : 50,
        ...(after === undefined ? {} : { after }),
      });
      return json({ ok: true, ...audit });
    }
    if (request.method === "GET" && (tail === "/queues" || tail === "/queues/")) {
      assertRole(principal, ["owner", "member"]);
      return json({
        ok: true,
        queues: await readQueueState(deps.db, workspaceId, deps.now),
        stuck_uploads: await listStuckUploads(deps.db, workspaceId, deps.now),
        stuck_launches: await listStuckLaunches(deps.db, workspaceId, deps.now),
      });
    }
    if (request.method === "GET" && (tail === "/health" || tail === "/health/")) {
      assertRole(principal, ["owner", "member"]);
      const tables = await checkOperationsTables(deps.db);
      const health = await collectWorkspaceHealth(deps.db, workspaceId, deps.now);
      return json({ ok: true, health, migrations: tables });
    }
    if (request.method === "GET" && (tail === "/retention" || tail === "/retention/")) {
      assertRole(principal, ["owner", "member"]);
      const policy = await getRetentionPolicy(deps.db, workspaceId);
      const candidates = await listRetentionEligibleChunks(deps.db, workspaceId, deps.now);
      return json({ ok: true, policy, eligible: candidates });
    }
    if (request.method === "GET" && (tail === "/diagnostics" || tail === "/diagnostics/")) {
      assertRole(principal, ["owner", "member"]);
      const rows = (await deps.db
        .prepare(
          `SELECT * FROM diagnostic_bundles WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
        )
        .all(workspaceId)) as DiagnosticBundleRecord[];
      return json({ ok: true, bundles: rows.map(publicBundle) });
    }
    const bundleMatch = /^\/diagnostics\/([^/]+)\/?$/.exec(tail);
    if (request.method === "GET" && bundleMatch?.[1]) {
      assertRole(principal, ["owner", "member"]);
      const row = (await deps.db
        .prepare(`SELECT * FROM diagnostic_bundles WHERE workspace_id = ? AND id = ?`)
        .get(workspaceId, decodeURIComponent(bundleMatch[1]))) as
        DiagnosticBundleRecord | undefined;
      if (!row) {
        return json({ error: "not_found" }, 404);
      }
      return json({ ok: true, bundle: publicBundle(row) });
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
      await consumeRecoveryProof(
        deps,
        requiredString(body, "step_up_proof_id"),
        "ops.recover",
        `ops-recover:${kind}:${workspaceId}`,
        principal.humanId,
        principal.authorizationEpoch,
      );
      const result = await applyOpsRecovery({
        db: deps.db,
        workspaceId,
        kind: kind as OpsRecoveryKind,
        target: typedTarget,
        actorHumanId: principal.humanId,
        now: deps.now,
      });
      await deps.db
        .prepare(
          `INSERT INTO audit_events (workspace_id, audit_id, actor_principal_id, action, payload_json, created_at)
           VALUES (?, ?, ?, 'ops.recover', ?, ?)`,
        )
        .run(
          workspaceId,
          `audit-${requestId(body)}-${result.action_id}`.slice(0, 64),
          principal.humanId,
          JSON.stringify(
            sanitizeDiagnosticValue({
              kind,
              action_id: result.action_id,
              replayed: result.replayed,
            }),
          ),
          deps.now,
        );
      return json({ ok: true, result });
    }
    if (request.method === "POST" && tail === "/diagnostics") {
      assertRole(principal, ["owner"]);
      return mutate(deps, principal, createDiagnosticBundleCommand, `ops.${requestId(body)}`, {
        stepUpProofId: requiredString(body, "step_up_proof_id"),
      });
    }
    const consentMatch = /^\/diagnostics\/([^/]+)\/consent\/?$/.exec(tail);
    if (request.method === "POST" && consentMatch?.[1]) {
      assertRole(principal, ["owner"]);
      const bundleId = decodeURIComponent(consentMatch[1]);
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
        consentDiagnosticUploadCommand,
        {
          workspaceId: deps.workspaceId,
          idempotencyKey: `ops.${requestId(body)}`,
          actorHumanId: principal.humanId,
          authorizationEpoch: principal.authorizationEpoch,
          now: deps.now,
          input: { bundleId, stepUpProofId: requiredString(body, "step_up_proof_id") },
        },
      );
      if (!outcome.ok) {
        return failure(new DomainError(outcome.error.code, outcome.error.message));
      }
      const bundle = outcome.result;
      if (bundle.state === "consented" && deps.opsJobs) {
        const message: OpsQueueMessage = {
          schema_version: 1,
          kind: "diagnostic.upload",
          workspace_id: workspaceId,
          bundle_id: bundle.id,
          attempt: 1,
        };
        try {
          await deps.opsJobs.send(message, { contentType: "json" });
        } catch {
          // Enqueue runs outside the hub batch: a send failure surfaces here
          // while the consented state stays durable for Cron redelivery.
          return json({ ok: true, bundle: publicBundle(bundle), upload_queued: false });
        }
        return json({ ok: true, bundle: publicBundle(bundle), upload_queued: true });
      }
      return json({ ok: true, bundle: publicBundle(bundle), upload_queued: false });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return failure(error);
  }
}

/** R2 key helper re-export for the queue consumer and sweep. */
export { diagnosticR2Key };
