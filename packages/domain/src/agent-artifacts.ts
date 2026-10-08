// ABOUTME: Publishes agent-run artifacts through canonical operation recovery and shared artifact effects.
// ABOUTME: Current authority precedes private metadata/conflicts; only ephemeral transport responses contain upload secrets.

import {
  decodeWireDocument,
  type AgentArtifactRequest,
  type AgentArtifactPrepareResult,
  type AgentArtifactResult,
} from "@bfb/protocol";
import { agentWorkKey } from "./agent-work.js";
import { prepareAgentArtifactAuthority } from "./artifact-agent-authority.js";
import {
  prepareArtifactVersion,
  persistArtifactVersion,
  issueArtifactUploadGrant,
  prepareArtifactFinalization,
  persistArtifactFinalization,
  issueGrantResponse,
  type ArtifactGrant,
  type ArtifactVersionRow,
} from "./artifacts.js";
import { DomainError, type HubCommand, type HubContext } from "./hub.js";
import { canonicalLaunchJson, guardLaunchMutation } from "./launch-state.js";
import { runnerHash, runnerObject } from "./runner-crypto.js";
import type { RunnerPrincipal } from "./runners.js";

export const AGENT_ARTIFACT_REQUEST_BYTES = 4096;
export interface AgentArtifactInput {
  principal: RunnerPrincipal;
  request: AgentArtifactRequest;
}
export interface AgentArtifactPrepareInput extends AgentArtifactInput {
  grantSecretHash: string;
}
export type AgentArtifactPrepared = Omit<AgentArtifactPrepareResult, "upload"> & {
  upload: ArtifactGrant | null;
};
interface Publication {
  operation_key: string;
  input_fingerprint: string;
  artifact_id: string;
  version_id: string;
  run_id: string;
  execution_id: string;
  assignment_generation: number;
  provider_session_id: string;
  runner_id: string;
  project_id: string;
  source_task_id: string;
}

function checked(input: AgentArtifactInput, prepare = false): AgentArtifactRequest {
  runnerObject(
    input,
    prepare ? ["principal", "request", "grantSecretHash"] : ["principal", "request"],
  );
  const raw = Buffer.from(JSON.stringify(input.request));
  const decoded = decodeWireDocument("agent-artifact-request", raw);
  if (raw.length > AGENT_ARTIFACT_REQUEST_BYTES || !decoded.ok)
    throw new DomainError("request_rejected", "invalid artifact metadata");
  return decoded.value as AgentArtifactRequest;
}
const fingerprint = (request: AgentArtifactRequest) => runnerHash(canonicalLaunchJson(request));
const origin = (operation: Publication) => ({
  run_id: operation.run_id,
  run_execution_id: operation.execution_id,
  assignment_generation: operation.assignment_generation,
  provider_session_id: operation.provider_session_id,
});

async function authorized(input: AgentArtifactInput, ctx: HubContext, prepare = false) {
  const request = checked(input, prepare);
  const authority = await prepareAgentArtifactAuthority(
    ctx,
    input.principal,
    request.reference,
    request.binding,
  );
  const key = agentWorkKey("publish_artifact", request.reference);
  const operation = (await ctx.db
    .prepare("SELECT * FROM artifact_agent_operations WHERE workspace_id=? AND operation_key=?")
    .get(ctx.workspaceId, key)) as Publication | undefined;
  if (operation) {
    const row = authority.row;
    if (
      operation.run_id !== row.run_id ||
      operation.execution_id !== row.execution_id ||
      operation.assignment_generation !== row.assignment_generation ||
      operation.runner_id !== row.runner_id ||
      operation.project_id !== row.project_id ||
      operation.source_task_id !== row.task_id ||
      operation.provider_session_id !== request.binding.provider_session_id
    )
      throw new DomainError("boundary_escape", "artifact operation origin differs");
    if (operation.input_fingerprint !== fingerprint(request))
      throw new DomainError("request_conflict", "artifact input differs from original operation");
  }
  return { request, ...authority, key, operation };
}
const auditInput = (input: AgentArtifactInput) => ({
  operationKey: agentWorkKey("publish_artifact", input.request.reference),
  requestId: input.request.reference.request_id,
  executionId: input.request.reference.run_execution_id,
  generation: input.request.reference.assignment_generation,
  inputHash: fingerprint(input.request),
});
const auditResult = (result: AgentArtifactPrepared | AgentArtifactResult) => ({
  operationKey: result.operation_key,
  artifactId: result.artifact_id,
  versionId: result.version_id,
  format: result.format,
  role: result.role,
  contentHash: result.content_hash,
  size: result.size,
  origin: result.origin,
  ...("stage" in result ? { stage: result.stage } : { state: result.state }),
});
function metadata(operation: Publication, request: AgentArtifactRequest) {
  return {
    schema_version: 1 as const,
    operation_key: operation.operation_key,
    artifact_id: operation.artifact_id,
    version_id: operation.version_id,
    format: request.format,
    role: request.role,
    content_hash: request.expected_digest,
    size: request.declared_size,
    origin: origin(operation),
  };
}

export const agentArtifactPrepareCommand: HubCommand<
  AgentArtifactPrepareInput,
  AgentArtifactPrepared
> = {
  name: "artifact.agent_prepare",
  replay: "reject",
  auditInput,
  auditResult,
  inputFingerprint: (input) => fingerprint(input.request),
  authorize: async (input, ctx) => {
    await authorized(input, ctx, true);
  },
  async run(input, ctx) {
    const { request, row, key, witness, operation: existing } = await authorized(input, ctx, true);
    if (typeof input.grantSecretHash !== "string" || !/^[0-9a-f]{64}$/.test(input.grantSecretHash))
      throw new DomainError("request_rejected", "invalid grant hash");
    let plan: Awaited<ReturnType<typeof prepareArtifactVersion>> | undefined;
    let operation = existing;
    if (!operation) {
      plan = await prepareArtifactVersion(ctx.db, ctx.workspaceId, {
        ...(request.artifact_id === undefined ? {} : { artifactId: request.artifact_id }),
        runId: row.run_id,
        format: request.format,
        role: request.role,
        declaredSize: request.declared_size,
        expectedDigest: request.expected_digest,
      });
      operation = {
        operation_key: key,
        input_fingerprint: fingerprint(request),
        artifact_id: plan.artifactId,
        version_id: plan.versionId,
        run_id: row.run_id,
        execution_id: row.execution_id,
        assignment_generation: row.assignment_generation,
        provider_session_id: request.binding.provider_session_id,
        runner_id: row.runner_id,
        project_id: row.project_id,
        source_task_id: row.task_id,
      };
    }
    if (existing) {
      const version = (await ctx.db
        .prepare("SELECT * FROM artifact_versions WHERE workspace_id=? AND id=?")
        .get(ctx.workspaceId, operation.version_id)) as ArtifactVersionRow | undefined;
      if (!version || !["uploading", "available"].includes(version.state))
        throw new DomainError("invalid_transition", "artifact version is not publishable");
      const receipt = await ctx.db
        .prepare(
          "SELECT version_id FROM artifact_upload_receipts WHERE workspace_id=? AND version_id=?",
        )
        .get(ctx.workspaceId, version.id);
      if (receipt || version.state === "available") {
        const verified = await prepareArtifactFinalization(
          ctx.db,
          ctx.workspaceId,
          {
            versionId: version.id,
            contentHash: request.expected_digest,
            size: request.declared_size,
          },
          true,
        );
        await guardLaunchMutation(ctx, witness.predicate, witness.params);
        return {
          ...metadata(operation, request),
          stage: verified.version.state === "available" ? "available" : "finalize_required",
          upload: null,
          available_at: verified.version.available_at,
        };
      }
    }
    // All reads are complete before version, source, grant and receipt effects.
    if (plan) {
      await persistArtifactVersion(ctx, plan, null);
      await ctx.db
        .prepare(
          `INSERT INTO artifact_agent_operations
        (workspace_id,operation_key,input_fingerprint,artifact_id,version_id,run_id,execution_id,assignment_generation,
         provider_session_id,runner_id,project_id,source_task_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          ctx.workspaceId,
          key,
          operation.input_fingerprint,
          operation.artifact_id,
          operation.version_id,
          operation.run_id,
          operation.execution_id,
          operation.assignment_generation,
          operation.provider_session_id,
          operation.runner_id,
          operation.project_id,
          operation.source_task_id,
          ctx.now,
        );
    }
    const grant = await issueArtifactUploadGrant(ctx, {
      versionId: operation.version_id,
      runId: row.run_id,
      humanId: null,
      authorizationEpoch: input.principal.authorizationEpoch,
      format: request.format,
      role: request.role,
      declaredSize: request.declared_size,
      expectedDigest: request.expected_digest,
      grantSecretHash: input.grantSecretHash,
      reissued: !plan,
    });
    await ctx.db
      .prepare(
        `INSERT INTO artifact_agent_grants (workspace_id,grant_id,operation_key,version_id,principal_json)
      VALUES (?,?,?,?,?)`,
      )
      .run(
        ctx.workspaceId,
        grant.grant_id,
        key,
        operation.version_id,
        canonicalLaunchJson(input.principal),
      );
    await guardLaunchMutation(ctx, witness.predicate, witness.params);
    return {
      ...metadata(operation, request),
      stage: "upload_required",
      upload: grant,
      available_at: null,
    };
  },
};

export function agentArtifactPrepareProjection(
  prepared: AgentArtifactPrepared,
  artifactOrigin: string,
  secret: string,
): AgentArtifactPrepareResult {
  const upload = prepared.upload ? issueGrantResponse(prepared.upload, secret) : null;
  const result = {
    ...prepared,
    upload: upload
      ? {
          origin: artifactOrigin,
          grant_id: upload.grant_id,
          secret: upload.secret,
          expires_at: upload.expires_at,
        }
      : null,
  };
  const bytes = Buffer.from(JSON.stringify(result));
  const decoded = decodeWireDocument("agent-artifact-prepare-result", bytes);
  if (bytes.length > 4096 || !decoded.ok)
    throw new DomainError("request_rejected", "invalid artifact preparation projection");
  return decoded.value as AgentArtifactPrepareResult;
}

export const agentArtifactFinalizeCommand: HubCommand<AgentArtifactInput, AgentArtifactResult> = {
  name: "artifact.agent_finalize",
  auditInput,
  auditResult,
  inputFingerprint: (input) => fingerprint(input.request),
  authorize: async (input, ctx) => {
    await authorized(input, ctx);
  },
  async run(input, ctx) {
    const { request, operation, witness } = await authorized(input, ctx);
    if (!operation) throw new DomainError("not_found", "artifact operation not prepared");
    const plan = await prepareArtifactFinalization(
      ctx.db,
      ctx.workspaceId,
      {
        versionId: operation.version_id,
        contentHash: request.expected_digest,
        size: request.declared_size,
      },
      true,
    );
    const available = await persistArtifactFinalization(ctx, plan);
    await guardLaunchMutation(ctx, witness.predicate, witness.params);
    const result = {
      ...metadata(operation, request),
      state: "available" as const,
      available_at: available.available_at,
    };
    const bytes = Buffer.from(JSON.stringify(result));
    if (bytes.length > 2048 || !decodeWireDocument("agent-artifact-result", bytes).ok)
      throw new DomainError("request_rejected", "invalid artifact result");
    return result;
  },
};
