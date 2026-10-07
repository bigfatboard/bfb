// ABOUTME: Exercises final delegated project and task pages with current authority and captured project ceilings.
// ABOUTME: Canonical pagination, readable subtree pruning and SQL-clock sentinels preserve history without read effects.

import { setTimeout as delay } from "node:timers/promises";
import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listDelegatedProjectsPage, listDelegatedTasksPage } from "../src/delegated-lists.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import { getProject } from "../src/projects.js";
import {
  createTaskCommand,
  updateTaskCommand,
  type DelegatedTaskReadAccess,
} from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const TITLE = "SYNTHETIC-C11-DOMAIN-DELEGATED-LIST-TASK";
const FAILURE = { code: "not_found", message: "delegated list not available" };

beforeEach(() => vi.useRealTimers());

async function fixture(
  humanId: string = FIX.member,
  options: {
    state?: "ready" | "done" | "cancelled";
    bound?: boolean;
    parent?: boolean;
    workspaceBoundary?: boolean;
    expiry?: string;
  } = {},
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const create = async (title = TITLE, parentTaskId?: string, projectId: string = FIX.projectA) =>
    success(
      await hub.execute(createTaskCommand, {
        ...owner,
        idempotencyKey: randomUlid(),
        input: { projectId, title, priority: "P2", ...(parentTaskId ? { parentTaskId } : {}) },
      }),
    );
  const parent = options.parent ? await create(`${TITLE}-OUTSIDE-ROOT`) : undefined;
  let root = await create(TITLE, parent?.id);
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
    .get(options.expiry ?? "+1 hour")) as { observed_at: string; expires_at: string };
  const delegationId = randomUlid(),
    projectBoundaryId = options.workspaceBoundary ? null : FIX.projectA;
  await db
    .prepare(
      `INSERT INTO oauth_delegations
    (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
     authorization_epoch,expires_at,created_at) VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,?,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      humanId,
      FIX.client,
      projectBoundaryId,
      options.bound ? root.id : null,
      JSON.stringify(["bfb:read"]),
      clock.expires_at,
      clock.observed_at,
    );
  const access: DelegatedTaskReadAccess = {
    workspaceId: FIX.workspace,
    humanId,
    authorizationEpoch: 1,
    delegationId,
    clientId: FIX.client,
    projectBoundaryId,
    ...(options.bound ? { taskBoundaryId: root.id } : {}),
  };
  return { db, hub, owner, humanId, root, parent, create, delegationId, access, ...clock };
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
async function privateTask(f: Fixture, id: string, read = false) {
  // Dormant synthetic privacy uses the task's genuine creator and immutable named grants.
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

describe("delegated canonical collection selectors", () => {
  it.each([
    { humanId: FIX.owner, state: "ready" as const },
    { humanId: FIX.member, state: "done" as const },
    { humanId: FIX.reviewer, state: "cancelled" as const },
  ])(
    "$humanId read-only metadata and $state history each use one final all-selection",
    async ({ humanId, state }) => {
      const f = await fixture(humanId, { state }),
        expected = await getProject(f.db, FIX.workspace, FIX.projectA),
        before = await snapshot(f),
        reads: string[] = [];
      const db = {
        ...f.db,
        prepare(sql: string) {
          const statement = f.db.prepare(sql);
          return {
            ...statement,
            async all(...parameters) {
              reads.push("all");
              return statement.all(...parameters);
            },
            async get(...parameters) {
              reads.push("get");
              return statement.get(...parameters);
            },
          };
        },
      } satisfies SqlDatabase;
      expect(await listDelegatedProjectsPage(db, f.access, [FIX.projectA])).toEqual({
        projects: [expected],
        hasMore: false,
      });
      expect(await listDelegatedTasksPage(db, f.access, [FIX.projectA])).toEqual({
        tasks: [f.root],
        limit: 50,
        has_more: false,
      });
      expect(reads).toEqual(["all", "all"]);
      expect(await credential(f)).toMatchObject({ scopes_json: JSON.stringify(["bfb:read"]) });
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it("production revocation rejects both collections, including terminal cursors, without business effects", async () => {
    const f = await fixture(),
      before = await snapshot(f);
    await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
    expect(await credential(f)).toMatchObject({ revoked_at: expect.any(String) });
    const after = await snapshot(f);
    expect(after.business).toEqual(before.business);
    expect(after.cursor).toEqual(before.cursor);
    for (const reader of [listDelegatedProjectsPage, listDelegatedTasksPage])
      await expect(
        reader(f.db, f.access, [FIX.projectA], { cursor: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ" }),
      ).rejects.toMatchObject(FAILURE);
    expect(await snapshot(f)).toEqual(after);
  });

  it("robustness: an array containing read scope plus a non-string scope is not valid collection authority", async () => {
    const f = await fixture();
    await f.db
      .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
      .run(JSON.stringify(["bfb:read", 17]), FIX.workspace, f.delegationId);
    expect(await credential(f)).toMatchObject({ scopes_json: JSON.stringify(["bfb:read", 17]) });
    const before = await snapshot(f);
    for (const reader of [listDelegatedProjectsPage, listDelegatedTasksPage])
      await expect(reader(f.db, f.access, [FIX.projectA])).rejects.toMatchObject(FAILURE);
    expect(await snapshot(f)).toEqual(before);
  });

  it("client and original nullable ceilings remain exact rather than adopting same-target credential changes", async () => {
    for (const loss of ["client", "project_to_null", "task_to_root"] as const) {
      const f = await fixture();
      if (loss === "client") {
        await f.db
          .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
          .run("synthetic-other-domain-list-client", FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({
          client_id: "synthetic-other-domain-list-client",
        });
      } else if (loss === "project_to_null") {
        await f.db
          .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
          .run(FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({ project_id: null, task_id: null });
      } else {
        await f.db
          .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
          .run(f.root.id, FIX.workspace, f.delegationId);
        expect(await credential(f)).toMatchObject({ project_id: FIX.projectA, task_id: f.root.id });
      }
      const before = await snapshot(f);
      for (const reader of [listDelegatedProjectsPage, listDelegatedTasksPage])
        await expect(reader(f.db, f.access, [FIX.projectA])).rejects.toMatchObject(FAILURE);
      expect(await snapshot(f)).toEqual(before);
    }
  });

  it.each(["projects", "tasks"] as const)(
    "%s unchanged expiry after final SQL and arguments are prepared fails the selection sentinel",
    async (kind) => {
      const f = await fixture(FIX.member, { expiry: "+3 seconds" }),
        original = await credential(f),
        before = await snapshot(f);
      let observed = false;
      const db = {
        ...f.db,
        prepare(sql: string) {
          const statement = f.db.prepare(sql);
          return {
            ...statement,
            async all(...parameters) {
              expect(observed).toBe(false);
              observed = true;
              expect(sql).toContain("expires_at");
              const prepared = [...parameters];
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
              expect(parameters).toEqual(prepared);
              return statement.all(...parameters);
            },
          };
        },
      } satisfies SqlDatabase;
      const reader = kind === "projects" ? listDelegatedProjectsPage : listDelegatedTasksPage;
      await expect(reader(db, f.access, [FIX.projectA])).rejects.toMatchObject(FAILURE);
      expect(observed).toBe(true);
      expect(await snapshot(f)).toEqual(before);
      expect(await credential(f)).toEqual(original);
    },
  );

  it("authorized empty captured sets and terminal pages differ from revoked empty authority", async () => {
    const f = await fixture(),
      before = await snapshot(f);
    expect(await listDelegatedProjectsPage(f.db, f.access, [])).toEqual({
      projects: [],
      hasMore: false,
    });
    expect(await listDelegatedTasksPage(f.db, f.access, [], { limit: 2 })).toEqual({
      tasks: [],
      limit: 2,
      has_more: false,
    });
    expect(
      await listDelegatedTasksPage(f.db, f.access, [FIX.projectA], {
        limit: 1,
        cursor: "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
      }),
    ).toEqual({ tasks: [], limit: 1, has_more: false });
    expect(await snapshot(f)).toEqual(before);
    await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
    const revoked = await snapshot(f);
    for (const reader of [listDelegatedProjectsPage, listDelegatedTasksPage])
      await expect(reader(f.db, f.access, [])).rejects.toMatchObject(FAILURE);
    expect(await snapshot(f)).toEqual(revoked);
  });

  it("project metadata follows current project authority and ascending visible-only pagination, not task privacy", async () => {
    const f = await fixture(FIX.member, { workspaceBoundary: true });
    await privateTask(f, f.root.id);
    const projects = (
      await Promise.all(
        [FIX.projectA, FIX.projectB].map((id) => getProject(f.db, FIX.workspace, id)),
      )
    ).sort((a, b) => a!.id.localeCompare(b!.id));
    const first = await listDelegatedProjectsPage(f.db, f.access, [FIX.projectA, FIX.projectB], {
      limit: 1,
    });
    expect(first).toEqual({ projects: [projects[0]], hasMore: true, nextCursor: projects[0]!.id });
    expect(
      await listDelegatedProjectsPage(f.db, f.access, [FIX.projectA, FIX.projectB], {
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).toEqual({ projects: [projects[1]], hasMore: false });
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, f.humanId);
    expect(
      await f.db
        .prepare(
          "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
        )
        .get(FIX.workspace, FIX.projectA, f.humanId),
    ).toBeUndefined();
    const before = await snapshot(f);
    expect(await listDelegatedProjectsPage(f.db, f.access, [FIX.projectA])).toEqual({
      projects: [],
      hasMore: false,
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it("newly granted projects cannot widen a captured project subset mid-call", async () => {
    const f = await fixture(FIX.reviewer, { workspaceBoundary: true }),
      other = await f.create(`${TITLE}-OTHER-PROJECT`, undefined, FIX.projectB);
    await f.db
      .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectB, f.humanId);
    expect(
      await f.db
        .prepare(
          "SELECT human_id FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
        )
        .get(FIX.workspace, FIX.projectB, f.humanId),
    ).toEqual({ human_id: f.humanId });
    const before = await snapshot(f);
    expect(
      (await listDelegatedProjectsPage(f.db, f.access, [FIX.projectA])).projects.map(
        (row) => row.id,
      ),
    ).toEqual([FIX.projectA]);
    const page = await listDelegatedTasksPage(f.db, f.access, [FIX.projectA]);
    expect(page.tasks).toEqual([f.root]);
    expect(page.tasks.map((row) => row.id)).not.toContain(other.id);
    expect(await snapshot(f)).toEqual(before);
  });

  it("retained kernel control: task lookahead and last-delivered cursor count only current readable rows", async () => {
    const f = await fixture(),
      second = await f.create(`${TITLE}-SECOND`),
      hidden = await f.create(`${TITLE}-HIDDEN`);
    await privateTask(f, hidden.id);
    const visible = [f.root, second].sort((a, b) => a.id.localeCompare(b.id)),
      before = await snapshot(f);
    const first = await listDelegatedTasksPage(f.db, f.access, [FIX.projectA], { limit: 1 });
    expect(first).toEqual({
      tasks: [visible[0]],
      limit: 1,
      has_more: true,
      next_cursor: visible[0]!.id,
    });
    expect(
      await listDelegatedTasksPage(f.db, f.access, [FIX.projectA], {
        limit: 1,
        cursor: first.next_cursor!,
      }),
    ).toEqual({ tasks: [visible[1]], limit: 1, has_more: false });
    expect(await snapshot(f)).toEqual(before);
  });

  it("retained pruning control: an unreadable branch blocks a granted grandchild and root parent is redacted", async () => {
    const f = await fixture(FIX.member, { bound: true, parent: true }),
      branch = await f.create(`${TITLE}-BLOCKED`, f.root.id),
      grandchild = await f.create(`${TITLE}-GRANDCHILD`, branch.id),
      sibling = await f.create(`${TITLE}-SIBLING`, f.root.id);
    await privateTask(f, branch.id);
    await privateTask(f, grandchild.id, true);
    const before = await snapshot(f),
      page = await listDelegatedTasksPage(f.db, f.access, [FIX.projectA]);
    expect(f.root.parent_task_id).toBe(f.parent!.id);
    expect(page.tasks.map((row) => row.id)).toEqual([f.root.id, sibling.id].sort());
    expect(page.tasks.find((row) => row.id === f.root.id)?.parent_task_id).toBeNull();
    expect(page.tasks.find((row) => row.id === sibling.id)?.parent_task_id).toBe(f.root.id);
    expect(await snapshot(f)).toEqual(before);
  });

  it("current canonical edits and parent-only grant loss are projected together in the final task page", async () => {
    const f = await fixture(),
      child = await f.create(`${TITLE}-CHILD`, f.root.id),
      parentGrant = await privateTask(f, f.root.id, true);
    const edited = success(
      await f.hub.execute(updateTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          taskId: child.id,
          expectedVersion: child.resource_version,
          title: `${TITLE}-EDITED`,
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
    const before = await snapshot(f);
    expect(await listDelegatedTasksPage(f.db, f.access, [FIX.projectA])).toEqual({
      tasks: [{ ...edited, parent_task_id: null }],
      limit: 50,
      has_more: false,
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it("root access is required before a terminal cursor and losing it does not fake an empty subtree", async () => {
    const f = await fixture(FIX.member, { bound: true }),
      rootGrant = await privateTask(f, f.root.id, true),
      cursor = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
    expect(await listDelegatedTasksPage(f.db, f.access, [FIX.projectA], { cursor })).toEqual({
      tasks: [],
      limit: 50,
      has_more: false,
    });
    await f.db
      .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
      .run(new Date().toISOString(), FIX.workspace, rootGrant!);
    expect(
      await f.db
        .prepare("SELECT revoked_at FROM task_human_grants WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, rootGrant!),
    ).toMatchObject({ revoked_at: expect.any(String) });
    const before = await snapshot(f);
    await expect(
      listDelegatedTasksPage(f.db, f.access, [FIX.projectA], { cursor }),
    ).rejects.toMatchObject(FAILURE);
    expect(await snapshot(f)).toEqual(before);
  });
});
