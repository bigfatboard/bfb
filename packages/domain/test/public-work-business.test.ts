// ABOUTME: Proves public work and human measurement commands retain authority at cache and staged commit boundaries.
// ABOUTME: Canonical history, write-only contributions and run-free observations remain valid without new effects.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";

import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import {
  recordBrowserActivityCommand,
  startReviewTimerCommand,
  stopReviewTimerCommand,
} from "../src/measurements.js";
import {
  capturePublicBusinessAuthority,
  finalizePublicBusinessResult,
  withPublicBusinessAuthority,
} from "../src/public-business.js";
import {
  addCommentCommand,
  addContextCommand,
  addTaskDependencyCommand,
  addTaskLinkCommand,
  createTaskCommand,
  deliverDelegatedAgentContextCommand,
  reportProgressCommand,
  updateTaskCommand,
} from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const BODY = "SYNTHETIC-PUBLIC-WORK-BUSINESS";
const NOW = "2025-01-01T12:00:00.000Z";
const FAMILIES = [
  "comment",
  "progress",
  "context",
  "dependency",
  "link",
  "timer-start",
  "timer-stop",
  "activity",
] as const;
type Family = (typeof FAMILIES)[number];

async function snapshot(db: SqlDatabase) {
  const business: Record<string, unknown[]> = {},
    authority: Record<string, unknown[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    const group =
      name.startsWith("oauth_") ||
      name.startsWith("better_auth_") ||
      name === "preregistered_oauth_clients" ||
      [
        "workspace_members",
        "workspace_authorization_epochs",
        "project_access",
        "task_privacy",
        "task_human_grants",
      ].includes(name)
        ? authority
        : business;
    group[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return { business, authority };
}

async function fixture(humanId: string = FIX.member) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: BODY, priority: "P2" },
    }),
  );
  const other = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic other public task", priority: "P2" },
    }),
  );
  const actor = {
    workspaceId: FIX.workspace,
    actorHumanId: humanId,
    authorizationEpoch: 1,
    now: NOW,
  };
  return { db, hub, owner, task, other, actor, humanId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function family(f: Fixture, name: Family) {
  const common = { taskId: f.task.id };
  const choices = {
    comment: { command: addCommentCommand, input: { ...common, body: BODY, kind: "discussion" } },
    progress: {
      command: reportProgressCommand,
      input: { ...common, body: BODY, kind: "progress" },
    },
    context: {
      command: addContextCommand,
      input: { ...common, body: BODY, kind: "brief", audience: "agent" },
    },
    dependency: {
      command: addTaskDependencyCommand,
      input: { ...common, dependsOnTaskId: f.other.id },
    },
    link: {
      command: addTaskLinkCommand,
      input: {
        ...common,
        kind: "external",
        url: "https://synthetic.example.test/evidence",
        label: BODY,
      },
    },
    "timer-start": { command: startReviewTimerCommand, input: common },
    "timer-stop": { command: stopReviewTimerCommand, input: { timerId: "", expectedVersion: 1 } },
    activity: {
      command: recordBrowserActivityCommand,
      input: { observationId: randomUlid(), startedAt: "2025-01-01T11:59:00.000Z", endedAt: NOW },
    },
  };
  if (name === "timer-stop") {
    const timer = success(
      await f.hub.execute(startReviewTimerCommand, {
        ...f.actor,
        idempotencyKey: randomUlid(),
        input: common,
      }),
    );
    choices["timer-stop"].input.timerId = timer.id;
  }
  const choice = choices[name];
  return {
    command: choice.command as unknown as HubCommand<Record<string, unknown>, unknown>,
    request: {
      ...f.actor,
      idempotencyKey: randomUlid(),
      input: choice.input as Record<string, unknown>,
    },
  };
}

function cacheCut(f: Fixture, change: () => Promise<void>) {
  let observed = false,
    baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    withTransaction: (callback) => source.withTransaction((tx) => callback(wrap(tx))),
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        run: (...args) => statement.run(...args),
        all: (...args) => statement.all(...args),
        get: async (...args) => {
          const row = await statement.get(...args);
          if (!observed && row && sql.includes("FROM idempotency_records")) {
            observed = true;
            await change();
            baseline = await snapshot(f.db);
          }
          return row;
        },
      };
    },
  });
  return {
    hub: new WorkspaceHub(wrap(resultStagedD1(f.db).db)),
    observed: () => observed,
    baseline: () => baseline,
  };
}

async function loseProject(f: Fixture) {
  const result = await f.db
    .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
    .run(FIX.workspace, FIX.projectA, f.humanId);
  expect(result.changes).toBe(1);
}

async function delegation(f: Fixture, scopes = ["bfb:task:write"], taskId: string | null = null) {
  const id = randomUlid();
  const clock = (await f.db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS created_at, strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') AS expires_at",
    )
    .get()) as { created_at: string; expires_at: string };
  // Synthetic credentials retain genuine current membership and SQL-clock authority.
  await f.db
    .prepare(
      `INSERT INTO oauth_delegations
       (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,
        authorization_epoch,expires_at,created_at)
       VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,?,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      id,
      f.humanId,
      FIX.client,
      FIX.projectA,
      taskId,
      JSON.stringify(scopes),
      clock.expires_at,
      clock.created_at,
    );
  const actor = { ...f.actor, actorDelegationId: id };
  return {
    id,
    actor,
    authority: await capturePublicBusinessAuthority(f.db, actor),
  };
}

function measured(db: SqlDatabase, record: (sql: string, count: number) => void): SqlDatabase {
  return {
    withTransaction: (work) => db.withTransaction((tx) => work(measured(tx, record))),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...parameters) => {
          record(sql, parameters.length);
          return statement.run(...parameters);
        },
        get: (...parameters) => {
          record(sql, parameters.length);
          return statement.get(...parameters);
        },
        all: (...parameters) => {
          record(sql, parameters.length);
          return statement.all(...parameters);
        },
      };
    },
  };
}

async function privateGrant(f: Fixture, permission: "read" | "contribute" | "edit") {
  const id = randomUlid();
  await f.db
    .prepare(
      `INSERT INTO task_human_grants
       (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
       VALUES (?,?,?,?,1,?,?)`,
    )
    .run(FIX.workspace, id, f.task.id, f.humanId, permission, new Date().toISOString());
  return id;
}

async function makePrivate(f: Fixture, taskId = f.task.id) {
  // Private creation remains disabled; this is an explicit historical-policy fixture.
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.owner, new Date().toISOString());
}

describe("public work business authority", () => {
  it.each(FAMILIES)(
    "%s cannot return saved business results after current authority loss",
    async (name) => {
      const f = await fixture(),
        operation = await family(f, name);
      success(await f.hub.execute(operation.command, operation.request));
      const cut = cacheCut(f, async () => {
        if (name === "activity")
          expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
        else await loseProject(f);
      });
      const outcome = await cut.hub.execute(operation.command, operation.request);
      expect(cut.observed()).toBe(true);
      expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it.each(["create", "update", "context", "timer"] as const)(
    "%s rolls back all staged effects when project access is lost immediately before batch",
    async (name) => {
      const f = await fixture();
      const operation =
        name === "context"
          ? await family(f, "context")
          : name === "timer"
            ? await family(f, "timer-start")
            : {
                command: (name === "create"
                  ? createTaskCommand
                  : updateTaskCommand) as unknown as HubCommand<Record<string, unknown>, unknown>,
                request: {
                  ...f.actor,
                  idempotencyKey: randomUlid(),
                  input:
                    name === "create"
                      ? { projectId: FIX.projectA, title: BODY, priority: "P2" }
                      : { taskId: f.task.id, expectedVersion: 1, title: BODY },
                },
              };
      let arrived = false,
        baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
      const staged = resultStagedD1(f.db, async () => {
        arrived = true;
        await loseProject(f);
        baseline = await snapshot(f.db);
      });
      const outcome = await new WorkspaceHub(staged.db).execute(
        operation.command,
        operation.request,
      );
      expect(arrived).toBe(true);
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(await snapshot(f.db)).toEqual(baseline);
    },
  );

  it("historical stopped timer retries preserve the original open start and stopped finish", async () => {
    const f = await fixture(FIX.reviewer),
      start = { ...f.actor, idempotencyKey: randomUlid(), input: { taskId: f.task.id } };
    const original = await f.hub.execute(startReviewTimerCommand, start),
      timer = success(original);
    const stop = {
      ...f.actor,
      idempotencyKey: randomUlid(),
      input: { timerId: timer.id, expectedVersion: 1 },
    };
    const stopped = await f.hub.execute(stopReviewTimerCommand, stop);
    success(stopped);
    const before = await snapshot(f.db);
    expect(await f.hub.execute(startReviewTimerCommand, start)).toEqual({
      ...original,
      replayed: true,
    });
    expect(await f.hub.execute(stopReviewTimerCommand, stop)).toEqual({
      ...stopped,
      replayed: true,
    });
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("run-free Reviewer browser activity is a membership observation, not a fabricated task", async () => {
    const f = await fixture(FIX.reviewer),
      operation = await family(f, "activity");
    const original = await f.hub.execute(operation.command, operation.request);
    expect(success(original)).toMatchObject({
      task_id: null,
      human_id: FIX.reviewer,
      started_at: "2025-01-01T11:59:00.000Z",
      ended_at: NOW,
      occurred_at: expect.any(String),
    });
    const before = await snapshot(f.db);
    expect(await f.hub.execute(operation.command, operation.request)).toEqual({
      ...original,
      replayed: true,
    });
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("project-and-task-bound write-only child creation keeps every selection and CHECK within 100 bindings", async () => {
    const f = await fixture(),
      credential = await delegation(f, ["bfb:task:write"], f.task.id);
    const counts: Array<{ sql: string; count: number }> = [];
    const db = measured(resultStagedD1(f.db).db, (sql, count) => counts.push({ sql, count }));
    const hub = new WorkspaceHub(db);
    const request = {
      ...credential.actor,
      idempotencyKey: randomUlid(),
      input: withPublicBusinessAuthority(
        createTaskCommand,
        {
          projectId: FIX.projectA,
          parentTaskId: f.task.id,
          title: BODY,
          priority: "P2",
        },
        credential.authority,
      ),
    };
    const first = await hub.execute(createTaskCommand, request),
      child = success(first);
    expect(child).toMatchObject({ parent_task_id: f.task.id, state: "ready" });
    const before = await snapshot(f.db);
    expect(await hub.execute(createTaskCommand, request)).toEqual({ ...first, replayed: true });
    expect(await snapshot(f.db)).toEqual(before);
    expect(counts.some(({ sql }) => sql.includes("artifact_mutation_guards"))).toBe(true);
    expect(counts.some(({ sql }) => sql.includes("public_result_task"))).toBe(true);
    expect(Math.max(...counts.map(({ count }) => count))).toBeLessThanOrEqual(100);
    const final = counts.filter(({ sql }) => sql.includes("public_result_task"));
    console.info(
      "public bounded child parameter counts",
      final.map(({ count }) => count),
    );
  });

  it.each(["role", "projects"] as const)(
    "a later %s expansion cannot enlarge the captured public creation ceiling",
    async (ceiling) => {
      const f = await fixture(ceiling === "role" ? FIX.reviewer : FIX.member);
      if (ceiling === "projects") await loseProject(f);
      const authority = await capturePublicBusinessAuthority(f.db, f.actor);
      if (ceiling === "role") {
        expect(authority.role).toBe("reviewer");
        await f.db
          .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
          .run(FIX.workspace, f.humanId);
      } else {
        expect(authority.projectIds).not.toContain(FIX.projectA);
        await f.db
          .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, FIX.projectA, f.humanId);
      }
      const before = await snapshot(f.db);
      expect(
        await f.hub.execute(createTaskCommand, {
          ...f.actor,
          idempotencyKey: randomUlid(),
          input: withPublicBusinessAuthority(
            createTaskCommand,
            {
              projectId: FIX.projectA,
              title: BODY,
              priority: "P2",
            },
            authority,
          ),
        }),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await snapshot(f.db)).toEqual(before);
    },
  );

  it("the post-Hub public selector withholds an already committed update after current project loss", async () => {
    const f = await fixture();
    const authority = await capturePublicBusinessAuthority(f.db, f.actor);
    const input = withPublicBusinessAuthority(
      updateTaskCommand,
      {
        taskId: f.task.id,
        expectedVersion: 1,
        title: BODY,
      },
      authority,
    );
    const outcome = await f.hub.execute(updateTaskCommand, {
      ...f.actor,
      idempotencyKey: randomUlid(),
      input,
    });
    const historical = success(outcome);
    await loseProject(f);
    const before = await snapshot(f.db);
    await expect(
      finalizePublicBusinessResult(updateTaskCommand, input, historical, {
        ...f.actor,
        db: f.db,
        now: new Date().toISOString(),
        cursorBase: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await snapshot(f.db)).toEqual(before);
    expect(
      await f.db
        .prepare("SELECT title,resource_version FROM tasks WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.task.id),
    ).toEqual({ title: BODY, resource_version: 2 });
  });

  it("historical child fields stay historical while the final same-statement parent mask narrows", async () => {
    const f = await fixture();
    const child = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          projectId: FIX.projectA,
          parentTaskId: f.task.id,
          title: "Original child",
          priority: "P2",
        },
      }),
    );
    const authority = await capturePublicBusinessAuthority(f.db, f.actor);
    const input = withPublicBusinessAuthority(
      updateTaskCommand,
      {
        taskId: child.id,
        expectedVersion: 1,
        title: BODY,
      },
      authority,
    );
    const original = success(
      await f.hub.execute(updateTaskCommand, {
        ...f.actor,
        idempotencyKey: randomUlid(),
        input,
      }),
    );
    success(
      await f.hub.execute(updateTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { taskId: child.id, expectedVersion: 2, title: "Current child title" },
      }),
    );
    await makePrivate(f);
    const before = await snapshot(f.db);
    const delivered = await finalizePublicBusinessResult(updateTaskCommand, input, original, {
      ...f.actor,
      db: f.db,
      now: new Date().toISOString(),
      cursorBase: 0,
    });
    expect(delivered).toEqual({ ...original, parent_task_id: null });
    expect(delivered).toMatchObject({ title: BODY, resource_version: 2 });
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("write-only Reviewer contributions and Member edits retain safe historical retries", async () => {
    for (const [humanId, names] of [
      [FIX.reviewer, ["comment", "progress"]],
      [FIX.member, ["link"]],
    ] as const) {
      const f = await fixture(humanId),
        credential = await delegation(f);
      for (const name of names) {
        const operation = await family(f, name);
        const request = {
          ...operation.request,
          ...credential.actor,
          input: withPublicBusinessAuthority(
            operation.command,
            operation.request.input,
            credential.authority,
          ),
        };
        const original = await f.hub.execute(operation.command, request);
        success(original);
        const before = await snapshot(f.db);
        expect(await f.hub.execute(operation.command, request)).toEqual({
          ...original,
          replayed: true,
        });
        expect(await snapshot(f.db)).toEqual(before);
      }
      if (humanId === FIX.member) {
        const request = {
          ...credential.actor,
          idempotencyKey: randomUlid(),
          input: withPublicBusinessAuthority(
            updateTaskCommand,
            {
              taskId: f.task.id,
              expectedVersion: 1,
              title: BODY,
            },
            credential.authority,
          ),
        };
        const original = await f.hub.execute(updateTaskCommand, request);
        expect(success(original)).toMatchObject({ title: BODY, resource_version: 2 });
        const before = await snapshot(f.db);
        expect(await f.hub.execute(updateTaskCommand, request)).toEqual({
          ...original,
          replayed: true,
        });
        expect(await snapshot(f.db)).toEqual(before);
      }
    }
  });

  it("a revoked private contribution is not revived by a fresh read grant, but a fresh contribution permits the original retry", async () => {
    const f = await fixture();
    await makePrivate(f);
    const grantId = await privateGrant(f, "contribute");
    const operation = await family(f, "comment");
    const original = await f.hub.execute(operation.command, operation.request);
    success(original);
    let readGrantId: string | undefined;
    const cut = cacheCut(f, async () => {
      expect(
        (
          await f.db
            .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
            .run(new Date().toISOString(), FIX.workspace, grantId)
        ).changes,
      ).toBe(1);
      readGrantId = await privateGrant(f, "read");
    });
    expect(await cut.hub.execute(operation.command, operation.request)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(cut.observed()).toBe(true);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
    expect(readGrantId).toBeDefined();
    expect(
      (
        await f.db
          .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
          .run(new Date().toISOString(), FIX.workspace, readGrantId)
      ).changes,
    ).toBe(1);
    await privateGrant(f, "contribute");
    const before = await snapshot(f.db);
    expect(await f.hub.execute(operation.command, operation.request)).toEqual({
      ...original,
      replayed: true,
    });
    expect(await snapshot(f.db)).toEqual(before);
  });

  it.each(["client", "project", "task", "scopes"] as const)(
    "cached write-only contributions retain the original nullable credential %s ceiling",
    async (changed) => {
      const f = await fixture(FIX.reviewer),
        credential = await delegation(f);
      const operation = await family(f, "progress");
      const request = {
        ...operation.request,
        ...credential.actor,
        input: withPublicBusinessAuthority(
          operation.command,
          operation.request.input,
          credential.authority,
        ),
      };
      success(await f.hub.execute(operation.command, request));
      const cut = cacheCut(f, async () => {
        const column = {
          client: "client_id",
          project: "project_id",
          task: "task_id",
          scopes: "scopes_json",
        }[changed];
        const value = {
          client: "synthetic-different-client",
          project: null,
          task: f.task.id,
          scopes: JSON.stringify(["bfb:read"]),
        }[changed];
        expect(
          (
            await f.db
              .prepare(`UPDATE oauth_delegations SET ${column}=? WHERE workspace_id=? AND id=?`)
              .run(value, FIX.workspace, credential.id)
          ).changes,
        ).toBe(1);
        expect(
          await f.db
            .prepare(
              `SELECT ${column} AS value FROM oauth_delegations WHERE workspace_id=? AND id=?`,
            )
            .get(FIX.workspace, credential.id),
        ).toEqual({ value });
      });
      expect(await cut.hub.execute(operation.command, request)).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(cut.observed()).toBe(true);
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it("Reviewer scope loss at staged flush rolls back the contribution and all bookkeeping", async () => {
    const f = await fixture(FIX.reviewer),
      credential = await delegation(f);
    const operation = await family(f, "progress");
    let arrived = false,
      baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
    const staged = resultStagedD1(f.db, async () => {
      arrived = true;
      expect(
        (
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(JSON.stringify(["bfb:read"]), FIX.workspace, credential.id)
        ).changes,
      ).toBe(1);
      baseline = await snapshot(f.db);
    });
    expect(
      await new WorkspaceHub(staged.db).execute(operation.command, {
        ...operation.request,
        ...credential.actor,
        input: withPublicBusinessAuthority(
          operation.command,
          operation.request.input,
          credential.authority,
        ),
      }),
    ).toMatchObject({ ok: false, error: { code: "command_failed", message: "command failed" } });
    expect(arrived).toBe(true);
    expect(await snapshot(f.db)).toEqual(baseline);
  });

  it("read-only Reviewer context retries retain the originally delivered canonical subset after an append", async () => {
    const f = await fixture(FIX.reviewer);
    const context = success(
      await f.hub.execute(addContextCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { taskId: f.task.id, kind: "brief", audience: "agent", body: BODY },
      }),
    );
    const credential = await delegation(f, ["bfb:read"]);
    const request = {
      ...credential.actor,
      idempotencyKey: randomUlid(),
      input: withPublicBusinessAuthority(
        deliverDelegatedAgentContextCommand,
        { taskId: f.task.id },
        credential.authority,
      ),
    };
    const original = await f.hub.execute(deliverDelegatedAgentContextCommand, request);
    expect(success(original)).toEqual([expect.objectContaining({ id: context.id, body: BODY })]);
    success(
      await f.hub.execute(addContextCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          taskId: f.task.id,
          kind: "note",
          audience: "both",
          body: "Later canonical context",
        },
      }),
    );
    const before = await snapshot(f.db);
    expect(await f.hub.execute(deliverDelegatedAgentContextCommand, request)).toEqual({
      ...original,
      replayed: true,
    });
    expect(await snapshot(f.db)).toEqual(before);
    const receipt = await f.db
      .prepare("SELECT * FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?")
      .get(FIX.workspace, request.idempotencyKey);
    expect(JSON.stringify(receipt)).not.toContain("publicAuthority");
  });

  it("empty delegated context retry still rejects independent production revocation after cache lookup", async () => {
    const f = await fixture(),
      credential = await delegation(f, ["bfb:read"]);
    const request = {
      ...credential.actor,
      idempotencyKey: randomUlid(),
      input: withPublicBusinessAuthority(
        deliverDelegatedAgentContextCommand,
        { taskId: f.task.id },
        credential.authority,
      ),
    };
    expect(success(await f.hub.execute(deliverDelegatedAgentContextCommand, request))).toEqual([]);
    const cut = cacheCut(f, async () => {
      await revokeDelegation(f.db, FIX.workspace, credential.id, new Date().toISOString());
      expect(
        await f.db
          .prepare("SELECT revoked_at FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, credential.id),
      ).toEqual({ revoked_at: expect.any(String) });
    });
    expect(await cut.hub.execute(deliverDelegatedAgentContextCommand, request)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(cut.observed()).toBe(true);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });
});
