// ABOUTME: Serves browser artifact review reads and decisions over hub commands.
// ABOUTME: Version conflicts stay explicit; approval never mutates runs, tasks, or results.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  ARTIFACT_BODY_LIMIT,
  artifactSubject,
  consumeArtifactBudget,
  DomainError,
  getArtifactReviewStatus,
  isUlid,
  listArtifactsWithReviewState,
  loadPrincipal,
  randomUlid,
  readReviewTimerContext,
  recordReviewCommand,
  type HubCommand,
  type ReviewRecord,
} from "@bfb/domain";

import type { HumanAuth } from "../auth/better-auth.js";
import type { BrowserPrincipal } from "../auth/session.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

export interface ReviewApiDeps {
  db: SqlDatabase;
  auth: HumanAuth;
  now: string;
  jurisdiction: Jurisdiction;
  appOrigin: string;
  abuseSecret: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

const REVIEW_FIELDS = [
  "version_id",
  "expected_content_hash",
  "expected_latest_version_id",
  "decision",
  "comment",
  "git_commit",
  "config_hash",
  "review_timer_observation_id",
  "request_id",
] as const;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

function rejected(): Response {
  return response({ error: "request_rejected", message: "request rejected" }, 403);
}

function errorResponse(code: string, message: string): Response {
  const status =
    code === "not_found"
      ? 404
      : code === "forbidden"
        ? 403
        : code === "stale_version" || code === "version_mismatch"
          ? 409
          : 400;
  return response({ error: code, message }, status);
}

function reviewJson(record: ReviewRecord): Record<string, unknown> {
  return {
    id: record.id,
    artifact_id: record.artifact_id,
    version_id: record.version_id,
    content_hash: record.content_hash,
    reviewer_human_id: record.reviewer_human_id,
    decision: record.decision,
    comment: record.comment,
    git_commit: record.git_commit,
    config_hash: record.config_hash,
    review_timer_observation_id: record.review_timer_observation_id,
    created_at: record.created_at,
  };
}

/** Called only after browser session and CSRF validation by the shared browser router. */
export async function handleArtifactReviewApi(
  request: Request,
  deps: ReviewApiDeps & { principal: BrowserPrincipal; workspaceId: string },
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const prefix = `/api/v1/workspaces/${deps.workspaceId}/artifacts`;
    const reviewsRoute = /^\/api\/v1\/workspaces\/[^/]+\/artifacts\/([^/]+)\/reviews$/.exec(path);
    if (!(
      reviewsRoute?.[1] ||
      (request.method === "GET" && (path === prefix || path === `${prefix}/`))
    )) {
      return rejected();
    }
    const principal = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
    if (request.method === "GET" && !reviewsRoute) {
      const runId = url.searchParams.get("run_id");
      if (runId !== null && !isUlid(runId)) {
        return errorResponse("invalid_argument", "run id is invalid");
      }
      const artifacts = await listArtifactsWithReviewState(
        deps.db,
        deps.workspaceId,
        runId ?? undefined,
      );
      return response({ artifacts });
    }
    const artifactId = reviewsRoute?.[1] as string;
    if (!isUlid(artifactId)) {
      return errorResponse("not_found", "artifact not found");
    }
    if (request.method === "GET") {
      const status = await getArtifactReviewStatus(deps.db, deps.workspaceId, artifactId);
      if (!status) {
        return errorResponse("not_found", "artifact not found");
      }
      const timers: Record<string, unknown> = {};
      for (const review of status.reviews) {
        if (review.review_timer_observation_id) {
          timers[review.id] =
            (await readReviewTimerContext(
              deps.db,
              deps.workspaceId,
              review.review_timer_observation_id,
            )) ?? null;
        }
      }
      return response({ ...status, review_timers: timers });
    }
    if (request.method === "POST") {
      let record: Record<string, unknown>;
      try {
        const parsed = (await readBoundedJson(request, ARTIFACT_BODY_LIMIT)) as Record<
          string,
          unknown
        >;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return errorResponse("invalid_argument", "request body must be an object");
        }
        if (
          Object.keys(parsed).some((key) => !(REVIEW_FIELDS as readonly string[]).includes(key))
        ) {
          return errorResponse("invalid_argument", "request body contains an unsupported field");
        }
        record = parsed;
      } catch {
        return errorResponse("invalid_argument", "request body is invalid");
      }
      if (typeof deps.abuseSecret !== "string" || deps.abuseSecret.length < 32) {
        return rejected();
      }
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      const budgeted = await consumeArtifactBudget(deps.db, {
        ipSeed: createHmac("sha256", deps.abuseSecret)
          .update(`artifact-ip:${ip.slice(0, 64)}`)
          .digest("hex"),
        subjectSeed: createHmac("sha256", deps.abuseSecret)
          .update("artifact-subject")
          .digest("hex"),
        surface: "artifact:review-create",
        subject: artifactSubject(`review-create:${principal.humanId}`),
        activity: "attempt",
        now: deps.now,
      });
      if (!budgeted) return rejected();
      const requestKey =
        typeof record.request_id === "string" &&
        record.request_id.length >= 8 &&
        record.request_id.length <= 128
          ? record.request_id
          : randomUlid();
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
        recordReviewCommand as HubCommand<unknown, unknown>,
        {
          workspaceId: deps.workspaceId,
          actorHumanId: principal.humanId,
          authorizationEpoch: principal.authorizationEpoch,
          now: deps.now,
          idempotencyKey: requestKey,
          input: {
            artifactId,
            versionId: record.version_id,
            expectedContentHash: record.expected_content_hash,
            expectedLatestVersionId: record.expected_latest_version_id,
            decision: record.decision,
            ...(record.comment === undefined ? {} : { comment: record.comment }),
            ...(record.git_commit === undefined ? {} : { gitCommit: record.git_commit }),
            ...(record.config_hash === undefined ? {} : { configHash: record.config_hash }),
            ...(record.review_timer_observation_id === undefined
              ? {}
              : { reviewTimerObservationId: record.review_timer_observation_id }),
          },
        },
      );
      if (!outcome.ok) {
        const code = outcome.error?.code ?? "request_rejected";
        if (code === "request_rejected") return rejected();
        return errorResponse(code, outcome.error?.message ?? code);
      }
      if (outcome.replayed) {
        return errorResponse("request_rejected", "review was already recorded");
      }
      return response({ review: reviewJson(outcome.result as ReviewRecord) }, 201);
    }
    return rejected();
  } catch (error) {
    if (error instanceof DomainError) {
      return errorResponse(error.code, error.message);
    }
    return rejected();
  }
}
