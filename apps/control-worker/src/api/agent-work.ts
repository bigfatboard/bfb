// ABOUTME: Routes fixed local-agent work through runner possession and serialized domain authority.
// ABOUTME: Rejects browser credentials, claimed boundaries and arbitrary HTTP proxy actions.

import { createAuthorizationContext } from "@bfb/db";
import {
  decodeWireDocument,
  type AgentWorkRequest,
  type AgentBoundRequest,
  type AgentCommentRequest,
  type AgentSessionBindRequest,
  type AgentUpdateRequest,
  type AgentProgressRequest,
  type AgentProposalRequest,
  type AgentCaptureConfirmationRequest,
  type AgentWorkReplayRequest,
  type AgentAttentionRequest,
  type AgentAttentionReadRequest,
  type AgentResultRequest,
  type AgentResultConfirmationRequest,
  type AgentResultReplayRequest,
  type AgentArtifactRequest,
  type WireDocumentName,
} from "@bfb/protocol";
import {
  agentRunAuthorityCommand,
  agentRunContextCommand,
  agentRunTaskCommand,
  bindAgentSessionCommand,
  agentBoundAuthorityCommand,
  agentRunCommentCommand,
  agentRunUpdateCommand,
  agentRunProgressCommand,
  agentRunProposalCommand,
  agentCaptureConfirmationCommand,
  agentCaptureConfirmationKey,
  agentWriteAction,
  AGENT_CONFIRMATION_REQUEST_BYTES,
  AGENT_REPLAY_REQUEST_BYTES,
  AGENT_WRITE_REQUEST_BYTES,
  agentWorkKey,
  agentSessionBindKey,
  requestAttentionCommand,
  agentAttentionResult,
  readAgentAttention,
  type AttentionRecord,
  DomainError,
  runnerId,
  type HubCommand,
  submitResultCommand,
  resultCaptureConfirmationCommand,
  resultConfirmationKey,
  agentResultProjection,
  AGENT_RESULT_REQUEST_BYTES,
  AGENT_RESULT_REPLAY_BYTES,
  type SubmitResultResult,
  agentArtifactPrepareCommand,
  agentArtifactFinalizeCommand,
  agentArtifactPrepareProjection,
  AGENT_ARTIFACT_REQUEST_BYTES,
  type AgentArtifactPrepared,
  mintUploadGrantSecret,
  randomUlid,
} from "@bfb/domain";
import { executeWorkspaceCommand } from "../hub-client.js";
import { guardRunnerTransport, readPossessedRunnerRequest, type RunnerApiDeps } from "./runners.js";

const pattern =
  /^\/runner\/workspaces\/([^/]+)\/runners\/([^/]+)\/work\/(authority|context|task|session-bind|bound-authority|comment|update|progress|proposal|capture-confirmation|replay|attention-request|attention-get|result-submit|result-confirmation|result-replay|artifact-prepare|artifact-finalize)$/;
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
  update: {
    document: "agent-update-request",
    command: agentRunUpdateCommand as HubCommand<unknown, unknown>,
  },
  progress: {
    document: "agent-progress-request",
    command: agentRunProgressCommand as HubCommand<unknown, unknown>,
  },
  proposal: {
    document: "agent-proposal-request",
    command: agentRunProposalCommand as HubCommand<unknown, unknown>,
  },
  "capture-confirmation": {
    document: "agent-capture-confirmation-request",
    command: agentCaptureConfirmationCommand as HubCommand<unknown, unknown>,
  },
  "attention-request": {
    document: "agent-attention-request",
    command: requestAttentionCommand as HubCommand<unknown, unknown>,
  },
  "result-submit": {
    document: "agent-result-request",
    command: submitResultCommand as HubCommand<unknown, unknown>,
  },
  "result-confirmation": {
    document: "agent-result-confirmation-request",
    command: resultCaptureConfirmationCommand as HubCommand<unknown, unknown>,
  },
  "artifact-prepare": {
    document: "agent-artifact-request",
    command: agentArtifactPrepareCommand as HubCommand<unknown, unknown>,
  },
  "artifact-finalize": {
    document: "agent-artifact-request",
    command: agentArtifactFinalizeCommand as HubCommand<unknown, unknown>,
  },
};
const replayCommands = {
  "agent_run.comment": agentRunCommentCommand,
  "agent_run.update": agentRunUpdateCommand,
  "agent_run.progress": agentRunProgressCommand,
  "agent_run.proposal": agentRunProposalCommand,
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
  let artifactAction = false;
  try {
    const url = new URL(request.url),
      match = pattern.exec(url.pathname);
    if (!match || url.search || request.method !== "POST")
      throw new DomainError("request_rejected", "invalid work action");
    const workspaceId = runnerId(match[1]),
      runner = runnerId(match[2]),
      action = match[3]!;
    artifactAction = action === "artifact-prepare" || action === "artifact-finalize";
    await guardRunnerTransport(request, deps, workspaceId, runner, `work/${action}`);
    const document =
      action === "replay"
        ? "agent-work-replay-request"
        : action === "result-replay"
          ? "agent-result-replay-request"
          : action === "attention-get"
            ? "agent-attention-read-request"
            : actions[action]!.document;
    const possessed = await readPossessedRunnerRequest(
      request,
      deps,
      workspaceId,
      runner,
      artifactAction
        ? AGENT_ARTIFACT_REQUEST_BYTES
        : action === "result-replay"
          ? AGENT_RESULT_REPLAY_BYTES
          : action === "result-submit"
            ? AGENT_RESULT_REQUEST_BYTES
            : action === "replay"
              ? AGENT_REPLAY_REQUEST_BYTES
              : document === "agent-work-request" ||
                  action === "capture-confirmation" ||
                  action === "result-confirmation"
                ? AGENT_CONFIRMATION_REQUEST_BYTES
                : AGENT_WRITE_REQUEST_BYTES,
    );
    const decoded = decodeWireDocument(document, possessed.bytes);
    if (!decoded.ok) throw new DomainError("request_rejected", "invalid work reference");
    if (action === "attention-get") {
      return response(
        await readAgentAttention(deps.db, workspaceId, {
          principal: possessed.principal,
          request: decoded.value as AgentAttentionReadRequest,
        }),
      );
    }
    let command: HubCommand<unknown, unknown>, idempotencyKey: string, input: unknown;
    let artifactSecret: string | undefined;
    if (action === "result-replay") {
      const replay = decoded.value as AgentResultReplayRequest;
      command = submitResultCommand as HubCommand<unknown, unknown>;
      idempotencyKey = agentWorkKey("submit_result", replay.original_request.reference);
      input = {
        principal: possessed.principal,
        request: replay.original_request,
        replayCapture: replay.capture,
      };
    } else if (action === "replay") {
      const replay = decoded.value as AgentWorkReplayRequest;
      command = replayCommands[replay.command_name] as HubCommand<unknown, unknown>;
      idempotencyKey = agentWorkKey(
        agentWriteAction(replay.command_name),
        replay.original_request.reference,
      );
      input = {
        principal: possessed.principal,
        request: replay.original_request,
        replayCapture: replay.capture,
      };
    } else {
      const body = decoded.value as
        | AgentWorkRequest
        | AgentBoundRequest
        | AgentSessionBindRequest
        | AgentCommentRequest
        | AgentUpdateRequest
        | AgentProgressRequest
        | AgentProposalRequest
        | AgentAttentionRequest
        | AgentResultRequest
        | AgentArtifactRequest
        | AgentResultConfirmationRequest
        | AgentCaptureConfirmationRequest;
      const reference = "reference" in body ? body.reference : body;
      command = actions[action]!.command;
      idempotencyKey =
        action === "session-bind"
          ? agentSessionBindKey(reference)
          : action === "capture-confirmation"
            ? agentCaptureConfirmationKey(body as AgentCaptureConfirmationRequest)
            : action === "result-confirmation"
              ? resultConfirmationKey(body as AgentResultConfirmationRequest)
              : action === "result-submit"
                ? agentWorkKey("submit_result", reference)
                : agentWorkKey(action, reference);
      input = { principal: possessed.principal, request: body };
      if (action === "artifact-prepare") {
        // Each explicit retry gets a fresh ephemeral grant attempt. The domain
        // retains the independent canonical publication key, never this secret.
        if (!deps.artifactOrigin) throw new Error("artifact origin unavailable");
        const minted = mintUploadGrantSecret();
        artifactSecret = minted.secret;
        idempotencyKey = `artifact-prepare:${randomUlid()}`;
        input = {
          principal: possessed.principal,
          request: body,
          grantSecretHash: minted.secretHash,
        };
      } else if (action === "artifact-finalize") {
        idempotencyKey = agentWorkKey("publish_artifact", reference);
      }
    }
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
        idempotencyKey,
        input,
      },
    );
    if (!outcome.ok) throw new DomainError(outcome.error.code, "agent work rejected");
    if (action === "artifact-prepare") {
      return response(
        agentArtifactPrepareProjection(
          outcome.result as AgentArtifactPrepared,
          deps.artifactOrigin!,
          artifactSecret!,
        ),
      );
    }
    if (action === "artifact-finalize") {
      const result = decodeWireDocument(
        "agent-artifact-result",
        new TextEncoder().encode(JSON.stringify(outcome.result)),
      );
      if (!result.ok) throw new Error("invalid artifact projection");
      return response(result.value);
    }
    return response(
      action === "result-submit" || action === "result-replay"
        ? agentResultProjection(outcome.result as SubmitResultResult)
        : action === "attention-request"
          ? agentAttentionResult(
              outcome.result as AttentionRecord,
              (decoded.value as AgentAttentionRequest).binding,
            )
          : outcome.result,
    );
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
      "invalid_transition",
      "child_limit",
      "capture_invalid",
      "intent_expired",
    ];
    if (error instanceof DomainError && error.code === "body_too_large") {
      return response({ error: "request_rejected", message: "agent work rejected" }, 403);
    }
    if (artifactAction && error instanceof DomainError && error.code === "request_conflict") {
      return response({ error: "request_conflict", message: "agent work rejected" }, 403);
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
