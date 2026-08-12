// ABOUTME: Drives strict authenticated MCP requests through the real stateless SDK handler.
// ABOUTME: Routing metadata, body envelopes, delegation boundaries, and mutations fail closed.

import { describe, expect, it } from "vitest";

import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import {
  addContextCommand,
  createTaskCommand,
} from "../../../packages/domain/src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const handlerEnv = {
  allowedHostnames: ["bfb.example.test"],
  appOrigin: "https://bfb.example.test",
  abuseSecret: "x03a-mcp-abuse-secret-81174a9dff",
  jurisdiction: "eu" as const,
  now: "2026-08-07T12:01:00.000Z",
};

describe("mcp handler", () => {
  it("requires bearer auth for discovery and rejects browser cookies", async () => {
    const db = await openDomainDb();
    const unauthenticated = await request(db, "tools/list");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );

    const cookie = await request(db, "tools/list", undefined, {}, "not-a-token", {
      cookie: "__Host-bfb_session=synthetic",
    });
    expect(cookie.status).toBe(401);
    expect(await cookie.json()).toEqual({ error: "credential_confusion" });
  });

  it("lists exactly seven tools for an active delegation", async () => {
    const db = await openDomainDb();
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const response = await request(db, "tools/list", undefined, {}, accessToken);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "bfb_list_projects",
      "bfb_list_tasks",
      "bfb_get_task",
      "bfb_get_context",
      "bfb_add_comment",
      "bfb_report_progress",
      "bfb_propose_task",
    ]);
  });

  it("lets the SDK reject missing envelopes and routing mismatches", async () => {
    const db = await openDomainDb();
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const missingEnvelope = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: headers("tools/list", undefined, accessToken),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      { db, ...handlerEnv },
    );
    expect(missingEnvelope.status).toBe(400);

    const mismatch = await request(db, "tools/list", undefined, {}, accessToken, {
      "Mcp-Method": "server/discover",
    });
    expect(mismatch.status).toBe(400);

    const missingName = await request(db, "tools/call", undefined, {}, accessToken);
    expect(missingName.status).toBe(400);

    const nameMismatch = await request(db, "tools/call", "bfb_list_tasks", {}, accessToken, {
      "Mcp-Name": "bfb_get_task",
    });
    expect(nameMismatch.status).toBe(400);

    const wrongVersion = await request(db, "tools/list", undefined, {}, accessToken, {
      "MCP-Protocol-Version": "2025-06-18",
    });
    expect(wrongVersion.status).toBe(400);
  });

  it("rejects legacy transport and enforces exact Host, Origin, CORS, and body bounds", async () => {
    const db = await openDomainDb();
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const get = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        headers: { Host: "bfb.example.test", authorization: `Bearer ${accessToken}` },
      }),
      { db, ...handlerEnv },
    );
    expect(get.status).toBe(405);

    const hostileHost = await handleMcpRequest(
      new Request("https://hostile.example.test/mcp", {
        method: "POST",
        headers: headers("tools/list", undefined, accessToken),
        body: JSON.stringify(modernBody("tools/list")),
      }),
      { db, ...handlerEnv },
    );
    expect(hostileHost.status).toBe(403);

    for (const extraHeaders of [{ origin: "https://hostile.example.test" }, { origin: "null" }]) {
      const response = await request(db, "tools/list", undefined, {}, accessToken, extraHeaders);
      expect(response.status).toBe(403);
    }
    const exactOrigin = await request(db, "tools/list", undefined, {}, accessToken, {
      origin: handlerEnv.appOrigin,
    });
    expect(exactOrigin.status).toBe(200);

    const preflight = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "OPTIONS",
        headers: { Host: "bfb.example.test", origin: handlerEnv.appOrigin },
      }),
      { db, ...handlerEnv },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(handlerEnv.appOrigin);
    expect(preflight.headers.has("access-control-allow-credentials")).toBe(false);

    const oversized = await handleMcpRequest(
      new Request("https://bfb.example.test/mcp", {
        method: "POST",
        headers: headers("tools/list", undefined, accessToken),
        body: "x".repeat(65_537),
      }),
      { db, ...handlerEnv },
    );
    expect(oversized.status).toBe(413);

    const session = await request(db, "tools/list", undefined, {}, accessToken, {
      "Mcp-Session-Id": "forbidden-session",
    });
    expect(session.status).not.toBe(200);
  });

  it("proposes tasks and keeps discussion and progress idempotent", async () => {
    const db = await openDomainDb();
    const { accessToken } = await issueSyntheticMcpAccess(db);
    const proposed = await call(db, accessToken, "bfb_propose_task", {
      request_id: "mcp-request-1",
      project_id: FIX.projectA,
      title: "From MCP",
      priority: "P2",
    });
    expect(proposed).toMatchObject({ ok: true, result: { state: "proposed", title: "From MCP" } });
    const taskId = (proposed as { result: { id: string } }).result.id;

    const commands = [
      ["bfb_add_comment", "mcp-comment-1", { body: "Discuss this" }],
      ["bfb_report_progress", "mcp-progress-1", { summary: "Halfway done" }],
    ] as const;
    for (const [name, requestId, values] of commands) {
      const args = { task_id: taskId, request_id: requestId, ...values };
      expect(await call(db, accessToken, name, args)).toMatchObject({ ok: true });
      expect(await call(db, accessToken, name, args)).toMatchObject({ ok: true });
    }

    const comments = (await db
      .prepare(`SELECT body, kind FROM comments WHERE workspace_id = ? AND task_id = ? ORDER BY id`)
      .all(FIX.workspace, taskId)) as Array<{ body: string; kind: string }>;
    expect(comments).toHaveLength(2);
    expect(comments).toEqual(
      expect.arrayContaining([
        { body: "Discuss this", kind: "discussion" },
        { body: "Halfway done", kind: "progress" },
      ]),
    );
  });

  it("rejects root proposals from task-bound delegations", async () => {
    const db = await openDomainDb();
    const parent = await new WorkspaceHub(db).execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "task-bound-parent",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: "2026-08-07T12:00:00.000Z",
      input: { projectId: FIX.projectA, title: "Delegation root", priority: "P2" },
    });
    if (!parent.ok) {
      throw new Error("task-bound fixture creation failed");
    }
    const { accessToken } = await issueSyntheticMcpAccess(db, {
      taskId: parent.result.id,
    });
    const response = await request(
      db,
      "tools/call",
      "bfb_propose_task",
      {
        request_id: "task-bound-root",
        project_id: FIX.projectA,
        title: "Must not escape",
      },
      accessToken,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(true);
    const tasks = (await db.prepare(`SELECT title FROM tasks ORDER BY id`).all()) as Array<{
      title: string;
    }>;
    expect(tasks).toEqual([{ title: "Delegation root" }]);

    const child = await call(db, accessToken, "bfb_propose_task", {
      request_id: "task-bound-child",
      project_id: FIX.projectA,
      parent_task_id: parent.result.id,
      title: "Allowed child",
    });
    expect(child).toMatchObject({ ok: true, result: { parent_task_id: parent.result.id } });
  });

  it("keeps projects, tasks, context, and idempotency inside the delegated boundary", async () => {
    const db = await openDomainDb();
    const hub = new WorkspaceHub(db);
    const taskA = await createTask(hub, "boundary-a", FIX.projectA, "Alpha task");
    const taskB = await createTask(hub, "boundary-b", FIX.projectB, "Beta task");
    await hub.execute(addContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "context-human-only",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: "2026-08-07T12:00:00.000Z",
      input: { taskId: taskA, kind: "note", audience: "human", body: "Human secret" },
    });
    await hub.execute(addContextCommand, {
      workspaceId: FIX.workspace,
      idempotencyKey: "context-agent-visible",
      authorizationEpoch: 1,
      actorHumanId: FIX.owner,
      now: "2026-08-07T12:00:00.000Z",
      input: { taskId: taskA, kind: "constraint", audience: "agent", body: "Agent input" },
    });
    const { accessToken } = await issueSyntheticMcpAccess(db, { projectId: FIX.projectA });

    const projects = (await call(db, accessToken, "bfb_list_projects", {})) as {
      projects: Array<{ id: string }>;
    };
    expect(projects.projects.map((project) => project.id)).toEqual([FIX.projectA]);
    const tasks = (await call(db, accessToken, "bfb_list_tasks", {})) as {
      tasks: Array<{ id: string }>;
    };
    expect(tasks.tasks.map((task) => task.id)).toEqual([taskA]);

    const foreign = await request(
      db,
      "tools/call",
      "bfb_get_task",
      { task_id: taskB },
      accessToken,
    );
    expect(foreign.status).toBe(200);
    expect(((await foreign.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);

    const context = (await call(db, accessToken, "bfb_get_context", {
      task_id: taskA,
      request_id: "context-read-agent",
    })) as { context: Array<{ body: string; audience: string }> };
    expect(context.context).toEqual([
      expect.objectContaining({ audience: "agent", body: "Agent input" }),
    ]);

    const proposed = (await call(db, accessToken, "bfb_propose_task", {
      request_id: "collision-request",
      project_id: FIX.projectA,
      title: "Collision source",
    })) as { result: { id: string } };
    const collision = await call(db, accessToken, "bfb_add_comment", {
      task_id: proposed.result.id,
      request_id: "collision-request",
      body: "Must not replay a task result",
    });
    expect(collision).toMatchObject({
      ok: false,
      error: { code: "idempotency_command_mismatch" },
    });
    expect(
      await db
        .prepare(`SELECT COUNT(*) AS count FROM comments WHERE workspace_id = ?`)
        .get(FIX.workspace),
    ).toEqual({ count: 0 });
  });

  it("enforces a durable attempt budget across handler instances", async () => {
    const db = await openDomainDb();
    for (let attempt = 0; attempt < 600; attempt++) {
      const response = await request(db, "tools/list", undefined, {}, "invalid-token-value");
      expect(response.status).toBe(401);
    }
    const blocked = await request(db, "tools/list", undefined, {}, "invalid-token-value");
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "request_rejected",
      message: "request rejected",
    });
  });
});

async function createTask(
  hub: WorkspaceHub,
  idempotencyKey: string,
  projectId: string,
  title: string,
): Promise<string> {
  const outcome = await hub.execute(createTaskCommand, {
    workspaceId: FIX.workspace,
    idempotencyKey,
    authorizationEpoch: 1,
    actorHumanId: FIX.owner,
    now: "2026-08-07T12:00:00.000Z",
    input: { projectId, title, priority: "P2" },
  });
  if (!outcome.ok) {
    throw new Error(`task fixture failed: ${outcome.error.code}`);
  }
  return outcome.result.id;
}

async function call(
  db: import("@bfb/db").SqlDatabase,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await request(db, "tools/call", name, args, accessToken);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text) as unknown;
}

function request(
  db: import("@bfb/db").SqlDatabase,
  method: string,
  name?: string,
  args: Record<string, unknown> = {},
  accessToken?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: { ...headers(method, name, accessToken), ...extraHeaders },
      body: JSON.stringify(modernBody(method, name, args)),
    }),
    { db, ...handlerEnv },
  );
}

function headers(method: string, name?: string, accessToken?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    ...(name ? { "Mcp-Name": name } : {}),
    Host: "bfb.example.test",
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

function modernBody(method: string, name?: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...(name ? { name, arguments: args } : {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "bfb-test", version: "1.0.0" },
      },
    },
  };
}
