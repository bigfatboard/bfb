// ABOUTME: Serves browser artifact publication over hub commands with hashed abuse budgets.
// ABOUTME: Route-minted upload secrets are returned once; D1 keeps hashes and receipts only.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_BODY_LIMIT,
  artifactHash,
  artifactSubject,
  consumeArtifactBudget,
  createArtifactCommand,
  DomainError,
  finalizeArtifactCommand,
  isUlid,
  issueArtifactGrantCommand,
  issueGrantResponse,
  loadPrincipal,
  mintUploadGrantSecret,
  randomUlid,
  sweepAbandonedArtifactUploads,
  type CommandRequest,
  type HubCommand,
} from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import type { BrowserPrincipal } from "../auth/session.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

export interface ArtifactApiDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  now: string;
  jurisdiction: Jurisdiction;
  appOrigin: string;
  abuseSecret: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

function rejected(): Response {
  return response({ error: "request_rejected", message: "request rejected" }, 403);
}

function artifactSeeds(
  abuseSecret: string,
  request: Request,
): { ipSeed: string; subjectSeed: string } | null {
  if (typeof abuseSecret !== "string" || abuseSecret.length < 32) return null;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return {
    ipSeed: createHmac("sha256", abuseSecret)
      .update(`artifact-ip:${ip.slice(0, 64)}`)
      .digest("hex"),
    subjectSeed: createHmac("sha256", abuseSecret).update("artifact-subject").digest("hex"),
  };
}

async function consumeBudget(
  deps: ArtifactApiDeps,
  request: Request,
  surface: string,
  subject: string,
  activity: "attempt" | "poll",
): Promise<boolean> {
  const seeds = artifactSeeds(deps.abuseSecret, request);
  if (!seeds) return false;
  return consumeArtifactBudget(deps.db, { ...seeds, surface, subject, activity, now: deps.now });
}

async function executeArtifactCommand<TInput, TResult>(
  deps: ArtifactApiDeps,
  command: HubCommand<TInput, TResult>,
  request: CommandRequest<TInput>,
): Promise<TResult> {
  const outcome = await executeWorkspaceCommand(
    {
      db: deps.db,
      workspaceHubNs: deps.workspaceHubNs,
      authorization: createAuthorizationContext({
        workspaceId: request.workspaceId,
        principalId:
          request.actorHumanId ?? request.actorRunnerId ?? request.actorSystemId ?? "missing",
        authorizationEpoch: request.authorizationEpoch,
        jurisdiction: deps.jurisdiction,
      }),
    },
    command,
    request,
  );
  if (!outcome.ok || outcome.replayed) throw new DomainError("request_rejected", "rejected");
  return outcome.result;
}

/** Called only after browser session and CSRF validation by the shared browser router. */
export async function handleArtifactBrowserApi(
  request: Request,
  deps: ArtifactApiDeps & { principal: BrowserPrincipal; workspaceId: string },
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const prefix = `/api/v1/workspaces/${deps.workspaceId}/artifacts`;
    if (!path.startsWith(prefix)) return rejected();
    const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
    const common = {
      workspaceId: deps.workspaceId,
      actorHumanId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      now: deps.now,
      idempotencyKey: randomUlid(),
    };
    if (request.method === "POST" && path === prefix) {
      const body = (await readBoundedJson(request, ARTIFACT_BODY_LIMIT)) as Record<string, unknown>;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) =>
          !["artifact_id", "run_id", "format", "role", "declared_size", "expected_digest"].includes(
            key,
          ),
        )
      ) {
        return rejected();
      }
      if (
        !(await consumeBudget(
          deps,
          request,
          "artifact:grant-create",
          artifactSubject(`create:${principal.humanId}`),
          "attempt",
        ))
      ) {
        return rejected();
      }
      const minted = mintUploadGrantSecret();
      let created;
      try {
        created = await executeArtifactCommand(deps, createArtifactCommand, {
          ...common,
          input: {
            artifactId: (body.artifact_id as string | undefined) ?? null,
            runId: (body.run_id as string | undefined) ?? null,
            format: body.format as never,
            role: body.role as never,
            declaredSize: body.declared_size as number,
            expectedDigest: body.expected_digest as string,
            grantSecretHash: artifactHash(minted.secret),
          },
        });
      } catch {
        return rejected();
      }
      const grant = issueGrantResponse(created.upload_grant, minted.secret);
      return response(
        {
          artifact_id: created.artifact_id,
          version_id: created.version_id,
          state: created.state,
          format: created.format,
          role: created.role,
          declared_size: created.declared_size,
          expected_digest: created.expected_digest,
          upload_grant: {
            grant_id: grant.grant_id,
            version_id: grant.version_id,
            secret: grant.secret,
            expires_at: grant.expires_at,
          },
        },
        201,
      );
    }
    const grantRoute = /^\/api\/v1\/workspaces\/[^/]+\/artifacts\/([^/]+)\/grants$/.exec(path);
    if (request.method === "POST" && grantRoute?.[1]) {
      await readBoundedJson(request, ARTIFACT_BODY_LIMIT).catch(() => ({}));
      const versionId = grantRoute[1];
      if (!isUlid(versionId)) return rejected();
      if (
        !(await consumeBudget(
          deps,
          request,
          "artifact:grant-issue",
          artifactSubject(`issue:${versionId}`),
          "attempt",
        ))
      ) {
        return rejected();
      }
      const minted = mintUploadGrantSecret();
      let grant;
      try {
        const issued = await executeArtifactCommand(deps, issueArtifactGrantCommand, {
          ...common,
          idempotencyKey: randomUlid(),
          input: { versionId, grantSecretHash: artifactHash(minted.secret) },
        });
        grant = issueGrantResponse(issued, minted.secret);
      } catch {
        return rejected();
      }
      return response(
        {
          grant_id: grant.grant_id,
          version_id: grant.version_id,
          secret: grant.secret,
          expires_at: grant.expires_at,
        },
        201,
      );
    }
    const finalizeRoute = /^\/api\/v1\/workspaces\/[^/]+\/artifacts\/([^/]+)\/finalize$/.exec(path);
    if (request.method === "POST" && finalizeRoute?.[1]) {
      const body = (await readBoundedJson(request, ARTIFACT_BODY_LIMIT)) as Record<string, unknown>;
      const versionId = finalizeRoute[1];
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["content_hash", "size"].includes(key)) ||
        !isUlid(versionId)
      ) {
        return rejected();
      }
      if (
        !(await consumeBudget(
          deps,
          request,
          "artifact:finalize",
          artifactSubject(`finalize:${versionId}`),
          "attempt",
        ))
      ) {
        return rejected();
      }
      let finalized;
      try {
        finalized = await executeArtifactCommand(deps, finalizeArtifactCommand, {
          ...common,
          idempotencyKey: randomUlid(),
          input: {
            versionId,
            contentHash: body.content_hash as string,
            size: body.size as number,
          },
        });
      } catch {
        return rejected();
      }
      return response({
        version_id: finalized.version_id,
        artifact_id: finalized.artifact_id,
        state: finalized.state,
        content_hash: finalized.content_hash,
        r2_key: finalized.r2_key,
        available_at: finalized.available_at,
      });
    }
    return rejected();
  } catch {
    return rejected();
  }
}

/**
 * Recovery sweep shared by the Cron trigger and the V01 acceptance harness.
 * Marks uploading versions failed once every outstanding grant expired past
 * grace; shared content-addressed bytes are never deleted.
 */
export async function runArtifactSweep(
  db: SqlDatabase,
  now: string,
): Promise<{ marked: string[] }> {
  const marked = await sweepAbandonedArtifactUploads(db, now);
  return { marked };
}
