// ABOUTME: Routes bounded launch and control requests through the existing authenticated WorkspaceHub lane.
// ABOUTME: Raw wake identifiers stay at the response/request boundary and never enter logs or domain envelopes.

import { createHmac } from "node:crypto";

import {
  abuseBucketKey,
  acknowledgeRunControlCommand,
  authorizeLaunchCommand,
  claimLaunchCommand,
  claimRunControlCommand,
  cloudWakeVerifier,
  consumeAbuseBudget,
  createCloudWakeIdentifier,
  createRunControlCommand,
  issueLaunchWakeCommand,
  LAUNCH_BODY_LIMIT,
  loadPrincipal,
  observeCheckoutLeaseCommand,
  randomUlid,
  readRunnerControl,
  redeemLaunchWakeCommand,
  rejectLaunchCommand,
  rejectRunnerRequest,
  runnerId,
  startLaunchCommand,
  tightenLaunchCommand,
  type HubCommand,
} from "@bfb/domain";
import {
  decodeWireDocument,
  type CheckoutLeaseObservation,
  type LaunchClaim,
  type LaunchFinalRequest,
  type LaunchRejectRequest,
  type LaunchStartRequest,
  type LaunchTightenRequest,
  type LaunchWakeRedemption,
  type LaunchWakeRequest,
  type RunControlClaim,
  type RunControlDisposition,
  type RunControlReference,
  type RunControlRequest,
  type WireDocumentName,
} from "@bfb/protocol";

import type { BrowserPrincipal } from "../auth/session.js";
import { readBoundedBytes } from "./request.js";
import {
  executeRunnerCommand,
  guardRunnerTransport,
  readPossessedRunnerRequest,
  type RunnerApiDeps,
} from "./runners.js";

const nativePattern =
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/(launch\/(?:claim|authorize|reject|tighten)|wake\/redeem|controls\/(?:read|claim|acknowledge)|leases\/observe)$/;

export function isRunnerLaunchPath(path: string): boolean {
  return nativePattern.test(path);
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
function decode<T>(document: WireDocumentName, bytes: Uint8Array): T {
  const result = decodeWireDocument(document, bytes);
  if (!result.ok) rejectRunnerRequest();
  return result.value as T;
}

async function browserBudget(
  request: Request,
  deps: RunnerApiDeps,
  humanId: string,
): Promise<void> {
  if (deps.abuseSecret.length < 32) rejectRunnerRequest();
  const policy = {
    attemptLimit: 20,
    pollLimit: 60,
    windowSeconds: 60,
    maxBodyBytes: LAUNCH_BODY_LIMIT,
  };
  for (const [subject, source] of [
    ["all", `launch-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`],
    [humanId, "launch-human"],
  ]) {
    const decision = await consumeAbuseBudget(
      deps.db,
      {
        bucketKey: abuseBucketKey({
          ipHashSeed: createHmac("sha256", deps.abuseSecret).update(source!).digest("hex"),
          subject: subject!,
          surface: "launch-browser",
        }),
        activity: "attempt",
        bodyBytes: 0,
        now: deps.now,
        expiresAt: new Date(Date.parse(deps.now) + 60_000).toISOString(),
      },
      policy,
    );
    if (!decision.allowed) rejectRunnerRequest();
  }
}

/** The mounted browser router has already checked the human session, origin and CSRF token. */
export async function handleLaunchBrowserApi(
  request: Request,
  deps: RunnerApiDeps & { principal: BrowserPrincipal; workspaceId: string },
): Promise<Response> {
  try {
    const url = new URL(request.url),
      workspaceId = runnerId(deps.workspaceId);
    await browserBudget(request, deps, deps.principal.humanId);
    if (url.search || request.method !== "POST") rejectRunnerRequest();
    const prefix = `/api/v1/workspaces/${workspaceId}`;
    if (
      ![`${prefix}/launches`, `${prefix}/launches/wake`, `${prefix}/run-controls`].includes(
        url.pathname,
      )
    )
      rejectRunnerRequest();
    const bytes = await readBoundedBytes(request, LAUNCH_BODY_LIMIT);
    const human = await loadPrincipal(deps.db, workspaceId, deps.principal.humanId);
    const run = <I, R>(command: HubCommand<I, R>, input: I) =>
      executeRunnerCommand(deps, command, {
        workspaceId,
        actorHumanId: human.humanId,
        authorizationEpoch: human.authorizationEpoch,
        now: deps.now,
        idempotencyKey: randomUlid(),
        input,
      });
    if (url.pathname === `${prefix}/launches`)
      return response(
        await run(startLaunchCommand, decode<LaunchStartRequest>("launch-start-request", bytes)),
        201,
      );
    if (url.pathname === `${prefix}/run-controls`)
      return response(
        await run(createRunControlCommand, decode<RunControlRequest>("run-control-request", bytes)),
        201,
      );
    const input = decode<LaunchWakeRequest>("launch-wake-request", bytes);
    const identifier = createCloudWakeIdentifier();
    const issued = await run(issueLaunchWakeCommand, {
      launchId: input.launch_id,
      verifier: cloudWakeVerifier(identifier),
    });
    return response(
      { schema_version: 1, intent_kind: "cloud_wake", intent_id: identifier, ...issued },
      201,
    );
  } catch {
    return rejected();
  }
}

export async function handleLaunchNativeApi(
  request: Request,
  deps: RunnerApiDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url),
      match = nativePattern.exec(url.pathname);
    if (!match?.[1] || !match[2] || !match[3] || url.search) rejectRunnerRequest();
    const workspaceId = runnerId(match[1]),
      runner = runnerId(match[2]),
      action = match[3];
    await guardRunnerTransport(request, deps, workspaceId, runner, action);
    if (request.method !== "POST") rejectRunnerRequest();
    const { principal, bytes } = await readPossessedRunnerRequest(
      request,
      deps,
      workspaceId,
      runner,
      LAUNCH_BODY_LIMIT,
    );
    const run = <I, R>(command: HubCommand<I, R>, input: I) =>
      executeRunnerCommand(deps, command, {
        workspaceId,
        actorRunnerId: runner,
        authorizationEpoch: principal.authorizationEpoch,
        now: deps.now,
        idempotencyKey: randomUlid(),
        input,
      });
    switch (action) {
      case "launch/claim":
        return response(
          await run(claimLaunchCommand, {
            principal,
            claim: decode<LaunchClaim>("launch-claim", bytes),
          }),
        );
      case "launch/authorize":
        return response(
          await run(authorizeLaunchCommand, {
            principal,
            authorization: decode<LaunchFinalRequest>("launch-final-request", bytes),
          }),
        );
      case "leases/observe":
        return response(
          await run(observeCheckoutLeaseCommand, {
            principal,
            observation: decode<CheckoutLeaseObservation>("checkout-lease-observation", bytes),
          }),
        );
      case "controls/read":
        return response(
          await readRunnerControl(
            deps.db,
            principal,
            decode<RunControlReference>("run-control-reference", bytes),
            deps.now,
          ),
        );
      case "controls/claim":
        return response(
          await run(claimRunControlCommand, {
            principal,
            claim: decode<RunControlClaim>("run-control-claim", bytes),
          }),
        );
      case "controls/acknowledge":
        return response(
          await run(acknowledgeRunControlCommand, {
            principal,
            acknowledgement: decode<RunControlDisposition>("run-control-disposition", bytes),
          }),
        );
      case "wake/redeem": {
        const input = decode<LaunchWakeRedemption>("launch-wake-redemption", bytes);
        return response(
          await run(redeemLaunchWakeCommand, {
            principal,
            verifier: cloudWakeVerifier(input.wake_intent_id),
          }),
        );
      }
      case "launch/reject": {
        const input = decode<LaunchRejectRequest>("launch-reject-request", bytes);
        return response(
          await run(rejectLaunchCommand, {
            principal,
            launchId: input.launch_id,
            executionId: input.run_execution_id,
            assignmentGeneration: input.assignment_generation,
          }),
        );
      }
      case "launch/tighten": {
        const input = decode<LaunchTightenRequest>("launch-tighten-request", bytes);
        return response(
          await run(tightenLaunchCommand, {
            principal,
            launchId: input.launch_id,
            executionId: input.run_execution_id,
            assignmentGeneration: input.assignment_generation,
            fencingGeneration: input.fencing_generation,
            snapshotHash: input.config_snapshot_hash,
            repositoryConfigHash: input.repository_config_hash,
            document: input.document,
          }),
        );
      }
      default:
        return rejected();
    }
  } catch {
    return rejected();
  }
}
