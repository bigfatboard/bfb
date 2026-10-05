// ABOUTME: Routes fixed local-agent reads through runner possession and serialized domain authority.
// ABOUTME: Rejects browser credentials, claimed boundaries and arbitrary HTTP proxy actions.

import { createAuthorizationContext } from "@bfb/db";
import { decodeWireDocument, type AgentWorkRequest } from "@bfb/protocol";
import {
  agentRunAuthorityCommand,
  agentRunContextCommand,
  agentRunTaskCommand,
  agentWorkKey,
  DomainError,
  runnerId,
  type AgentWorkInput,
  type HubCommand,
} from "@bfb/domain";
import { executeWorkspaceCommand } from "../hub-client.js";
import { guardRunnerTransport, readPossessedRunnerRequest, type RunnerApiDeps } from "./runners.js";

const pattern = /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/work\/(authority|context|task)$/;
export function isAgentWorkPath(path: string): boolean {
  return pattern.test(path);
}
function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" },
  });
}

export async function handleAgentWorkApi(request: Request, deps: RunnerApiDeps): Promise<Response> {
  try {
    const url = new URL(request.url),
      match = pattern.exec(url.pathname);
    if (!match || url.search || request.method !== "POST")
      throw new DomainError("request_rejected", "invalid work action");
    const workspaceId = runnerId(match[1]),
      runner = runnerId(match[2]),
      action = match[3]!;
    await guardRunnerTransport(request, deps, workspaceId, runner, `work/${action}`);
    const possessed = await readPossessedRunnerRequest(request, deps, workspaceId, runner, 2048);
    const decoded = decodeWireDocument("agent-work-request", possessed.bytes);
    if (!decoded.ok) throw new DomainError("request_rejected", "invalid work reference");
    const body = decoded.value as AgentWorkRequest;
    const command = (
      action === "context"
        ? agentRunContextCommand
        : action === "task"
          ? agentRunTaskCommand
          : agentRunAuthorityCommand
    ) as HubCommand<AgentWorkInput, unknown>;
    const outcome = await executeWorkspaceCommand(
      {
        db: deps.db,
        workspaceHubNs: deps.workspaceHubNs,
        authorization: createAuthorizationContext({
          workspaceId,
          principalId: runner,
          authorizationEpoch: possessed.principal.authorizationEpoch,
          jurisdiction: deps.jurisdiction,
        }),
      },
      command,
      {
        workspaceId,
        actorRunnerId: runner,
        authorizationEpoch: possessed.principal.authorizationEpoch,
        idempotencyKey: agentWorkKey(action, body),
        input: { principal: possessed.principal, request: body },
      },
    );
    if (!outcome.ok) throw new DomainError(outcome.error.code, "agent work rejected");
    return response(outcome.result);
  } catch (error) {
    // A classified domain denial is not a network outage or queue permission.
    const allowed = [
      "revoked",
      "assignment_ended",
      "capability_closed",
      "boundary_escape",
      "forbidden",
      "not_found",
      "request_rejected",
    ];
    if (error instanceof DomainError && error.code === "body_too_large") {
      return response({ error: "request_rejected", message: "agent work rejected" }, 403);
    }
    if (error instanceof DomainError && allowed.includes(error.code)) {
      return response({ error: error.code, message: "agent work rejected" }, 403);
    }
    if (error instanceof SyntaxError)
      return response({ error: "request_rejected", message: "agent work rejected" }, 403);
    return response(
      { error: "work_unavailable", message: "agent work temporarily unavailable" },
      503,
    );
  }
}
