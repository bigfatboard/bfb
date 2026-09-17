// ABOUTME: Builds a fresh MCP server per request with the twelve delegated BFB tools.
// ABOUTME: Tools call shared domain commands; authority comes from the authenticated delegation.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  type ActiveDelegation,
  deliverDelegatedAgentContextCommand,
  ARTIFACT_FORMATS,
  ARTIFACT_ROLES,
  artifactHash,
  assertScope,
  assertTaskChildAccess,
  ATTENTION_KINDS,
  createDelegatedArtifactCommand,
  finalizeDelegatedArtifactCommand,
  getAttention,
  getTask,
  issueGrantResponse,
  listProjectsPage,
  listTasksPage,
  listTaskSubtreePage,
  loadPrincipal,
  enforceDelegationAccess,
  addCommentCommand,
  createTaskCommand,
  mintUploadGrantSecret,
  reportProgressCommand,
  requestDelegatedAttentionCommand,
  submitDelegatedResultCommand,
} from "@bfb/domain";

import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";

export interface McpServerDeps {
  db: SqlDatabase;
  delegation: ActiveDelegation;
  now: string;
  jurisdiction: Jurisdiction;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

export async function createBfbMcpServer(deps: McpServerDeps): Promise<McpServer> {
  const server = new McpServer({
    name: "bfb",
    version: "0.0.0",
  });
  const principal = await loadPrincipal(
    deps.db,
    deps.delegation.workspaceId,
    deps.delegation.humanId,
  );
  const hubDeps = {
    db: deps.db,
    authorization: createAuthorizationContext({
      workspaceId: deps.delegation.workspaceId,
      principalId: deps.delegation.delegationId,
      authorizationEpoch: deps.delegation.authorizationEpoch,
      jurisdiction: deps.jurisdiction,
    }),
    workspaceHubNs: deps.workspaceHubNs,
  };

  server.registerTool(
    "bfb_list_projects",
    {
      description: "List projects accessible to the authenticated delegation",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(128).optional(),
      },
    },
    async ({ limit, cursor }) => {
      assertScope(deps.delegation, "bfb:read");
      const scopedPrincipal = {
        ...principal,
        projectIds: deps.delegation.projectId
          ? principal.projectIds.filter((id) => id === deps.delegation.projectId)
          : principal.projectIds,
      };
      const page = await listProjectsPage(deps.db, scopedPrincipal, {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(page),
          },
        ],
      };
    },
  );

  server.registerTool(
    "bfb_list_tasks",
    {
      description: "List tasks under the delegated boundary",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(128).optional(),
      },
    },
    async ({ limit, cursor }) => {
      assertScope(deps.delegation, "bfb:read");
      let projectIds = principal.projectIds;
      if (deps.delegation.projectId) {
        projectIds = projectIds.filter((id) => id === deps.delegation.projectId);
      }
      const options = {
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      if (deps.delegation.taskId) {
        await enforceDelegationAccess(
          deps.db,
          deps.delegation,
          deps.delegation.projectId ?? undefined,
          deps.delegation.taskId,
        );
      }
      const page = deps.delegation.taskId
        ? await listTaskSubtreePage(
            deps.db,
            deps.delegation.workspaceId,
            deps.delegation.taskId,
            options,
          )
        : await listTasksPage(deps.db, deps.delegation.workspaceId, projectIds, options);
      return { content: [{ type: "text" as const, text: JSON.stringify(page) }] };
    },
  );

  server.registerTool(
    "bfb_get_task",
    {
      description: "Get one task by id within the delegated boundary",
      inputSchema: { task_id: z.string().min(1).max(128) },
    },
    async ({ task_id }) => {
      assertScope(deps.delegation, "bfb:read");
      await assertTaskChildAccess(deps.db, principal, task_id);
      const task = await getTask(deps.db, deps.delegation.workspaceId, task_id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }],
          isError: true,
        };
      }
      await enforceDelegationAccess(deps.db, deps.delegation, task.project_id, task.id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ task }) }] };
    },
  );

  server.registerTool(
    "bfb_get_context",
    {
      description: "Read agent-visible context for a task",
      inputSchema: {
        task_id: z.string().min(1).max(128),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ task_id, request_id }) => {
      assertScope(deps.delegation, "bfb:read");
      await assertTaskChildAccess(deps.db, principal, task_id);
      const task = await getTask(deps.db, deps.delegation.workspaceId, task_id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }],
          isError: true,
        };
      }
      await enforceDelegationAccess(deps.db, deps.delegation, task.project_id, task.id);
      const outcome = await executeWorkspaceCommand(hubDeps, deliverDelegatedAgentContextCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: { taskId: task_id },
      });
      if (!outcome.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: outcome.error }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ context: outcome.result }) }],
      };
    },
  );

  server.registerTool(
    "bfb_add_comment",
    {
      description: "Add a discussion comment to a task",
      inputSchema: {
        task_id: z.string().min(1).max(128),
        body: z.string().min(1).max(2048),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ task_id, body, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      const task = await getTask(deps.db, deps.delegation.workspaceId, task_id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }],
          isError: true,
        };
      }
      await enforceDelegationAccess(deps.db, deps.delegation, task.project_id, task.id);
      const outcome = await executeWorkspaceCommand(hubDeps, addCommentCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: { taskId: task_id, body, kind: "discussion" },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
        ...(!outcome.ok && { isError: true }),
      };
    },
  );

  server.registerTool(
    "bfb_report_progress",
    {
      description: "Report bounded progress on a task",
      inputSchema: {
        task_id: z.string().min(1).max(128),
        summary: z.string().min(1).max(2048),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ task_id, summary, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      const task = await getTask(deps.db, deps.delegation.workspaceId, task_id);
      if (!task) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }],
          isError: true,
        };
      }
      await enforceDelegationAccess(deps.db, deps.delegation, task.project_id, task.id);
      const outcome = await executeWorkspaceCommand(hubDeps, reportProgressCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: { taskId: task_id, body: summary, kind: "progress" },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
        ...(!outcome.ok && { isError: true }),
      };
    },
  );

  server.registerTool(
    "bfb_propose_task",
    {
      description: "Propose a root task or create a policy-bounded child task",
      inputSchema: {
        project_id: z.string().min(1).max(128),
        parent_task_id: z.string().min(1).max(128).optional(),
        title: z.string().min(1).max(512),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ project_id, parent_task_id, title, priority, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      await enforceDelegationAccess(deps.db, deps.delegation, project_id, parent_task_id);
      const outcome = await executeWorkspaceCommand(hubDeps, createTaskCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: {
          projectId: project_id,
          ...(parent_task_id === undefined ? {} : { parentTaskId: parent_task_id }),
          title,
          priority: priority ?? "P2",
        },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
        ...(!outcome.ok && { isError: true }),
      };
    },
  );

  server.registerTool(
    "bfb_request_human",
    {
      description:
        "Request human attention for a run inside the delegated boundary. The authorizing human is recorded as requester; read the answer with bfb_get_attention. Cannot answer or resolve.",
      inputSchema: {
        run_id: z.string().min(1).max(128),
        kind: z.enum(ATTENTION_KINDS),
        question: z.string().min(1).max(2048),
        reference_kind: z.string().min(1).max(64).optional(),
        reference_id: z.string().min(1).max(128).optional(),
        blocking: z.boolean(),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ run_id, kind, question, reference_kind, reference_id, blocking, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      const outcome = await executeWorkspaceCommand(hubDeps, requestDelegatedAttentionCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: {
          runId: run_id,
          kind,
          question,
          ...(reference_kind === undefined ? {} : { referenceKind: reference_kind }),
          ...(reference_id === undefined ? {} : { referenceId: reference_id }),
          blocking,
        },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
        ...(!outcome.ok && { isError: true }),
      };
    },
  );

  server.registerTool(
    "bfb_get_attention",
    {
      description: "Read one attention request inside the delegated boundary",
      inputSchema: { attention_id: z.string().min(1).max(128) },
    },
    async ({ attention_id }) => {
      assertScope(deps.delegation, "bfb:read");
      const scopedProjectIds = deps.delegation.projectId
        ? principal.projectIds.filter((id) => id === deps.delegation.projectId)
        : principal.projectIds;
      const record = await getAttention(
        deps.db,
        deps.delegation.workspaceId,
        scopedProjectIds,
        attention_id,
      );
      if (!record) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found" }) }],
          isError: true,
        };
      }
      await enforceDelegationAccess(deps.db, deps.delegation, record.project_id, record.task_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ attention: record }) }],
      };
    },
  );

  server.registerTool(
    "bfb_submit_result",
    {
      description:
        "Submit an immutable result for a run inside the delegated boundary. Records the authorizing human as submitter and never mints agent_run identity. Cannot review, accept, fail, or cancel.",
      inputSchema: {
        run_id: z.string().min(1).max(128),
        summary: z.string().min(1).max(2048),
        limitations: z.string().max(2048).optional(),
        evidence_refs: z
          .array(
            z.object({
              kind: z.string().min(1).max(64),
              ref: z.string().min(1).max(512),
              version: z.string().min(1).max(128).optional(),
              hash: z.string().min(1).max(128).optional(),
            }),
          )
          .max(20)
          .optional(),
        git_branch: z.string().min(1).max(256).optional(),
        git_commit: z.string().min(1).max(256).optional(),
        git_dirty: z.boolean().optional(),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({
      run_id,
      summary,
      limitations,
      evidence_refs,
      git_branch,
      git_commit,
      git_dirty,
      request_id,
    }) => {
      assertScope(deps.delegation, "bfb:task:write");
      const outcome = await executeWorkspaceCommand(hubDeps, submitDelegatedResultCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: {
          runId: run_id,
          summary,
          ...(limitations === undefined ? {} : { limitations }),
          ...(evidence_refs === undefined
            ? {}
            : {
                evidenceRefs: evidence_refs.map((entry) => ({
                  kind: entry.kind,
                  ref: entry.ref,
                  ...(entry.version === undefined ? {} : { version: entry.version }),
                  ...(entry.hash === undefined ? {} : { hash: entry.hash }),
                })),
              }),
          ...(git_branch === undefined ? {} : { gitBranch: git_branch }),
          ...(git_commit === undefined ? {} : { gitCommit: git_commit }),
          ...(git_dirty === undefined ? {} : { gitDirty: git_dirty }),
        },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
        ...(!outcome.ok && { isError: true }),
      };
    },
  );

  server.registerTool(
    "bfb_publish_artifact",
    {
      description:
        "Start an artifact publication for a run inside the delegated boundary. Returns a one-time upload grant secret; upload bytes to the deployment Artifact Worker, then call bfb_finalize_artifact. Cannot approve or review.",
      inputSchema: {
        artifact_id: z.string().min(1).max(128).optional(),
        run_id: z.string().min(1).max(128),
        format: z.enum(ARTIFACT_FORMATS),
        role: z.enum(ARTIFACT_ROLES),
        declared_size: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
        expected_digest: z.string().min(1).max(128),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ artifact_id, run_id, format, role, declared_size, expected_digest, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      const minted = mintUploadGrantSecret();
      const outcome = await executeWorkspaceCommand(hubDeps, createDelegatedArtifactCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: {
          artifactId: artifact_id ?? null,
          runId: run_id,
          format,
          role,
          declaredSize: declared_size,
          expectedDigest: expected_digest,
          grantSecretHash: artifactHash(minted.secret),
        },
      });
      if (!outcome.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
          isError: true,
        };
      }
      const grant = issueGrantResponse(outcome.result.upload_grant, minted.secret);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              result: {
                ...outcome.result,
                upload_grant: {
                  grant_id: grant.grant_id,
                  version_id: grant.version_id,
                  secret: grant.secret,
                  expires_at: grant.expires_at,
                },
              },
              replayed: outcome.replayed,
              cursor: outcome.cursor,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "bfb_finalize_artifact",
    {
      description:
        "Finalize a delegated artifact version after the Artifact Worker verified the uploaded bytes. Requires a run-bound version inside the delegated boundary.",
      inputSchema: {
        version_id: z.string().min(1).max(128),
        content_hash: z.string().min(1).max(128),
        size: z
          .number()
          .int()
          .min(1)
          .max(5 * 1024 * 1024),
        request_id: z.string().min(1).max(128),
      },
    },
    async ({ version_id, content_hash, size, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      const outcome = await executeWorkspaceCommand(hubDeps, finalizeDelegatedArtifactCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: { versionId: version_id, contentHash: content_hash, size },
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
        ...(!outcome.ok && { isError: true }),
      };
    },
  );

  return server;
}
