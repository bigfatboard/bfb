// ABOUTME: Builds synthetic launch and policy scope with a real enrolled P-256 capture signer.
// ABOUTME: Uses production Hub binding and confirmation commands instead of injected capture authority.

import type { SqlDatabase } from "@bfb/db";
import type {
  AgentCaptureConfirmationRequest,
  AgentCaptureConfirmationResult,
  AgentSessionBindRequest,
  AgentWorkCapture,
  CheckoutLeaseObservation,
} from "@bfb/protocol";
import { canonicalAgentWriteRequest } from "@bfb/protocol";
import { authorizeSyntheticPolicyUpdate, FIX } from "../src/fixtures.js";
import {
  agentCaptureConfirmationKey,
  agentWriteAction,
  type AgentWriteCommandName,
  type AgentWriteRequest,
} from "../src/agent-capture.js";
import {
  agentCaptureConfirmationCommand,
  agentSessionBindKey,
  bindAgentSessionCommand,
} from "../src/agent-sessions.js";
import { agentWorkKey } from "../src/agent-work.js";
import { observeCheckoutLeaseCommand } from "../src/checkout-leases.js";
import { canonicalLaunchJson } from "../src/launch-state.js";
import { randomUlid } from "../src/ids.js";
import { authorizeLaunchCommand, tightenLaunchCommand } from "../src/launches.js";
import { OFFLINE_AGENT_TOOLS } from "../src/offline-agent-policy.js";
import {
  deniedOfflineAgentResults,
  type OfflineAgentResultsPolicy,
} from "../src/offline-result-policy.js";
import {
  updateWorkspacePolicyCommand,
  updateProjectPolicyCommand,
  reportRepositoryConfigCommand,
  repositoryConfigPolicyTarget,
  normalizeRepositoryConfig,
  getWorkspacePolicy,
  getProjectPolicy,
} from "../src/projects.js";
import {
  canonicalRunnerKey,
  runnerKeyThumbprint,
  runnerHash,
  runnerSecret,
  encodeRunnerToken,
  type RunnerTokenClaims,
} from "../src/runner-crypto.js";
import { issueStepUpProof } from "../src/step-up.js";
import { LAUNCH_NOW, launchFixture, success } from "./launch-fixture.js";

export async function captureFixture(
  database?: SqlDatabase,
  enabled = true,
  tightened = false,
  options: {
    offlineResults?: OfflineAgentResultsPolicy;
    taskCreatorHumanId?: string;
    requestingHumanId?: string;
  } = {},
) {
  const f = await launchFixture(
    database,
    options.taskCreatorHumanId ? { taskCreatorHumanId: options.taskCreatorHumanId } : {},
  );
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const publicKey = await canonicalRunnerKey({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const thumbprint = runnerKeyThumbprint(publicKey),
    secret = runnerSecret();
  const stored = (await f.db
    .prepare("SELECT claims_json FROM runner_tokens WHERE id = ?")
    .get(f.principal.tokenId)) as { claims_json: string };
  const claims: RunnerTokenClaims = { ...JSON.parse(stored.claims_json), cnf: { jkt: thumbprint } };
  await f.db
    .prepare("UPDATE runners SET public_key_json = ?, key_thumbprint = ? WHERE id = ?")
    .run(JSON.stringify(publicKey), thumbprint, f.runner);
  await f.db
    .prepare("UPDATE runner_tokens SET claims_json = ?, token_hash = ? WHERE id = ?")
    .run(JSON.stringify(claims), runnerHash(secret), f.principal.tokenId);
  f.principal.keyThumbprint = thumbprint;
  if (enabled || options.offlineResults !== undefined) {
    const permission = {
      allowed_tools: enabled ? [...OFFLINE_AGENT_TOOLS] : [],
      max_pending_age_seconds: enabled ? 300 : 0,
    };
    const policy = {
      allowedProviders: ["claude", "codex", "grok", "fake"],
      allowAgentRootPropose: true,
      allowPassToAgent: true,
      allowRunOverrides: true,
      offlineAgentWork: permission,
      offlineAgentResults: options.offlineResults ?? deniedOfflineAgentResults(),
    };
    for (const project of [false, true]) {
      const input = await authorizeSyntheticPolicyUpdate(
        f.db,
        { workspaceId: FIX.workspace, humanId: FIX.owner },
        {
          ...policy,
          expectedVersion: 2,
          ...(project ? { projectId: FIX.projectA } : {}),
        },
      );
      success(
        await f.human(project ? updateProjectPolicyCommand : updateWorkspacePolicyCommand, input),
      );
    }
    const document = {
      offline_agent_work: permission,
      ...(options.offlineResults === undefined
        ? {}
        : { offline_agent_results: options.offlineResults }),
    };
    const contentHash = `sha256:${runnerHash(normalizeRepositoryConfig(document, policy).canonical)}`;
    const stepUpProofId = await issueStepUpProof(
      f.db,
      FIX.owner,
      {
        action: "repository.config.report",
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        targetId: repositoryConfigPolicyTarget(FIX.workspace, FIX.projectA, 2, contentHash, policy),
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: "2026-09-12T12:01:00.000Z",
      },
      LAUNCH_NOW,
    );
    success(
      await f.human(reportRepositoryConfigCommand, {
        projectId: FIX.projectA,
        expectedVersion: 2,
        document,
        contentHash,
        stepUpProofId,
      }),
    );
    f.start.workspace_policy_version = 3;
    f.start.project_policy_version = 3;
    f.start.repository_config_version = 3;
    await f.refresh(LAUNCH_NOW, {
      checkouts: f
        .inventory()
        .checkouts.map((checkout) => ({ ...checkout, repository_config_hash: contentHash })),
    });
  }
  await f.db
    .prepare(
      "INSERT INTO runner_launch_grants (workspace_id, runner_id, human_id, granted_at) VALUES (?, ?, ?, ?)",
    )
    .run(FIX.workspace, f.runner, FIX.member, LAUNCH_NOW);
  const claimed = await f.claim(options.requestingHumanId ?? FIX.member);
  if (tightened) {
    const document = { allow_run_overrides: false };
    const repositoryConfigHash = `sha256:${runnerHash(JSON.stringify(document))}`;
    await f.refresh(LAUNCH_NOW, {
      checkouts: f.inventory().checkouts.map((checkout) => ({
        ...checkout,
        repository_config_hash: repositoryConfigHash,
      })),
    });
    const replacement = success(
      await f.native(tightenLaunchCommand, {
        principal: f.principal,
        launchId: claimed.launch.launch_id,
        executionId: claimed.final.run_execution_id,
        assignmentGeneration: claimed.final.assignment_generation,
        fencingGeneration: claimed.final.fencing_generation,
        snapshotHash: claimed.final.config_snapshot_hash,
        repositoryConfigHash,
        document,
      }),
    );
    claimed.final.config_snapshot_id = replacement.specification.config_snapshot_id;
    claimed.final.config_snapshot_hash = replacement.specification.config_snapshot_hash;
    claimed.final.repository_config_hash = repositoryConfigHash;
  }
  success(
    await f.native(authorizeLaunchCommand, {
      principal: f.principal,
      authorization: claimed.final,
    }),
  );
  let sequence = 0;
  async function renew(now = LAUNCH_NOW) {
    const observation: CheckoutLeaseObservation = {
      schema_version: 1,
      run_execution_id: claimed.final.run_execution_id,
      assignment_generation: claimed.final.assignment_generation,
      fencing_generation: claimed.final.fencing_generation,
      sequence: ++sequence,
      observed_at: now,
      operation: "renew",
      supervisor: claimed.final.supervisor,
      local_lock_id: claimed.final.local_lock_id,
      owned_group_id: 1235,
      owned_group_start_identity: "123456:2000",
      supervisor_state: "verified",
      group_state: "live",
      lock_state: "held",
      descendants_state: "contained",
      recovery_local: false,
    };
    success(
      await f.native(observeCheckoutLeaseCommand, { principal: f.principal, observation }, now),
    );
  }
  await renew();
  const reference = (requestId = randomUlid()) => ({
    schema_version: 1 as const,
    run_execution_id: claimed.final.run_execution_id,
    assignment_generation: claimed.final.assignment_generation,
    request_id: requestId,
  });
  const bind: AgentSessionBindRequest = {
    reference: reference(),
    observation: {
      provider: "fake",
      observed_session_id: "synthetic-capture-session",
      observed_at: LAUNCH_NOW,
    },
  };
  const binding = success(
    await f.hub.execute(bindAgentSessionCommand, {
      workspaceId: FIX.workspace,
      actorRunnerId: f.runner,
      authorizationEpoch: 1,
      idempotencyKey: agentSessionBindKey(bind.reference),
      input: { principal: f.principal, request: bind },
    }),
  ).binding;
  const confirmationRequest = (id = randomUlid()): AgentCaptureConfirmationRequest => ({
    schema_version: 1,
    request_id: id,
    run_execution_id: claimed.final.run_execution_id,
    assignment_generation: claimed.final.assignment_generation,
    binding,
  });
  const envelope = (request: AgentCaptureConfirmationRequest) => ({
    workspaceId: FIX.workspace,
    actorRunnerId: f.runner,
    authorizationEpoch: 1,
    idempotencyKey: agentCaptureConfirmationKey(request),
    input: { principal: f.principal, request },
  });
  const confirm = (request = confirmationRequest()) =>
    f.hub.execute(agentCaptureConfirmationCommand, envelope(request));
  const bound = (requestId = randomUlid()) => ({ reference: reference(requestId), binding });
  async function advancePolicy(tier: "workspace" | "project" | "repository") {
    if (tier !== "repository") {
      const { resourceVersion, ...settings } =
        tier === "workspace"
          ? await getWorkspacePolicy(f.db, FIX.workspace)
          : await getProjectPolicy(f.db, FIX.workspace, FIX.projectA);
      const input = await authorizeSyntheticPolicyUpdate(
        f.db,
        { workspaceId: FIX.workspace, humanId: FIX.owner },
        {
          ...settings,
          expectedVersion: resourceVersion,
          ...(tier === "project" ? { projectId: FIX.projectA } : {}),
        },
      );
      return success(
        await f.human(
          tier === "workspace" ? updateWorkspacePolicyCommand : updateProjectPolicyCommand,
          input,
        ),
      );
    }
    const row = (await f.db
      .prepare(
        "SELECT canonical_json, content_hash, resource_version FROM repository_configs WHERE workspace_id = ? AND project_id = ?",
      )
      .get(FIX.workspace, FIX.projectA)) as {
      canonical_json: string;
      content_hash: string;
      resource_version: number;
    };
    const document = JSON.parse(row.canonical_json);
    const permission = normalizeRepositoryConfig(
      document,
      await getProjectPolicy(f.db, FIX.workspace, FIX.projectA),
    ).settings;
    const stepUpProofId = await issueStepUpProof(
      f.db,
      FIX.owner,
      {
        action: "repository.config.report",
        workspaceId: FIX.workspace,
        projectId: FIX.projectA,
        targetId: repositoryConfigPolicyTarget(
          FIX.workspace,
          FIX.projectA,
          row.resource_version,
          row.content_hash,
          permission,
        ),
        scopes: [],
        authorizationEpoch: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      new Date().toISOString(),
    );
    return success(
      await f.human(reportRepositoryConfigCommand, {
        projectId: FIX.projectA,
        expectedVersion: row.resource_version,
        document,
        contentHash: row.content_hash,
        stepUpProofId,
      }),
    );
  }
  async function signCapture<T extends object>(unsigned: T) {
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(`BFB-AGENT-WORK-CAPTURE-V1\n${canonicalLaunchJson(unsigned)}\n`),
    );
    return { ...unsigned, signature: Buffer.from(signature).toString("base64url") };
  }
  async function capture(
    commandName: AgentWriteCommandName,
    request: AgentWriteRequest,
    suppliedConfirmation?: AgentCaptureConfirmationResult,
  ): Promise<AgentWorkCapture> {
    const confirmation = suppliedConfirmation ?? success(await confirm());
    const action = agentWriteAction(commandName);
    const tools = {
      comment: "bfb_add_comment",
      update: "bfb_update_task",
      progress: "bfb_report_progress",
      proposal: "bfb_propose_task",
    } as const;
    const unsigned = {
      schema_version: 1 as const,
      confirmation,
      operation: {
        command_name: commandName,
        tool: tools[action as keyof typeof tools],
        operation_schema_version: 1 as const,
        operation_key: agentWorkKey(action, request.reference),
        request_id: request.reference.request_id,
        payload_hash: `sha256:${runnerHash(canonicalAgentWriteRequest(commandName, Buffer.from(JSON.stringify(request))))}`,
        expected_version: "expected_version" in request ? request.expected_version : null,
        target_task_id: commandName === "agent_run.proposal" ? null : f.task.id,
        parent_task_id: "parent_task_id" in request ? (request.parent_task_id ?? null) : null,
      },
      admission_mode: "offline_admitted" as const,
      admitted_permission: confirmation.configured_permission,
      captured_at: new Date().toISOString(),
      intent_expires_at: new Date(
        Date.now() + confirmation.configured_permission.max_pending_age_seconds * 1000,
      ).toISOString(),
    };
    return signCapture(unsigned);
  }
  return {
    ...f,
    ...claimed,
    key,
    secret,
    claims,
    token: encodeRunnerToken(claims, secret),
    binding,
    bound,
    reference,
    confirmationRequest,
    envelope,
    confirm,
    capture,
    signCapture,
    renew,
    advancePolicy,
  };
}
