// ABOUTME: Routes fixed local-agent work through runner possession and serialized domain authority.
// ABOUTME: Rejects browser credentials, claimed boundaries and arbitrary HTTP proxy actions.

import { createAuthorizationContext } from "@bfb/db";
import {
  decodeWireDocument,
  type AgentWorkRequest,
  type AgentBoundRequest,
  type AgentCommentRequest,
  type AgentSessionBindRequest,
  type WireDocumentName,
} from "@bfb/protocol";
import {
  agentRunAuthorityCommand,
  agentRunContextCommand,
  agentRunTaskCommand,
  bindAgentSessionCommand,
  agentBoundAuthorityCommand,
  agentRunCommentCommand,
  AGENT_WRITE_REQUEST_BYTES,
  agentWorkKey,
  agentSessionBindKey,
  DomainError,
  runnerId,
  type HubCommand,
} from "@bfb/domain";
import { executeWorkspaceCommand } from "../hub-client.js";
import { guardRunnerTransport, readPossessedRunnerRequest, type RunnerApiDeps } from "./runners.js";

const pattern =
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/work\/(authority|context|task|session-bind|bound-authority|comment)$/;
const actions: Record<
  string,
  { document: WireDocumentName; command: HubCommand<unknown, unknown> }
> = {
  authority: {
    document: "agent-work-request",
    command: agentRunAuthorityCommand as HubCommand<unknown, unknown>,
  },
  context: {
    document: "agent-work-request",
    command: agentRunContextCommand as HubCommand<unknown, unknown>,
  },
  task: {
    document: "agent-work-request",
    command: agentRunTaskCommand as HubCommand<unknown, unknown>,
  },
  "session-bind": {
    document: "agent-session-bind-request",
    command: bindAgentSessionCommand as HubCommand<unknown, unknown>,
  },
  "bound-authority": {
    document: "agent-bound-request",
    command: agentBoundAuthorityCommand as HubCommand<unknown, unknown>,
  },
  comment: {
    document: "agent-comment-request",
    command: agentRunCommentCommand as HubCommand<unknown, unknown>,
  },
};
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
    const operation = actions[action]!;
    const possessed = await readPossessedRunnerRequest(
      request,
      deps,
      workspaceId,
      runner,
      operation.document === "agent-work-request" ? 2048 : AGENT_WRITE_REQUEST_BYTES,
    );
    const decoded = decodeWireDocument(operation.document, possessed.bytes);
    if (!decoded.ok) throw new DomainError("request_rejected", "invalid work reference");
    const body = decoded.value as
      AgentWorkRequest | AgentBoundRequest | AgentSessionBindRequest | AgentCommentRequest;
    const reference = "reference" in body ? body.reference : body;
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
      operation.command,
      {
        workspaceId,
        actorRunnerId: runner,
        authorizationEpoch: possessed.principal.authorizationEpoch,
        idempotencyKey:
          action === "session-bind"
            ? agentSessionBindKey(reference)
            : agentWorkKey(action, reference),
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
      "session_not_bound",
      "session_conflict",
      "stale_version",
      "policy_rejected",
      "invalid_argument",
      "child_limit",
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
