// ABOUTME: Serves authenticated work-record and board projection APIs for the W01 shell.
// ABOUTME: Uses browser session cookies and shared domain commands/projections only.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import {
  buildNeedsNowDeck,
  buildProjectLanes,
  createTaskCommand,
  loadPrincipal,
  listTasks,
  addCommentCommand,
  addContextCommand,
  getTask,
  updateTaskCommand,
  getAgentContext,
  assertTaskChildAccess,
} from "@bfb/domain";

import type { BrowserPrincipal } from "../auth/session.js";
import type { Jurisdiction } from "../env.js";
import { executeWorkspaceCommand } from "../hub-client.js";

export interface WorkApiDeps {
  db: SqlDatabase;
  principal: BrowserPrincipal;
  workspaceId: string;
  now: string;
  jurisdiction: Jurisdiction;
  workspaceHubNs?: DurableObjectNamespace | undefined;
}

export async function handleWorkApi(request: Request, deps: WorkApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const authz = await loadPrincipal(deps.db, deps.workspaceId, deps.principal.humanId);
  const hubDeps = {
    db: deps.db,
    authorization: createAuthorizationContext({
      workspaceId: deps.workspaceId,
      principalId: deps.principal.humanId,
      authorizationEpoch: authz.authorizationEpoch,
      jurisdiction: deps.jurisdiction,
    }),
    workspaceHubNs: deps.workspaceHubNs,
  };

  if (path === `/api/v1/workspaces/${deps.workspaceId}/board` && request.method === "GET") {
    const lanes = await buildProjectLanes(deps.db, deps.workspaceId, authz.projectIds);
    const needsNow = await buildNeedsNowDeck(
      deps.db,
      deps.workspaceId,
      deps.principal.humanId,
      authz.projectIds,
      deps.now,
    );
    return json({
      human: {
        id: deps.principal.humanId,
        display_name: deps.principal.displayName,
      },
      role: authz.role,
      lanes,
      needs_now: needsNow,
      agent_work_available: false,
    });
  }

  if (path === `/api/v1/workspaces/${deps.workspaceId}/tasks` && request.method === "GET") {
    return json({ tasks: await listTasks(deps.db, deps.workspaceId, authz.projectIds) });
  }

  if (path === `/api/v1/workspaces/${deps.workspaceId}/tasks` && request.method === "POST") {
    const body = (await request.json()) as {
      project_id: string;
      title: string;
      priority?: "P0" | "P1" | "P2" | "P3";
      request_id?: string;
    };
    const outcome = await executeWorkspaceCommand(hubDeps, createTaskCommand, {
      workspaceId: deps.workspaceId,
      idempotencyKey: body.request_id ?? `web-create-${deps.now}`,
      authorizationEpoch: authz.authorizationEpoch,
      actorHumanId: deps.principal.humanId,
      now: deps.now,
      input: {
        projectId: body.project_id,
        title: body.title,
        priority: body.priority ?? "P2",
      },
    });
    return json(outcome, outcome.ok ? 200 : 409);
  }

  if (
    path === `/api/v1/workspaces/${deps.workspaceId}/tasks/propose` &&
    request.method === "POST"
  ) {
    const body = (await request.json()) as {
      project_id: string;
      title: string;
      priority?: "P0" | "P1" | "P2" | "P3";
      request_id?: string;
    };
    const outcome = await executeWorkspaceCommand(hubDeps, createTaskCommand, {
      workspaceId: deps.workspaceId,
      idempotencyKey: body.request_id ?? `web-propose-${deps.now}`,
      authorizationEpoch: authz.authorizationEpoch,
      actorHumanId: deps.principal.humanId,
      now: deps.now,
      input: {
        projectId: body.project_id,
        title: body.title,
        priority: body.priority ?? "P2",
        actorIsAgent: true,
      },
    });
    return json(outcome, outcome.ok ? 200 : 409);
  }

  const taskMatch = path.match(
    new RegExp(`^/api/v1/workspaces/${deps.workspaceId}/tasks/([^/]+)(.*)$`),
  );
  if (taskMatch) {
    const taskId = taskMatch[1] ?? "";
    const rest = taskMatch[2] ?? "";
    if (rest === "" && request.method === "GET") {
      try {
        await assertTaskChildAccess(deps.db, authz, taskId);
      } catch {
        return json({ error: "not_found" }, 404);
      }
      const task = await getTask(deps.db, deps.workspaceId, taskId);
      if (!task) {
        return json({ error: "not_found" }, 404);
      }
      return json({ task });
    }
    if (rest === "" && request.method === "PATCH") {
      const body = (await request.json()) as {
        expected_version: number;
        title?: string;
        promote?: boolean;
        request_id?: string;
      };
      const outcome = await executeWorkspaceCommand(hubDeps, updateTaskCommand, {
        workspaceId: deps.workspaceId,
        idempotencyKey: body.request_id ?? `web-update-${taskId}-${deps.now}`,
        authorizationEpoch: authz.authorizationEpoch,
        actorHumanId: deps.principal.humanId,
        now: deps.now,
        input: {
          taskId,
          expectedVersion: body.expected_version,
          title: body.title,
          promote: body.promote,
        },
      });
      return json(outcome, outcome.ok ? 200 : 409);
    }
    if (rest === "/comments" && request.method === "POST") {
      const body = (await request.json()) as {
        body: string;
        kind?: "discussion" | "progress";
        request_id?: string;
      };
      const outcome = await executeWorkspaceCommand(hubDeps, addCommentCommand, {
        workspaceId: deps.workspaceId,
        idempotencyKey: body.request_id ?? `web-comment-${taskId}-${deps.now}`,
        authorizationEpoch: authz.authorizationEpoch,
        actorHumanId: deps.principal.humanId,
        now: deps.now,
        input: {
          taskId,
          body: body.body,
          kind: body.kind ?? "discussion",
        },
      });
      return json(outcome, outcome.ok ? 200 : 409);
    }
    if (rest === "/context" && request.method === "GET") {
      try {
        await assertTaskChildAccess(deps.db, authz, taskId);
      } catch {
        return json({ error: "not_found" }, 404);
      }
      const audience = url.searchParams.get("audience") ?? "agent";
      if (audience === "agent") {
        return json({ context: await getAgentContext(deps.db, deps.workspaceId, taskId) });
      }
      const all = await deps.db
        .prepare(
          `SELECT id, body, version, audience FROM task_context_items
           WHERE workspace_id = ? AND task_id = ? ORDER BY version ASC`,
        )
        .all(deps.workspaceId, taskId);
      return json({ context: all });
    }
    if (rest === "/context" && request.method === "POST") {
      const body = (await request.json()) as {
        audience: "human" | "agent" | "both";
        body: string;
        request_id?: string;
      };
      const outcome = await executeWorkspaceCommand(hubDeps, addContextCommand, {
        workspaceId: deps.workspaceId,
        idempotencyKey: body.request_id ?? `web-context-${taskId}-${deps.now}`,
        authorizationEpoch: authz.authorizationEpoch,
        actorHumanId: deps.principal.humanId,
        now: deps.now,
        input: {
          taskId,
          audience: body.audience,
          body: body.body,
        },
      });
      return json(outcome, outcome.ok ? 200 : 409);
    }
  }

  return json({ error: "not_found" }, 404);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
