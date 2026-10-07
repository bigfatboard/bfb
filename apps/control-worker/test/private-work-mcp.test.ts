// ABOUTME: Exercises current private-task authority through the mounted remote MCP handler.
// ABOUTME: Synthetic policies prove scope intersections, filtered pages and revoked cached replies.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bumpMemberEpoch } from "../../../packages/domain/src/authorization.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import {
  addContextCommand,
  createTaskCommand,
  updateTaskCommand,
  type TaskRecord,
} from "../../../packages/domain/src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const NOW = "2026-10-06T12:00:00.000Z";
const DELIVERY_NOW = "2026-10-06T12:01:00.000Z";
const EXPIRES_AT = "2026-10-06T12:10:00.000Z";
const AGENT_CONTEXT = "Synthetic private agent-facing constraint";
const HUMAN_CONTEXT = "Synthetic private human-only note";
const handlerEnv = {
  allowedHostnames: ["bfb.example.test"],
  appOrigin: "https://bfb.example.test",
  abuseSecret: "c11-synthetic-mcp-abuse-secret-874b1c",
  jurisdiction: "eu" as const,
  now: DELIVERY_NOW,
};

interface McpReply {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
  error?: { code: number; message: string };
}

interface TaskPage {
  tasks: TaskRecord[];
  limit: number;
  has_more: boolean;
  next_cursor?: string;
}

let db: SqlDatabase;
let hub: WorkspaceHub;
let namespace: DurableObjectNamespace;
let sharedTask: TaskRecord;
let privateTask: TaskRecord;
let hiddenTask: TaskRecord;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(DELIVERY_NOW));
  db = await openDomainDb();
  hub = new WorkspaceHub(db);
  namespace = createTestWorkspaceHubNamespace(db);
  sharedTask = await createTask("Synthetic shared task");
  privateTask = await createTask("Synthetic creator-private task");
  hiddenTask = await createTask("Synthetic unshared private task");
  for (const [audience, body] of [
    ["agent", AGENT_CONTEXT],
    ["human", HUMAN_CONTEXT],
  ] as const) {
    const outcome = await hub.execute(addContextCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: NOW,
      input: { taskId: privateTask.id, kind: "note", audience, body },
    });
    if (!outcome.ok) throw new Error(`synthetic context setup failed: ${outcome.error.code}`);
  }
  await makePrivate(privateTask.id);
  await makePrivate(hiddenTask.id);
});

afterEach(() => vi.useRealTimers());

async function createTask(
  title: string,
  parentTaskId?: string,
  projectId = FIX.projectA,
): Promise<TaskRecord> {
  const outcome = await hub.execute(createTaskCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.member,
    authorizationEpoch: 1,
    idempotencyKey: randomUlid(),
    now: NOW,
    input: { projectId, title, priority: "P2", ...(parentTaskId ? { parentTaskId } : {}) },
  });
  if (!outcome.ok) throw new Error(`synthetic task setup failed: ${outcome.error.code}`);
  return outcome.result;
}

async function makePrivate(taskId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_privacy
       (workspace_id, task_id, owner_human_id, access_version, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(FIX.workspace, taskId, FIX.member, NOW);
}

async function grant(permission: "read" | "contribute" | "edit", taskId = privateTask.id) {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(FIX.workspace, id, taskId, FIX.owner, permission, NOW);
  return id;
}

async function revoke(grantId: string): Promise<void> {
  await db
    .prepare("UPDATE task_human_grants SET revoked_at = ? WHERE workspace_id = ? AND id = ?")
    .run(DELIVERY_NOW, FIX.workspace, grantId);
}

async function access(input: Parameters<typeof issueSyntheticMcpAccess>[1] = {}) {
  return issueSyntheticMcpAccess(db, { now: NOW, expiresAt: EXPIRES_AT, ...input });
}

async function liveReadAccess(input: Parameters<typeof issueSyntheticMcpAccess>[1] = {}) {
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') AS expires_at",
    )
    .get()) as { observed_at: string; expires_at: string };
  return issueSyntheticMcpAccess(db, {
    ...input,
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
}

async function call(
  accessToken: string,
  name: string,
  args: Record<string, unknown> = {},
  queryDb: SqlDatabase = db,
): Promise<McpReply> {
  const response = await handleMcpRequest(
    new Request(`${handlerEnv.appOrigin}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
        Host: "bfb.example.test",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "bfb-private-test", version: "1.0.0" },
          },
        },
      }),
    }),
    { db: queryDb, workspaceHubNs: namespace, ...handlerEnv },
  );
  return (await response.json()) as McpReply;
}

function value<T>(reply: McpReply): T {
  expect(reply.error).toBeUndefined();
  expect(reply.result?.isError).not.toBe(true);
  const text = reply.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text!) as T;
}

function denied(reply: McpReply): void {
  expect(reply.result?.isError === true || reply.error !== undefined).toBe(true);
}

function noPrivateExistence(reply: McpReply, tasks = [privateTask, hiddenTask]): void {
  const serialized = JSON.stringify(reply);
  for (const task of tasks) {
    expect(serialized).not.toContain(task.id);
    expect(serialized).not.toContain(task.title);
  }
  expect(serialized).not.toContain(AGENT_CONTEXT);
  expect(serialized).not.toContain(HUMAN_CONTEXT);
}

function interleaveRead(
  point: "after_token_resolution" | "before_task_selection",
  action: () => Promise<void>,
): { queryDb: SqlDatabase; observed: () => boolean } {
  const source = db;
  let observed = false;
  const queryDb: SqlDatabase = {
    ...source,
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        ...statement,
        async get(...parameters) {
          const row = await statement.get(...parameters);
          if (
            !observed &&
            point === "after_token_resolution" &&
            sql.includes("JOIN oauth_delegations d")
          ) {
            observed = true;
            await action();
          }
          return row;
        },
        async all(...parameters) {
          if (
            !observed &&
            point === "before_task_selection" &&
            sql.includes("FROM tasks AS task")
          ) {
            observed = true;
            await action();
          }
          return statement.all(...parameters);
        },
      };
    },
  };
  return { queryDb, observed: () => observed };
}

async function comments() {
  return db
    .prepare("SELECT body, kind FROM comments WHERE workspace_id = ? AND task_id = ?")
    .all(FIX.workspace, privateTask.id);
}

describe("private task delivery through remote MCP", () => {
  it.each([
    ["visibility", "private"],
    ["private", true],
    ["owner_human_id", FIX.owner],
    ["private_owner_human_id", FIX.owner],
  ] as const)(
    "rejects unsupported private task-create field %s without creating shared work",
    async (field, intent) => {
      const { accessToken } = await access();
      const reply = await call(accessToken, "bfb_propose_task", {
        project_id: FIX.projectA,
        parent_task_id: sharedTask.id,
        title: "Synthetic unsupported private task",
        [field]: intent,
        request_id: `synthetic-private-intent-create-${field}`,
      });
      expect.soft(reply.result?.isError === true || reply.error !== undefined).toBe(true);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ?")
          .get(FIX.workspace),
      ).toEqual({ count: 3 });
    },
  );

  for (const tool of ["bfb_add_comment", "bfb_report_progress"] as const) {
    it.each([
      ["audience", "private"],
      ["visibility", "private"],
      ["private", true],
    ] as const)(
      `${tool} rejects unsupported private %s without publishing a comment`,
      async (field, intent) => {
        const { accessToken } = await access();
        const prose = "Synthetic unsupported private checkpoint";
        const reply = await call(accessToken, tool, {
          task_id: sharedTask.id,
          ...(tool === "bfb_add_comment" ? { body: prose } : { summary: prose }),
          [field]: intent,
          request_id: `synthetic-private-intent-${tool}-${field}`,
        });
        expect.soft(reply.result?.isError === true || reply.error !== undefined).toBe(true);
        expect(
          await db
            .prepare("SELECT COUNT(*) AS count FROM comments WHERE workspace_id = ?")
            .get(FIX.workspace),
        ).toEqual({ count: 0 });
      },
    );
  }

  it("keeps the existing shared child proposal available without private arguments", async () => {
    const { accessToken } = await access();
    const outcome = value<{ ok: boolean; result: TaskRecord }>(
      await call(accessToken, "bfb_propose_task", {
        project_id: FIX.projectA,
        parent_task_id: sharedTask.id,
        title: "Synthetic permitted shared child",
        request_id: "synthetic-shared-proposal-control",
      }),
    );
    expect(outcome).toMatchObject({ ok: true, result: { parent_task_id: sharedTask.id } });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM task_privacy WHERE workspace_id = ? AND task_id = ?",
        )
        .get(FIX.workspace, outcome.result.id),
    ).toEqual({ count: 0 });
  });

  it.each(["creator", "new-epoch grantee"] as const)(
    "an old delegation cannot adopt fresh %s authority after token resolution",
    async (actor) => {
      const humanId = actor === "creator" ? FIX.member : FIX.owner;
      const { accessToken } = await access({ humanId });
      const boundary = interleaveRead("after_token_resolution", async () => {
        const epoch = await bumpMemberEpoch(db, FIX.workspace, humanId);
        expect(epoch).toBe(2);
        if (actor === "new-epoch grantee") {
          await db
            .prepare(
              `INSERT INTO task_human_grants
               (workspace_id, id, task_id, human_id, authorization_epoch, permission, created_at)
               VALUES (?, ?, ?, ?, ?, 'read', ?)`,
            )
            .run(FIX.workspace, randomUlid(), privateTask.id, humanId, epoch, DELIVERY_NOW);
        }
      });
      const reply = await call(accessToken, "bfb_list_tasks", {}, boundary.queryDb);
      expect(boundary.observed()).toBe(true);
      noPrivateExistence(reply);
      if (!reply.error && !reply.result?.isError) expect(value<TaskPage>(reply).tasks).toEqual([]);
    },
  );

  it("rechecks delegation revocation in the actual task-selection query", async () => {
    await grant("read");
    const { accessToken, delegationId } = await access();
    const boundary = interleaveRead("before_task_selection", async () => {
      await db
        .prepare("UPDATE oauth_delegations SET revoked_at = ? WHERE workspace_id = ? AND id = ?")
        .run(DELIVERY_NOW, FIX.workspace, delegationId);
    });
    const reply = await call(accessToken, "bfb_list_tasks", {}, boundary.queryDb);
    expect(boundary.observed()).toBe(true);
    noPrivateExistence(reply);
    if (!reply.error && !reply.result?.isError) expect(value<TaskPage>(reply).tasks).toEqual([]);
  });

  it("hides private task IDs, titles and page counts from an unshared workspace owner", async () => {
    const { accessToken } = await liveReadAccess();
    for (const args of [{}, { limit: 1 }]) {
      const reply = await call(accessToken, "bfb_list_tasks", args);
      expect(value<TaskPage>(reply)).toMatchObject({
        tasks: [{ id: sharedTask.id }],
        has_more: false,
      });
      expect(value<TaskPage>(reply).tasks).toHaveLength(1);
      expect(value<TaskPage>(reply).next_cursor).toBeUndefined();
      noPrivateExistence(reply);
    }
  });

  it.each(["bfb_get_task", "bfb_get_context"])(
    "%s denies an unshared owner exactly like a missing task",
    async (tool) => {
      const { accessToken } = await access();
      const missing = await call(accessToken, tool, {
        task_id: randomUlid(),
        ...(tool === "bfb_get_context" ? { request_id: "synthetic-missing-context" } : {}),
      });
      const privateReply = await call(accessToken, tool, {
        task_id: privateTask.id,
        ...(tool === "bfb_get_context" ? { request_id: "synthetic-private-context" } : {}),
      });
      denied(missing);
      denied(privateReply);
      expect(privateReply.result ?? privateReply.error).toEqual(missing.result ?? missing.error);
      noPrivateExistence(privateReply);
    },
  );

  it("filters a named human's task pages before LIMIT and delivers only agent-visible context", async () => {
    await grant("read");
    const { accessToken } = await liveReadAccess();
    const expectedIds = [sharedTask.id, privateTask.id].sort();
    const firstReply = await call(accessToken, "bfb_list_tasks", { limit: 1 });
    const first = value<TaskPage>(firstReply);
    expect(first.tasks.map((task) => task.id)).toEqual(expectedIds.slice(0, 1));
    expect(first.has_more).toBe(true);
    expect(first.next_cursor).toBe(expectedIds[0]);
    const secondReply = await call(accessToken, "bfb_list_tasks", {
      limit: 1,
      cursor: first.next_cursor,
    });
    const second = value<TaskPage>(secondReply);
    expect(second.tasks.map((task) => task.id)).toEqual(expectedIds.slice(1));
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeUndefined();
    noPrivateExistence(firstReply, [hiddenTask]);
    noPrivateExistence(secondReply, [hiddenTask]);
    expect(
      value<{ task: TaskRecord }>(
        await call(accessToken, "bfb_get_task", { task_id: privateTask.id }),
      ).task.id,
    ).toBe(privateTask.id);
    const context = value<{ context: Array<{ body: string; audience: string }> }>(
      await call(accessToken, "bfb_get_context", {
        task_id: privateTask.id,
        request_id: "synthetic-granted-context",
      }),
    );
    expect(context.context).toEqual([
      expect.objectContaining({ body: AGENT_CONTEXT, audience: "agent" }),
    ]);
    expect(JSON.stringify(context)).not.toContain(HUMAN_CONTEXT);
  });

  it.each([
    ["bfb_add_comment", { body: "Synthetic denied comment" }],
    ["bfb_report_progress", { summary: "Synthetic denied progress" }],
  ])(
    "a read grant cannot contribute through %s despite an OAuth write scope",
    async (tool, fields) => {
      await grant("read");
      const { accessToken } = await access();
      const reply = await call(accessToken, tool, {
        task_id: privateTask.id,
        request_id: `synthetic-read-${tool}`,
        ...fields,
      });
      denied(reply);
      noPrivateExistence(reply);
      expect(await comments()).toEqual([]);
    },
  );

  it("a contribute grant permits explicit comments and progress", async () => {
    await grant("contribute");
    const { accessToken } = await access();
    for (const [tool, fields] of [
      ["bfb_add_comment", { body: "Synthetic permitted comment" }],
      ["bfb_report_progress", { summary: "Synthetic permitted progress" }],
    ] as const) {
      expect(
        value(
          await call(accessToken, tool, {
            task_id: privateTask.id,
            request_id: `synthetic-contribute-${tool}`,
            ...fields,
          }),
        ),
      ).toMatchObject({ ok: true });
    }
    expect(await comments()).toEqual(
      expect.arrayContaining([
        { body: "Synthetic permitted comment", kind: "discussion" },
        { body: "Synthetic permitted progress", kind: "progress" },
      ]),
    );
    expect(await comments()).toHaveLength(2);
  });

  it("a contribute grant cannot edit task fields, while an edit grant can", async () => {
    const grantId = await grant("contribute");
    const { delegationId } = await access();
    // Remote MCP exposes no task-update tool; exercise its shared delegated command authority.
    const update = () =>
      hub.execute(updateTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        actorDelegationId: delegationId,
        authorizationEpoch: 1,
        idempotencyKey: "synthetic-delegated-private-edit",
        now: NOW,
        input: { taskId: privateTask.id, expectedVersion: 1, title: "Synthetic edited task" },
      });
    expect(await update()).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await db
        .prepare("SELECT title FROM tasks WHERE workspace_id = ? AND id = ?")
        .get(FIX.workspace, privateTask.id),
    ).toEqual({ title: privateTask.title });
    await revoke(grantId);
    await grant("edit");
    expect(await update()).toMatchObject({ ok: true, result: { title: "Synthetic edited task" } });
  });

  it("task contribution authority cannot replace the OAuth write scope", async () => {
    await grant("contribute");
    const { accessToken } = await liveReadAccess({ scopes: ["bfb:read", "offline_access"] });
    const reply = await call(accessToken, "bfb_add_comment", {
      task_id: privateTask.id,
      request_id: "synthetic-no-write-scope",
      body: "Synthetic missing-scope comment",
    });
    denied(reply);
    expect(JSON.stringify(reply)).toMatch(/insufficient_scope|missing scope/);
    expect(await comments()).toEqual([]);
    expect(
      value<{ task: TaskRecord }>(
        await call(accessToken, "bfb_get_task", {
          task_id: privateTask.id,
        }),
      ).task.id,
    ).toBe(privateTask.id);
  });

  it("a task read grant cannot replace the OAuth read scope", async () => {
    await grant("read");
    const { accessToken } = await access({ scopes: ["bfb:task:write", "offline_access"] });
    for (const tool of ["bfb_get_task", "bfb_get_context"]) {
      const reply = await call(accessToken, tool, {
        task_id: privateTask.id,
        ...(tool === "bfb_get_context" ? { request_id: "synthetic-no-read-scope" } : {}),
      });
      denied(reply);
      expect(JSON.stringify(reply)).toMatch(/insufficient_scope|missing scope/);
      noPrivateExistence(reply);
    }
  });

  it("a private grant cannot widen a task-bound delegation", async () => {
    await grant("read");
    const { accessToken } = await liveReadAccess({ taskId: sharedTask.id });
    for (const tool of ["bfb_get_task", "bfb_get_context"]) {
      const reply = await call(accessToken, tool, {
        task_id: privateTask.id,
        ...(tool === "bfb_get_context" ? { request_id: "synthetic-outside-task-boundary" } : {}),
      });
      denied(reply);
      noPrivateExistence(reply);
    }
    const page = value<TaskPage>(await call(accessToken, "bfb_list_tasks"));
    expect(page.tasks.map((task) => task.id)).toEqual([sharedTask.id]);
  });

  it("a private grant cannot widen a project-bound delegation", async () => {
    const otherProjectTask = await createTask(
      "Synthetic private other-project task",
      undefined,
      FIX.projectB,
    );
    await makePrivate(otherProjectTask.id);
    await grant("read", otherProjectTask.id);
    const { accessToken } = await access({ projectId: FIX.projectA });
    const reply = await call(accessToken, "bfb_get_task", { task_id: otherProjectTask.id });
    denied(reply);
    noPrivateExistence(reply, [otherProjectTask]);
  });

  it("a private grant cannot preserve delivery after project access is revoked", async () => {
    await grant("read");
    const { accessToken } = await liveReadAccess();
    expect(
      value<{ task: TaskRecord }>(
        await call(accessToken, "bfb_get_task", {
          task_id: privateTask.id,
        }),
      ).task.id,
    ).toBe(privateTask.id);
    await db
      .prepare(
        "DELETE FROM project_access WHERE workspace_id = ? AND project_id = ? AND human_id = ?",
      )
      .run(FIX.workspace, FIX.projectA, FIX.owner);
    const reply = await call(accessToken, "bfb_get_task", { task_id: privateTask.id });
    denied(reply);
    noPrivateExistence(reply);
    expect(value<TaskPage>(await call(accessToken, "bfb_list_tasks")).tasks).toEqual([]);
  });

  it.each([
    ["bfb_add_comment", "contribute", "comment.add", { body: "Synthetic cached comment" }],
    ["bfb_get_context", "read", "context.deliver.delegation", {}],
  ] as const)(
    "%s rechecks revoked task authority before an identical cached reply",
    async (tool, permission, command, fields) => {
      const grantId = await grant(permission);
      const { accessToken } = await (tool === "bfb_get_context" ? liveReadAccess() : access());
      const args = { task_id: privateTask.id, request_id: `synthetic-cached-${tool}`, ...fields };
      value(await call(accessToken, tool, args));
      expect(
        await db
          .prepare(
            "SELECT command_name FROM idempotency_records WHERE workspace_id = ? AND idempotency_key = ?",
          )
          .get(FIX.workspace, args.request_id),
      ).toEqual({ command_name: command });
      await revoke(grantId);
      const reply = await call(accessToken, tool, args);
      denied(reply);
      noPrivateExistence(reply);
      if (tool === "bfb_add_comment") expect(await comments()).toHaveLength(1);
    },
  );

  it.each(["creator", "edit grantee"])(
    "rejects a private-parent proposal from its %s until inheritance exists",
    async (actor) => {
      if (actor === "edit grantee") await grant("edit");
      const { accessToken } = await access({
        humanId: actor === "creator" ? FIX.member : FIX.owner,
      });
      const reply = await call(accessToken, "bfb_propose_task", {
        project_id: FIX.projectA,
        parent_task_id: privateTask.id,
        title: "Synthetic unsupported private child",
        request_id: `synthetic-private-child-${actor}`,
      });
      denied(reply);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = ? AND parent_task_id = ?",
          )
          .get(FIX.workspace, privateTask.id),
      ).toEqual({ count: 0 });
    },
  );

  it("subtree pages omit denied nodes and stop traversal through a denied branch", async () => {
    const deniedParent = await createTask("Synthetic denied subtree parent", sharedTask.id);
    const visibleChild = await createTask("Synthetic readable subtree child", deniedParent.id);
    const visibleSibling = await createTask("Synthetic readable direct child", sharedTask.id);
    await makePrivate(deniedParent.id);
    const { accessToken } = await liveReadAccess({ taskId: sharedTask.id });
    const reply = await call(accessToken, "bfb_list_tasks");
    const page = value<TaskPage>(reply);
    expect(page.tasks.map((task) => task.id).sort()).toEqual(
      [sharedTask.id, visibleSibling.id].sort(),
    );
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeUndefined();
    noPrivateExistence(reply, [privateTask, hiddenTask, deniedParent, visibleChild]);
  });

  it("project pages and direct task reads redact a readable child's denied parent ID", async () => {
    const deniedParent = await createTask("Synthetic denied subtree parent", sharedTask.id);
    const visibleChild = await createTask("Synthetic readable subtree child", deniedParent.id);
    await makePrivate(deniedParent.id);
    const { accessToken } = await liveReadAccess();
    const reply = await call(accessToken, "bfb_list_tasks");
    const page = value<TaskPage>(reply);
    expect(page.tasks.map((task) => task.id).sort()).toEqual(
      [sharedTask.id, visibleChild.id].sort(),
    );
    expect(page.tasks.find((task) => task.id === visibleChild.id)?.parent_task_id).toBeNull();
    noPrivateExistence(reply, [privateTask, hiddenTask, deniedParent]);
    const childReply = await call(accessToken, "bfb_get_task", { task_id: visibleChild.id });
    expect(value<{ task: TaskRecord }>(childReply).task.parent_task_id).toBeNull();
    noPrivateExistence(childReply, [privateTask, hiddenTask, deniedParent]);
  });

  it("task-bound root reads and subtree pages redact its otherwise-readable parent", async () => {
    const parent = await createTask("Synthetic private parent above delegation");
    const root = await createTask("Synthetic delegated subtree root", parent.id);
    const child = await createTask("Synthetic delegated subtree descendant", root.id);
    await makePrivate(parent.id);
    await grant("read", parent.id);
    const bounded = await liveReadAccess({ taskId: root.id });

    const rootReply = await call(bounded.accessToken, "bfb_get_task", { task_id: root.id });
    expect(value<{ task: TaskRecord }>(rootReply).task).toMatchObject({
      id: root.id,
      parent_task_id: null,
    });
    noPrivateExistence(rootReply, [parent]);

    const subtreeReply = await call(bounded.accessToken, "bfb_list_tasks");
    const subtree = value<TaskPage>(subtreeReply);
    expect(subtree.tasks.map((task) => task.id).sort()).toEqual([root.id, child.id].sort());
    expect(subtree.tasks.find((task) => task.id === root.id)?.parent_task_id).toBeNull();
    expect(subtree.tasks.find((task) => task.id === child.id)?.parent_task_id).toBe(root.id);
    noPrivateExistence(subtreeReply, [parent]);

    const deniedParent = await call(bounded.accessToken, "bfb_get_task", { task_id: parent.id });
    denied(deniedParent);
    noPrivateExistence(deniedParent, [parent]);

    const broader = await liveReadAccess();
    expect(
      value<{ task: TaskRecord }>(
        await call(broader.accessToken, "bfb_get_task", { task_id: parent.id }),
      ).task.id,
    ).toBe(parent.id);
    expect(
      value<{ task: TaskRecord }>(
        await call(broader.accessToken, "bfb_get_task", { task_id: root.id }),
      ).task.parent_task_id,
    ).toBe(parent.id);
    const broaderPage = value<TaskPage>(await call(broader.accessToken, "bfb_list_tasks"));
    expect(broaderPage.tasks.find((task) => task.id === root.id)?.parent_task_id).toBe(parent.id);
  });

  it("task-bound delegated cached updates keep their parent reference redacted", async () => {
    const parent = await createTask("Synthetic cached private parent above delegation");
    const root = await createTask("Synthetic cached delegated subtree root", parent.id);
    await makePrivate(parent.id);
    const grantId = await grant("read", parent.id);
    const { delegationId } = await access({ taskId: root.id });
    // Remote MCP has no update tool; its issued delegation still bounds the shared command.
    const update = () =>
      hub.execute(updateTaskCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        actorDelegationId: delegationId,
        authorizationEpoch: 1,
        idempotencyKey: "synthetic-cached-task-bound-edit",
        now: NOW,
        input: { taskId: root.id, expectedVersion: 1, title: "Synthetic delegated root edit" },
      });
    const initial = await update();
    expect(initial).toMatchObject({
      ok: true,
      replayed: false,
      result: { id: root.id, parent_task_id: null, resource_version: 2 },
    });
    expect(JSON.stringify(initial)).not.toContain(parent.id);

    await revoke(grantId);
    const replay = await update();
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      result: { id: root.id, parent_task_id: null, resource_version: 2 },
    });
    expect(JSON.stringify(replay)).not.toContain(parent.id);
    expect(
      await db
        .prepare("SELECT resource_version FROM tasks WHERE workspace_id = ? AND id = ?")
        .get(FIX.workspace, root.id),
    ).toEqual({ resource_version: 2 });
  });
});
