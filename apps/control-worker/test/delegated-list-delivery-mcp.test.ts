// ABOUTME: Exercises delegated project and task collection selection through genuine authenticated OAuth MCP.
// ABOUTME: Captured authority, prepared-query races and readable subtree controls distinguish denial from empty pages.

import { setTimeout as delay } from "node:timers/promises";
import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bumpMemberEpoch } from "../../../packages/domain/src/authorization.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { revokeDelegation } from "../../../packages/domain/src/oauth.js";
import type { ProjectRecord } from "../../../packages/domain/src/projects.js";
import {
  createTaskCommand,
  updateTaskCommand,
  type TaskPage,
  type TaskRecord,
} from "../../../packages/domain/src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const TITLE = "SYNTHETIC-C11-DELEGATED-LIST-TASK";
const BODY = "SYNTHETIC-C11-DELEGATED-LIST-PUNCHLINE";
type Tool = "bfb_list_projects" | "bfb_list_tasks";
type ProjectPage = { projects: ProjectRecord[]; hasMore: boolean; nextCursor?: string };

beforeEach(() => vi.useRealTimers());

async function fixture(
  humanId: string = FIX.member,
  options: {
    empty?: boolean;
    bound?: boolean;
    workspaceBoundary?: boolean;
    expiry?: string;
    state?: "ready" | "done" | "cancelled";
    scopes?: string[];
  } = {},
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const create = async (title = TITLE, parentTaskId?: string) =>
    success(
      await hub.execute(createTaskCommand, {
        ...owner,
        idempotencyKey: randomUlid(),
        input: {
          projectId: FIX.projectA,
          title,
          punchline: BODY,
          priority: "P2",
          ...(parentTaskId ? { parentTaskId } : {}),
        },
      }),
    );
  let root = options.empty ? undefined : await create();
  if (root)
    for (const state of options.state === "done"
      ? (["active", "review", "done"] as const)
      : options.state === "cancelled"
        ? (["cancelled"] as const)
        : [])
      root = success(
        await hub.execute(updateTaskCommand, {
          ...owner,
          idempotencyKey: randomUlid(),
          input: { taskId: root.id, expectedVersion: root.resource_version, state },
        }),
      );
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(options.expiry ?? "+10 minutes")) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId,
    projectId: FIX.projectA,
    ...(options.bound ? { taskId: root!.id } : {}),
    scopes: options.scopes ?? ["bfb:read", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
  // Explicit historical workspace-scoped credential fixture, retained by the genuine OAuth resolver.
  if (options.workspaceBoundary)
    await db
      .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
      .run(FIX.workspace, auth.delegationId);
  return { db, hub, owner, humanId, root, create, ...clock, ...auth };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function credential(f: Fixture) {
  return f.db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, f.delegationId);
}
async function snapshot(f: Fixture) {
  const business: Record<string, unknown[]> = {},
    authority: Record<string, unknown[]> = {};
  const tables = (await f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name: table } of tables) {
    if (
      table.startsWith("sqlite_") ||
      table.startsWith("_cf_") ||
      ["d1_migrations", "rate_limit_buckets"].includes(table)
    )
      continue;
    expect(table).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    const target =
      table.startsWith("oauth_") ||
      table.startsWith("better_auth_") ||
      table === "preregistered_oauth_clients" ||
      [
        "workspace_members",
        "workspace_authorization_epochs",
        "project_access",
        "task_privacy",
        "task_human_grants",
      ].includes(table)
        ? authority
        : business;
    target[table] = await f.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  }
  return {
    business,
    authority,
    cursor: await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace),
    guards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
  };
}
async function revoke(f: Fixture) {
  const before = await snapshot(f);
  await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
  expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
  const after = await snapshot(f);
  expect(after.business).toEqual(before.business);
  expect(after.cursor).toEqual(before.cursor);
}
async function privateTask(f: Fixture, id: string, read = false) {
  // Synthetic dormant privacy is owned by the actual task creator.
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, id, FIX.owner, f.observed_at);
  if (!read) return undefined;
  const grant = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
    )
    .run(FIX.workspace, grant, id, f.humanId, f.observed_at);
  return grant;
}

function hook(
  f: Fixture,
  tool: Tool,
  seam: "capture" | "collection" | "advisory",
  change: () => Promise<void>,
) {
  let observed = false;
  let after: Awaited<ReturnType<typeof snapshot>> | undefined;
  const collection = (sql: string) =>
    tool === "bfb_list_projects"
      ? sql.includes("repository_host") && sql.includes("projects")
      : sql.includes("punchline") && sql.includes("tasks") && sql.includes("LIMIT");
  return {
    db: {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async all(...parameters) {
            if (!observed && seam === "collection" && collection(sql)) {
              observed = true;
              await change();
              after = await snapshot(f);
            }
            const rows = await statement.all(...parameters);
            if (
              !observed &&
              seam === "capture" &&
              sql.includes("SELECT projects.id") &&
              sql.includes("project_access")
            ) {
              observed = true;
              await change();
              after = await snapshot(f);
            }
            return rows;
          },
          async get(...parameters) {
            const row = await statement.get(...parameters);
            if (
              !observed &&
              seam === "advisory" &&
              sql.includes("SELECT task.id AS taskId") &&
              parameters.includes(f.root!.id) &&
              row
            ) {
              observed = true;
              expect(row).toMatchObject({ taskId: f.root!.id, projectId: FIX.projectA });
              await change();
              after = await snapshot(f);
            }
            return row;
          },
        };
      },
    } satisfies SqlDatabase,
    observed: () => observed,
    after: () => after,
  };
}

async function call(
  f: Fixture,
  tool: Tool,
  db: SqlDatabase = f.db,
  args: { limit?: number; cursor?: string } = {},
) {
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "synthetic-delegated-lists",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      db,
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "synthetic-list-delivery-abuse-secret-c11-c92365",
      jurisdiction: "eu",
      now: new Date().toISOString(),
    },
  );
  expect(response.status).toBe(200);
  const reply = (await response.json()) as {
    error?: unknown;
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
  };
  expect(reply.error).toBeUndefined();
  expect(reply.result?.content?.[0]?.type).toBe("text");
  return { isError: reply.result?.isError, text: reply.result!.content![0]!.text };
}
function page<T>(reply: Awaited<ReturnType<typeof call>>) {
  expect(reply.isError).not.toBe(true);
  return JSON.parse(reply.text) as T;
}
function denied(reply: Awaited<ReturnType<typeof call>>, f: Fixture) {
  expect(reply.isError).toBe(true);
  expect(reply.text).toBe("delegated list not available");
  for (const canary of [TITLE, BODY, FIX.projectA, f.root?.id].filter(Boolean) as string[])
    expect(reply.text).not.toContain(canary);
}

describe("mounted delegated collection delivery", () => {
  it.each([
    { humanId: FIX.owner, state: "ready" as const },
    { humanId: FIX.member, state: "done" as const },
    { humanId: FIX.reviewer, state: "cancelled" as const },
  ])(
    "$humanId read-only project metadata and $state history stay canonical",
    async ({ humanId, state }) => {
      const f = await fixture(humanId, { state }),
        before = await snapshot(f);
      expect(
        page<ProjectPage>(await call(f, "bfb_list_projects")).projects.map((row) => row.id),
      ).toEqual([FIX.projectA]);
      expect(page<TaskPage>(await call(f, "bfb_list_tasks"))).toEqual({
        tasks: [f.root],
        limit: 50,
        has_more: false,
      });
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it("project metadata is withheld after production revocation following principal project capture", async () => {
    const f = await fixture(),
      hooked = hook(f, "bfb_list_projects", "capture", () => revoke(f));
    const reply = await call(f, "bfb_list_projects", hooked.db);
    expect(hooked.observed()).toBe(true);
    denied(reply, f);
    expect(await snapshot(f)).toEqual(hooked.after());
  });

  it("project metadata follows current grants instead of the stale captured project set", async () => {
    const f = await fixture(),
      hooked = hook(f, "bfb_list_projects", "capture", async () => {
        await f.db
          .prepare(
            "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.projectA, f.humanId);
        expect(
          await f.db
            .prepare(
              "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .get(FIX.workspace, FIX.projectA, f.humanId),
        ).toBeUndefined();
      });
    const reply = await call(f, "bfb_list_projects", hooked.db);
    expect(hooked.observed()).toBe(true);
    expect(page<ProjectPage>(reply)).toEqual({ projects: [], hasMore: false });
    expect(await snapshot(f)).toEqual(hooked.after());
  });

  it.each(["scope", "client", "project_to_null", "task_to_root"] as const)(
    "task collection %s loss immediately before the prepared collection SQL denies",
    async (loss) => {
      const f = await fixture(),
        hooked = hook(f, "bfb_list_tasks", "collection", async () => {
          if (loss === "scope") {
            await f.db
              .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
              .run(JSON.stringify(["offline_access"]), FIX.workspace, f.delegationId);
            expect(await credential(f)).toMatchObject({
              scopes_json: JSON.stringify(["offline_access"]),
            });
          } else if (loss === "client") {
            await f.db
              .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
              .run("synthetic-other-list-client", FIX.workspace, f.delegationId);
            expect(await credential(f)).toMatchObject({ client_id: "synthetic-other-list-client" });
          } else if (loss === "project_to_null") {
            await f.db
              .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
              .run(FIX.workspace, f.delegationId);
            expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
          } else {
            await f.db
              .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
              .run(f.root!.id, FIX.workspace, f.delegationId);
            expect(await credential(f)).toMatchObject({
              project_id: FIX.projectA,
              task_id: f.root!.id,
            });
          }
        });
      const reply = await call(f, "bfb_list_tasks", hooked.db);
      expect(hooked.observed()).toBe(true);
      denied(reply, f);
      expect(await snapshot(f)).toEqual(hooked.after());
    },
  );

  it.each(["bfb_list_projects", "bfb_list_tasks"] as const)(
    "%s unchanged expiry after SQL and arguments are fixed denies",
    async (tool) => {
      const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
        original = await credential(f);
      const hooked = hook(f, tool, "collection", async () => {
        const live = () =>
          f.db
            .prepare(
              "SELECT julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE workspace_id=? AND id=?",
            )
            .get(FIX.workspace, f.delegationId) as Promise<{ live: number }>;
        expect(await live()).toEqual({ live: 1 });
        const deadline = Date.now() + 10_000;
        while ((await live()).live === 1 && Date.now() < deadline) await delay(50);
        expect(await live()).toEqual({ live: 0 });
        expect(await credential(f)).toEqual(original);
      });
      const reply = await call(f, tool, hooked.db);
      expect(hooked.observed()).toBe(true);
      denied(reply, f);
      expect(await snapshot(f)).toEqual(hooked.after());
      expect(await credential(f)).toEqual(original);
    },
  );

  it("rooted list read-scope loss after a successful advisory denies even with a terminal cursor", async () => {
    const f = await fixture(FIX.member, { bound: true }),
      hooked = hook(f, "bfb_list_tasks", "advisory", async () => {
        await f.db
          .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
          .run(JSON.stringify(["offline_access"]), FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({
          scopes_json: JSON.stringify(["offline_access"]),
        });
      });
    const reply = await call(f, "bfb_list_tasks", hooked.db, {
      cursor: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(hooked.observed()).toBe(true);
    denied(reply, f);
    expect(await snapshot(f)).toEqual(hooked.after());
  });

  it.each(["bfb_list_projects", "bfb_list_tasks"] as const)(
    "%s revoked empty captured project set denies rather than succeeds empty",
    async (tool) => {
      const f = await fixture(FIX.member, { empty: true });
      await f.db
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, f.humanId);
      const hooked = hook(f, tool, "capture", () => revoke(f));
      const reply = await call(f, tool, hooked.db);
      expect(hooked.observed()).toBe(true);
      denied(reply, f);
      expect(await snapshot(f)).toEqual(hooked.after());
    },
  );

  it("authorized empty and cursor-terminal pages keep the existing DTO shapes", async () => {
    const f = await fixture(FIX.member, { empty: true }),
      before = await snapshot(f);
    expect(page<TaskPage>(await call(f, "bfb_list_tasks"))).toEqual({
      tasks: [],
      limit: 50,
      has_more: false,
    });
    expect(
      page<ProjectPage>(
        await call(f, "bfb_list_projects", f.db, {
          cursor: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
          limit: 1,
        }),
      ),
    ).toEqual({ projects: [], hasMore: false });
    expect(await snapshot(f)).toEqual(before);
  });

  it("retained kernel control: hidden tasks do not consume lookahead or continuations", async () => {
    const f = await fixture(),
      second = await f.create(`${TITLE}-SECOND`),
      hidden = await f.create(`${TITLE}-HIDDEN`);
    await privateTask(f, hidden.id);
    const visible = [f.root!, second].sort((a, b) => a.id.localeCompare(b.id)),
      before = await snapshot(f);
    const first = page<TaskPage>(await call(f, "bfb_list_tasks", f.db, { limit: 1 }));
    expect(first).toEqual({
      tasks: [visible[0]],
      limit: 1,
      has_more: true,
      next_cursor: visible[0]!.id,
    });
    expect(
      page<TaskPage>(
        await call(f, "bfb_list_tasks", f.db, { limit: 1, cursor: first.next_cursor! }),
      ),
    ).toEqual({ tasks: [visible[1]], limit: 1, has_more: false });
    expect(await snapshot(f)).toEqual(before);
  });

  it("retained pruning control: a readable grandchild cannot cross an unreadable subtree branch", async () => {
    const f = await fixture(FIX.member, { bound: true }),
      blocked = await f.create(`${TITLE}-BLOCKED`, f.root!.id),
      grandchild = await f.create(`${TITLE}-GRANDCHILD`, blocked.id),
      sibling = await f.create(`${TITLE}-SIBLING`, f.root!.id);
    await privateTask(f, blocked.id);
    await privateTask(f, grandchild.id, true);
    const before = await snapshot(f),
      result = page<TaskPage>(await call(f, "bfb_list_tasks"));
    expect(result.tasks.map((row) => row.id)).toEqual([f.root!.id, sibling.id].sort());
    expect(result.tasks.find((row) => row.id === sibling.id)?.parent_task_id).toBe(f.root!.id);
    expect(await snapshot(f)).toEqual(before);
  });

  it("final canonical edit and current parent masking occur together without post-page hydration", async () => {
    const f = await fixture(),
      child = await f.create(`${TITLE}-CHILD`, f.root!.id),
      parentGrant = await privateTask(f, f.root!.id, true);
    let edited: TaskRecord | undefined;
    const hooked = hook(f, "bfb_list_tasks", "collection", async () => {
      edited = success(
        await f.hub.execute(updateTaskCommand, {
          ...f.owner,
          idempotencyKey: randomUlid(),
          input: {
            taskId: child.id,
            expectedVersion: child.resource_version,
            title: `${TITLE}-CURRENT`,
          },
        }),
      );
      await f.db
        .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
        .run(new Date().toISOString(), FIX.workspace, parentGrant!);
      expect(
        await f.db
          .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, parentGrant!),
      ).toMatchObject({ revoked_at: expect.any(String) });
    });
    const result = page<TaskPage>(await call(f, "bfb_list_tasks", hooked.db));
    expect(hooked.observed()).toBe(true);
    expect(result.tasks).toEqual([{ ...edited, parent_task_id: null }]);
    expect(await snapshot(f)).toEqual(hooked.after());
  });

  it("current epoch loss after project capture is authority denial, not a successfully filtered empty list", async () => {
    const f = await fixture(),
      hooked = hook(f, "bfb_list_tasks", "capture", async () => {
        expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
      });
    const reply = await call(f, "bfb_list_tasks", hooked.db);
    expect(hooked.observed()).toBe(true);
    denied(reply, f);
    expect(await snapshot(f)).toEqual(hooked.after());
  });

  it("unexpected collection database failure remains visible instead of becoming unavailable authority", async () => {
    const f = await fixture(),
      hooked = hook(f, "bfb_list_projects", "collection", async () => {
        throw new Error("SYNTHETIC-LIST-DATABASE-FAILURE");
      });
    const before = await snapshot(f),
      reply = await call(f, "bfb_list_projects", hooked.db);
    expect(hooked.observed()).toBe(true);
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("SYNTHETIC-LIST-DATABASE-FAILURE");
    expect(reply.text).not.toBe("delegated list not available");
    expect(await snapshot(f)).toEqual(before);
  });

  it("initial missing read scope retains its existing scope-admission error", async () => {
    const f = await fixture(FIX.member, { scopes: ["bfb:task:write", "offline_access"] }),
      before = await snapshot(f),
      reply = await call(f, "bfb_list_tasks");
    expect(reply.isError).toBe(true);
    expect(reply.text).not.toBe("delegated list not available");
    expect(reply.text).toContain("bfb:read");
    expect(await snapshot(f)).toEqual(before);
  });
});
