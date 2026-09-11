// ABOUTME: Serves browser-approved runner enrollment and bounded proof-of-possession exchanges.
// ABOUTME: Durable abuse counters and strict projections keep credentials out of D1 command history.

import { createHmac } from "node:crypto";

import { createAuthorizationContext, type Jurisdiction, type SqlDatabase } from "@bfb/db";
import {
  abuseBucketKey,
  authenticateRunnerRequestCommand,
  consumeAbuseBudget,
  encodeRunnerToken,
  enrollRunnerCommand,
  exchangeRunnerTokenCommand,
  issueRunnerChallengeCommand,
  listRunners,
  loadPrincipal,
  randomUlid,
  rejectRunnerRequest,
  replaceRunnerGrantsCommand,
  revokeRunnerCommand,
  runnerHash,
  runnerId,
  runnerObject,
  runnerSecret,
  RUNNER_BODY_LIMIT,
  type CommandRequest,
  type HubCommand,
  type RunnerPrincipal,
  type RunnerProofInput,
  type RunnerRequestBinding,
  RUNNER_CHALLENGE_ISSUER_ID,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import { executeWorkspaceCommand } from "../hub-client.js";
import { readBoundedJson } from "./request.js";

export interface RunnerApiDeps {
  db: SqlDatabase;
  now: string;
  jurisdiction: Jurisdiction;
  appOrigin: string;
  abuseSecret: string;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

const POLICY = {
  attemptLimit: 20,
  pollLimit: 60,
  windowSeconds: 60,
  maxBodyBytes: RUNNER_BODY_LIMIT,
} as const;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

function rejected(): Response {
  return response({ error: "request_rejected", message: "request rejected" }, 403);
}

async function budget(
  request: Request,
  deps: RunnerApiDeps,
  subject: string,
  surface: string,
): Promise<void> {
  if (typeof deps.abuseSecret !== "string" || deps.abuseSecret.length < 32) rejectRunnerRequest();
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const expiresAt = new Date(Date.parse(deps.now) + POLICY.windowSeconds * 1000).toISOString();
  // Per-address and per-subject dimensions prevent both many-ID and many-IP bypasses.
  for (const [bucketSubject, seed] of [
    ["all", createHmac("sha256", deps.abuseSecret).update(`runner-ip:${ip}`).digest("hex")],
    [subject, createHmac("sha256", deps.abuseSecret).update("runner-subject").digest("hex")],
  ] as const) {
    const decision = await consumeAbuseBudget(
      deps.db,
      {
        bucketKey: abuseBucketKey({
          ipHashSeed: seed,
          subject: bucketSubject,
          surface: `runner:${surface}`,
        }),
        activity: request.method === "GET" ? "poll" : "attempt",
        bodyBytes: 0,
        now: deps.now,
        expiresAt,
      },
      POLICY,
    );
    if (!decision.allowed) rejectRunnerRequest();
  }
}

async function execute<TInput, TResult>(
  deps: RunnerApiDeps,
  command: HubCommand<TInput, TResult>,
  request: CommandRequest<TInput>,
): Promise<TResult> {
  const principalId = request.actorHumanId ?? request.actorRunnerId ?? request.actorSystemId;
  if (!principalId) rejectRunnerRequest();
  const outcome = await executeWorkspaceCommand(
    {
      db: deps.db,
      workspaceHubNs: deps.workspaceHubNs,
      authorization: createAuthorizationContext({
        workspaceId: request.workspaceId,
        principalId,
        authorizationEpoch: request.authorizationEpoch,
        jurisdiction: deps.jurisdiction,
      }),
    },
    command,
    request,
  );
  if (!outcome.ok || outcome.replayed) rejectRunnerRequest();
  return outcome.result;
}

/** Called only after browser session and CSRF validation by the shared browser router. */
export async function handleRunnerBrowserApi(
  request: Request,
  deps: RunnerApiDeps & { principal: BrowserPrincipal; workspaceId: string },
): Promise<Response> {
  try {
    const workspaceId = runnerId(deps.workspaceId);
    const path = new URL(request.url).pathname;
    const prefix = `/api/v1/workspaces/${workspaceId}/runners`;
    await budget(request, deps, `${workspaceId}:${deps.principal.humanId}`, "approval");
    const principal = await loadPrincipal(deps.db, workspaceId, deps.principal.humanId);
    if (request.method === "GET" && path === prefix)
      return response({ runners: await listRunners(deps.db, principal) });
    if (request.method !== "POST") return rejected();
    const body = await readBoundedJson(request, RUNNER_BODY_LIMIT);
    const common = {
      workspaceId,
      actorHumanId: principal.humanId,
      authorizationEpoch: principal.authorizationEpoch,
      now: deps.now,
      idempotencyKey: randomUlid(),
    };
    if (path === prefix) {
      const input = runnerObject(body, [
        "runner_id",
        "device_label",
        "public_key",
        "project_ids",
        "step_up_proof_id",
      ]);
      const result = await execute(deps, enrollRunnerCommand, {
        ...common,
        input: {
          runnerId: input.runner_id,
          deviceLabel: input.device_label,
          publicKey: input.public_key,
          projectIds: input.project_ids,
          stepUpProofId: input.step_up_proof_id,
        } as Parameters<typeof enrollRunnerCommand.run>[0],
      });
      return response({ runner: result }, 201);
    }
    const tail = path.slice(prefix.length).match(/^\/([^/]+)\/(grants|revoke)$/);
    if (!path.startsWith(prefix) || !tail?.[1]) return rejected();
    const runner = runnerId(tail[1]);
    if (tail[2] === "grants") {
      const input = runnerObject(body, [
        "expected_grant_epoch",
        "project_ids",
        "launcher_human_ids",
        "step_up_proof_id",
      ]);
      return response(
        await execute(deps, replaceRunnerGrantsCommand, {
          ...common,
          input: {
            runnerId: runner,
            expectedGrantEpoch: input.expected_grant_epoch,
            projectIds: input.project_ids,
            launcherHumanIds: input.launcher_human_ids,
            stepUpProofId: input.step_up_proof_id,
          } as Parameters<typeof replaceRunnerGrantsCommand.run>[0],
        }),
      );
    }
    const input = runnerObject(body, ["step_up_proof_id"]);
    return response(
      await execute(deps, revokeRunnerCommand, {
        ...common,
        input: { runnerId: runner, stepUpProofId: runnerId(input.step_up_proof_id) },
      }),
    );
  } catch {
    return rejected();
  }
}

function channelTarget(request: Request): {
  workspaceId: string;
  runnerId: string;
  action: string;
} {
  const url = new URL(request.url);
  const match =
    /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/(challenge|token|authenticate)$/.exec(
      url.pathname,
    );
  if (url.search || !match?.[1] || !match[2] || !match[3]) rejectRunnerRequest();
  return { workspaceId: runnerId(match[1]), runnerId: runnerId(match[2]), action: match[3] };
}

function rejectBrowserCredentials(request: Request, appOrigin: string): void {
  const url = new URL(request.url);
  if (
    url.origin !== appOrigin ||
    request.headers.has("cookie") ||
    request.headers.has("origin") ||
    request.headers.has("authorization")
  )
    rejectRunnerRequest();
}

/** Native endpoints reject cookies and browser Origins; they never create human credentials. */
export async function handleRunnerNativeApi(
  request: Request,
  deps: RunnerApiDeps,
): Promise<Response> {
  try {
    const target = channelTarget(request);
    await budget(request, deps, `${target.workspaceId}:${target.runnerId}`, target.action);
    rejectBrowserCredentials(request, deps.appOrigin);
    if (request.method !== "POST") return rejected();
    const body = await readBoundedJson(request, RUNNER_BODY_LIMIT);
    const common = {
      workspaceId: target.workspaceId,
      authorizationEpoch: 1,
      now: deps.now,
      idempotencyKey: randomUlid(),
    };
    if (target.action === "challenge") {
      const input = runnerObject(body, ["purpose", "token", "request"]);
      const nonce = runnerSecret();
      const result = await execute(deps, issueRunnerChallengeCommand, {
        ...common,
        actorSystemId: RUNNER_CHALLENGE_ISSUER_ID,
        input: {
          runnerId: target.runnerId,
          nonceHash: runnerHash(nonce),
          origin: deps.appOrigin,
          purpose: input.purpose,
          ...(input.token === undefined ? {} : { token: input.token }),
          ...(input.request === undefined ? {} : { request: input.request }),
        } as Parameters<typeof issueRunnerChallengeCommand.run>[0],
      });
      return response({ challenge: { ...result, server_nonce: nonce } });
    }
    const input = runnerObject(
      body,
      target.action === "token"
        ? ["challenge_id", "server_nonce", "signature"]
        : ["challenge_id", "server_nonce", "signature", "token"],
    );
    const proof: RunnerProofInput = {
      runnerId: target.runnerId,
      challengeId: input.challenge_id as string,
      serverNonce: input.server_nonce as string,
      signature: input.signature as string,
      origin: deps.appOrigin,
    };
    if (target.action === "token") {
      const secret = runnerSecret();
      const result = await execute(deps, exchangeRunnerTokenCommand, {
        ...common,
        actorRunnerId: target.runnerId,
        input: { ...proof, tokenSecretHash: runnerHash(secret) },
      });
      return response({
        token: encodeRunnerToken(result.claims, secret),
        token_type: "bfb-runner-pop",
        expires_at: new Date(result.claims.exp * 1000).toISOString(),
      });
    }
    // This diagnostic proves possession only for this endpoint and cannot be reused
    // as a credential. Real channel/HTTPS handlers call authenticateRunnerRequest.
    const binding = {
      method: "POST",
      path: new URL(request.url).pathname,
      body_sha256: runnerHash(""),
    };
    const principal = await authenticateRunnerRequest(
      deps,
      target.workspaceId,
      proof,
      input.token as string,
      binding,
    );
    return response({ principal });
  } catch {
    return rejected();
  }
}

/** L08/E01 pass the actual server-observed method/path/business-body digest, never a caller's binding. */
export async function authenticateRunnerRequest(
  deps: RunnerApiDeps,
  workspaceId: string,
  proof: RunnerProofInput,
  token: string,
  actualRequest: RunnerRequestBinding,
): Promise<RunnerPrincipal> {
  return execute(deps, authenticateRunnerRequestCommand, {
    workspaceId,
    actorRunnerId: proof.runnerId,
    authorizationEpoch: 1,
    now: deps.now,
    idempotencyKey: randomUlid(),
    input: { ...proof, origin: deps.appOrigin, token, request: actualRequest },
  });
}
