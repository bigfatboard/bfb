// ABOUTME: Mints one-time artifact view grants for browser preview sessions.
// ABOUTME: Route-minted secrets are returned once; D1 keeps hashes and view IDs only.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_BODY_LIMIT,
  artifactHash,
  artifactSubject,
  consumeArtifactBudget,
  createViewGrantCommand,
  DomainError,
  issueViewGrantResponse,
  loadPrincipal,
  mintViewGrantSecret,
  mintViewNonce,
  randomUlid,
  type HubCommand,
  type ViewGrant,
} from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import type { BrowserPrincipal } from "../auth/session.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

export interface ViewGrantApiDeps {
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

/** Called only after browser session and CSRF validation by the shared browser router. */
export async function handleArtifactViewGrantApi(
  request: Request,
  deps: ViewGrantApiDeps & { principal: BrowserPrincipal; workspaceId: string },
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    const route = /^\/api\/v1\/workspaces\/[^/]+\/artifacts\/([^/]+)\/views$/.exec(path);
    if (request.method !== "POST" || !route?.[1]) return rejected();
    // The grant request carries no fields; any body must be an empty object.
    const body = (await readBoundedJson(request, ARTIFACT_BODY_LIMIT).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
      return rejected();
    }
    const versionId = route[1];
    const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
    if (typeof deps.abuseSecret !== "string" || deps.abuseSecret.length < 32) return rejected();
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const budgeted = await consumeArtifactBudget(deps.db, {
      ipSeed: createHmac("sha256", deps.abuseSecret).update(`artifact-ip:${ip.slice(0, 64)}`).digest("hex"),
      subjectSeed: createHmac("sha256", deps.abuseSecret).update("artifact-subject").digest("hex"),
      surface: "artifact:view-create",
      subject: artifactSubject(`view-create:${principal.humanId}`),
      activity: "attempt",
      now: deps.now,
    });
    if (!budgeted) return rejected();
    const minted = mintViewGrantSecret();
    const nonce = mintViewNonce();
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
      createViewGrantCommand as HubCommand<unknown, unknown>,
      {
        workspaceId: deps.workspaceId,
        actorHumanId: principal.humanId,
        authorizationEpoch: principal.authorizationEpoch,
        now: deps.now,
        idempotencyKey: randomUlid(),
        input: {
          versionId,
          grantSecretHash: artifactHash(minted.secret),
          viewNonce: nonce,
          sessionHash: artifactHash(deps.principal.sessionId),
        },
      },
    );
    if (!outcome.ok || outcome.replayed) throw new DomainError("request_rejected", "rejected");
    const grant = issueViewGrantResponse(
      outcome.result as ViewGrant,
      minted.secret,
      nonce,
    );
    // The grant hash never leaves the server; the response carries the
    // one-time secret and channel nonce over the authenticated session only.
    return response(
      {
        view_id: grant.view_id,
        version_id: grant.version_id,
        content_hash: grant.content_hash,
        format: grant.format,
        nonce: grant.nonce,
        secret: grant.secret,
        expires_at: grant.expires_at,
      },
      201,
    );
  } catch {
    return rejected();
  }
}
