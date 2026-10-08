// ABOUTME: Exercises final delegated task delivery through genuine authenticated OAuth MCP.
// ABOUTME: Witnessed post-selection authority changes must preserve business history and the missing-task wire.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bumpMemberEpoch } from "../../../packages/domain/src/authorization.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import { revokeDelegation } from "../../../packages/domain/src/oauth.js";
import {
  createTaskCommand,
  updateTaskCommand,
  type TaskRecord,
} from "../../../packages/domain/src/work-commands.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const TITLE = "SYNTHETIC-C11-DELEGATED-TASK-READ-TITLE";
const PUNCHLINE = "SYNTHETIC-C11-DELEGATED-TASK-READ-PUNCHLINE";
const PARENT_TITLE = "SYNTHETIC-C11-DELEGATED-TASK-READ-PARENT";
const EFFECT_TABLES = [
  "tasks",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
  "task_context_items",
  "task_context_deliveries",
  "comments",
  "runs",
  "attention_requests",
  "attention_observations",
  "notification_deliveries",
] as const;

beforeEach(() => vi.useRealTimers());

async function fixture(
  humanId: string = FIX.member,
  options: {
    state?: "ready" | "done" | "cancelled";
    parent?: boolean;
    bound?: boolean;
    expiry?: string;
  } = {},
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const parent = options.parent
    ? success(
        await hub.execute(createTaskCommand, {
          ...owner,
          idempotencyKey: randomUlid(),
          input: { projectId: FIX.projectA, title: PARENT_TITLE, priority: "P2" },
        }),
      )
    : undefined;
  let task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: TITLE,
        punchline: PUNCHLINE,
        priority: "P2",
        ...(parent ? { parentTaskId: parent.id } : {}),
      },
    }),
  );
  for (const state of options.state === "done"
    ? (["active", "review", "done"] as const)
    : options.state === "cancelled"
      ? (["cancelled"] as const)
      : []) {
    task = success(
      await hub.execute(updateTaskCommand, {
        ...owner,
        idempotencyKey: randomUlid(),
        input: { taskId: task.id, expectedVersion: task.resource_version, state },
      }),
    );
  }
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(options.expiry ?? "+10 minutes")) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId,
    projectId: FIX.projectA,
    ...(options.bound ? { taskId: task.id } : {}),
    scopes: ["bfb:read", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
  return { db, hub, owner, humanId, task, parent, ...clock, ...auth };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function credential(f: Fixture) {
  return f.db
    .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, f.delegationId);
}
async function effects(f: Fixture) {
  const rows: Record<string, unknown[]> = {};
  for (const table of EFFECT_TABLES)
    rows[table] = await f.db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
      .all(FIX.workspace);
  return {
    rows,
    cursor: await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace),
    artifactGuards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
    runnerGuards: await f.db.prepare("SELECT * FROM runner_mutation_guards ORDER BY id").all(),
  };
}
async function privateRead(f: Fixture, taskId = f.task.id) {
  // Dormant synthetic privacy uses the genuine creator, never an Owner override.
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.owner, f.observed_at);
  const id = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
    )
    .run(FIX.workspace, id, taskId, f.humanId, f.observed_at);
  return id;
}
async function revokeGrant(f: Fixture, id: string) {
  await f.db
    .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
    .run(new Date().toISOString(), FIX.workspace, id);
  expect(
    await f.db
      .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, id),
  ).toMatchObject({ revoked_at: expect.any(String) });
}

function afterRead(
  f: Fixture,
  seam: "initial" | "preliminary" | "advisory",
  change: () => Promise<void>,
) {
  let preliminary = false,
    observed = false,
    after: Awaited<ReturnType<typeof effects>> | undefined;
  return {
    db: {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            const row = await statement.get(...parameters);
            const taskProjection =
              sql.includes("AS parent_task_id") &&
              sql.includes("FROM tasks AS task") &&
              parameters.includes(f.task.id) &&
              row;
            const isPreliminary = !preliminary && taskProjection;
            const initial =
              !preliminary &&
              sql.includes("SELECT task.id AS taskId") &&
              parameters.includes(f.task.id) &&
              row;
            if (isPreliminary) preliminary = true;
            const advisory =
              preliminary &&
              sql.includes("SELECT task.id AS taskId") &&
              parameters.includes(f.task.id) &&
              row;
            if (
              !observed &&
              (seam === "initial" ? initial : seam === "preliminary" ? isPreliminary : advisory)
            ) {
              observed = true;
              expect(row).toMatchObject(
                seam === "preliminary"
                  ? { id: f.task.id, title: TITLE }
                  : { taskId: f.task.id, projectId: FIX.projectA },
              );
              await change();
              after = await effects(f);
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

async function call(f: Fixture, db: SqlDatabase = f.db, taskId = f.task.id) {
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "bfb_get_task",
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "bfb_get_task",
          arguments: { task_id: taskId },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "synthetic-delegated-task-read",
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
      abuseSecret: "synthetic-c11-task-read-abuse-secret-8165ab",
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
function denied(reply: Awaited<ReturnType<typeof call>>, f: Fixture) {
  expect(reply.isError).toBe(true);
  expect(reply.text).toBe("task not found");
  for (const canary of [TITLE, PUNCHLINE, f.task.id, FIX.projectA])
    expect(reply.text).not.toContain(canary);
}
function task(reply: Awaited<ReturnType<typeof call>>) {
  expect(reply.isError).not.toBe(true);
  return (JSON.parse(reply.text) as { task: TaskRecord }).task;
}

describe("mounted final delegated task delivery", () => {
  it.each([
    { humanId: FIX.owner, state: "ready" as const },
    { humanId: FIX.member, state: "done" as const },
    { humanId: FIX.reviewer, state: "cancelled" as const },
  ])("$humanId delayed read-only $state history remains readable", async ({ humanId, state }) => {
    const f = await fixture(humanId, { state }),
      before = await effects(f),
      hooked = afterRead(f, "preliminary", () => delay(250));
    expect(task(await call(f, hooked.db))).toEqual(f.task);
    expect(hooked.observed()).toBe(true);
    expect(await credential(f)).toMatchObject({
      scopes_json: JSON.stringify(["bfb:read", "offline_access"]),
    });
    expect(await effects(f)).toEqual(before);
  });

  it("production delegation revocation after preliminary body selection denies without effects", async () => {
    const f = await fixture(),
      before = await effects(f);
    const hooked = afterRead(f, "preliminary", async () => {
      await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
      expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
      expect(await effects(f)).toEqual(before);
    });
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
  });

  it.each(["scope", "client", "project_to_null", "task_to_target"] as const)(
    "%s after preliminary selection cannot replace retained OAuth authority",
    async (loss) => {
      const f = await fixture(),
        before = await effects(f);
      expect(await credential(f)).toMatchObject({
        client_id: FIX.client,
        project_id: FIX.projectA,
        task_id: null,
      });
      const hooked = afterRead(f, "preliminary", async () => {
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
            .run("synthetic-other-task-read-client", FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({
            client_id: "synthetic-other-task-read-client",
          });
        } else if (loss === "project_to_null") {
          await f.db
            .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
        } else {
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.task.id, FIX.workspace, f.delegationId);
          expect(await credential(f)).toMatchObject({
            project_id: FIX.projectA,
            task_id: f.task.id,
          });
        }
        expect(await effects(f)).toEqual(before);
      });
      denied(await call(f, hooked.db), f);
      expect(hooked.observed()).toBe(true);
      expect(await effects(f)).toEqual(before);
    },
  );

  it.each(["private_read", "epoch", "project_access"] as const)(
    "%s loss after the successful final advisory read denies the selected task",
    async (loss) => {
      const f = await fixture(),
        grantId = loss === "private_read" ? await privateRead(f) : undefined,
        before = await effects(f);
      const hooked = afterRead(f, "advisory", async () => {
        if (loss === "private_read") await revokeGrant(f, grantId!);
        else if (loss === "epoch")
          expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
        else {
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
        }
        expect(await effects(f)).toEqual(before);
      });
      denied(await call(f, hooked.db), f);
      expect(hooked.observed()).toBe(true);
      expect(await effects(f)).toEqual(before);
    },
  );

  it("unchanged credential expiry after successful advisory selection withholds the retained body", async () => {
    const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
      originalCredential = await credential(f),
      before = await effects(f);
    const hooked = afterRead(f, "advisory", async () => {
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
      expect(await credential(f)).toEqual(originalCredential);
    });
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
    expect(await credential(f)).toEqual(originalCredential);
  });

  it("a genuine Hub edit after preliminary selection returns current canonical task fields without read effects", async () => {
    const f = await fixture();
    let edited: TaskRecord | undefined;
    const hooked = afterRead(f, "preliminary", async () => {
      edited = success(
        await f.hub.execute(updateTaskCommand, {
          ...f.owner,
          idempotencyKey: randomUlid(),
          input: {
            taskId: f.task.id,
            expectedVersion: f.task.resource_version,
            title: `${TITLE}-EDITED`,
            punchline: `${PUNCHLINE}-EDITED`,
            priority: "P1",
          },
        }),
      );
    });
    expect(task(await call(f, hooked.db))).toEqual(edited);
    expect(hooked.observed()).toBe(true);
    expect(edited).toBeDefined();
    expect(await effects(f)).toEqual(hooked.after());
  });

  it("parent-only read-grant loss returns the readable shared child with no parent identifier", async () => {
    const f = await fixture(FIX.member, { parent: true }),
      grantId = await privateRead(f, f.parent!.id),
      before = await effects(f);
    const hooked = afterRead(f, "advisory", () => revokeGrant(f, grantId));
    const reply = await call(f, hooked.db);
    expect(task(reply)).toEqual({ ...f.task, parent_task_id: null });
    expect(reply.text).not.toContain(f.parent!.id);
    expect(reply.text).not.toContain(PARENT_TITLE);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
  });

  it("a healthy task-bound root read redacts its otherwise readable out-of-subtree parent", async () => {
    const f = await fixture(FIX.member, { parent: true, bound: true }),
      before = await effects(f),
      reply = await call(f);
    expect(task(reply)).toEqual({ ...f.task, parent_task_id: null });
    expect(reply.text).not.toContain(f.parent!.id);
    expect(await effects(f)).toEqual(before);
  });

  it("valid-ID missing and initially denied private targets retain identical SDK plain-text wire", async () => {
    const f = await fixture();
    await f.db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, f.task.id, FIX.owner, f.observed_at);
    const before = await effects(f),
      missing = await call(f, f.db, randomUlid()),
      hidden = await call(f);
    denied(missing, f);
    denied(hidden, f);
    expect(hidden).toEqual(missing);
    expect(await effects(f)).toEqual(before);
  });

  it("preliminary absence after successful initial admission keeps the same missing-task wire", async () => {
    const f = await fixture(),
      grantId = await privateRead(f),
      before = await effects(f);
    const hooked = afterRead(f, "initial", () => revokeGrant(f, grantId));
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
  });

  it("an epoch loss before the advisory check keeps the same missing-task wire", async () => {
    const f = await fixture(),
      before = await effects(f);
    const hooked = afterRead(f, "preliminary", async () => {
      expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
    });
    denied(await call(f, hooked.db), f);
    expect(hooked.observed()).toBe(true);
    expect(await effects(f)).toEqual(before);
  });

  it("an unexpected database failure after preliminary selection is not masked as task absence", async () => {
    const f = await fixture(),
      before = await effects(f);
    let preliminary = false,
      observed = false;
    const db = {
      ...f.db,
      prepare(sql: string) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...parameters) {
            if (
              preliminary &&
              sql.includes("SELECT task.id AS taskId") &&
              parameters.includes(f.task.id)
            ) {
              observed = true;
              throw new Error("SYNTHETIC-TASK-READ-DATABASE-FAILURE");
            }
            const row = await statement.get(...parameters);
            if (sql.includes("AS parent_task_id") && parameters.includes(f.task.id) && row)
              preliminary = true;
            return row;
          },
        };
      },
    } satisfies SqlDatabase;
    const reply = await call(f, db);
    expect(observed).toBe(true);
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("SYNTHETIC-TASK-READ-DATABASE-FAILURE");
    expect(reply.text).not.toBe("task not found");
    expect(await effects(f)).toEqual(before);
  });
});
