// ABOUTME: Builds a fresh MCP server per request with the seven delegated BFB tools.
// ABOUTME: Tools call shared domain commands; authority comes from the authenticated delegation.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  type ActiveDelegation,
  deliverDelegatedAgentContextCommand,
  assertScope,
  assertTaskChildAccess,
  getTask,
  listTasksPage,
  listTaskSubtreePage,
  loadPrincipal,
  enforceDelegationAccess,
  addCommentCommand,
  createTaskCommand,
  reportProgressCommand,
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
      inputSchema: {},
    },
    async () => {
      assertScope(deps.delegation, "bfb:read");
      // membership ∩ delegation: only projects allowed by both role grants and delegation scope
      let projectIds = principal.projectIds;
      if (deps.delegation.projectId) {
        projectIds = projectIds.filter((id) => id === deps.delegation.projectId);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ projects: projectIds }),
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
        cursor: z.string().optional(),
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
      inputSchema: { task_id: z.string() },
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
      inputSchema: { task_id: z.string() },
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
      const outcome = await executeWorkspaceCommand(hubDeps, deliverDelegatedAgentContextCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: `context-${task_id}-${deps.now}`,
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
        task_id: z.string(),
        body: z.string(),
        request_id: z.string().optional(),
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
        idempotencyKey: request_id ?? `comment-${task_id}-${deps.now}`,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: { taskId: task_id, body, kind: "discussion" },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }] };
    },
  );

  server.registerTool(
    "bfb_report_progress",
    {
      description: "Report bounded progress on a task",
      inputSchema: {
        task_id: z.string(),
        summary: z.string(),
        request_id: z.string().optional(),
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
        idempotencyKey: request_id ?? `progress-${task_id}-${deps.now}`,
        authorizationEpoch: deps.delegation.authorizationEpoch,
        actorHumanId: deps.delegation.humanId,
        actorDelegationId: deps.delegation.delegationId,
        now: deps.now,
        input: { taskId: task_id, body: summary, kind: "progress" },
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }] };
    },
  );

  server.registerTool(
    "bfb_propose_task",
    {
      description: "Propose a root task or create a policy-bounded child task",
      inputSchema: {
        project_id: z.string(),
        parent_task_id: z.string().optional(),
        title: z.string(),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
        request_id: z.string().optional(),
      },
    },
    async ({ project_id, parent_task_id, title, priority, request_id }) => {
      assertScope(deps.delegation, "bfb:task:write");
      await enforceDelegationAccess(deps.db, deps.delegation, project_id, parent_task_id);
      const outcome = await executeWorkspaceCommand(hubDeps, createTaskCommand, {
        workspaceId: deps.delegation.workspaceId,
        idempotencyKey: request_id ?? `propose-${project_id}-${deps.now}`,
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
      return { content: [{ type: "text" as const, text: JSON.stringify(outcome) }] };
    },
  );

  return server;
}
