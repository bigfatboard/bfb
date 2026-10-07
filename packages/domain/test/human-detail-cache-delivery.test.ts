// ABOUTME: Exercises current authority after saved task and attention business replies are loaded.
// ABOUTME: Historical results survive healthy retries while independent permission loss cannot deliver them.

import type { SqlDatabase } from "@bfb/db";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { answerAttentionCommand, resolveAttentionCommand } from "../src/attention.js";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { revokeDelegation } from "../src/oauth.js";
import { requestDelegatedAttentionCommand } from "../src/remote-parity.js";
import { createTaskCommand, updateTaskCommand } from "../src/work-commands.js";
import {
  createExecutionCommand,
  createRunCommand,
  transitionExecutionCommand,
} from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const QUESTION = "SYNTHETIC-HUMAN-CACHED-QUESTION";
const ANSWER = "SYNTHETIC-HUMAN-CACHED-ANSWER";
const TITLE = "SYNTHETIC-HUMAN-CACHED-TASK";

async function snapshot(db: SqlDatabase) {
  const business: Record<string, unknown[]> = {},
    authority: Record<string, unknown[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf_") ||
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

async function fixture(
  humanId: string = FIX.member,
  kind: "clarification" | "credential" = "clarification",
) {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: TITLE, priority: "P2" },
    }),
  );
  const unrelated = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic unrelated cached target",
        priority: "P2",
      },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        taskId: task.id,
        expectedTaskVersion: 1,
        agentProfileId: FIX.profileCodex,
        workspacePolicyVersion: 1,
        projectPolicyVersion: 1,
        repositoryConfigVersion: 1,
        agentProfileVersion: 1,
      },
    }),
  );
  const execution = success(
    await hub.execute(createExecutionCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: { runId: run.run.id },
    }),
  );
  const runner = randomUlid(),
    thumbprint = "synthetic-cached-waiter-key";
  // Retained synthetic immutable waiter context: no launch, live lease or provider operation.
  await db
    .prepare(
      `INSERT INTO runners (workspace_id,id,owner_human_id,device_label,public_key_json,key_thumbprint,authorization_epoch,grant_epoch,token_epoch,enrolled_at) VALUES (?,?,?,'Synthetic historical waiter','{}',?,1,1,1,?)`,
    )
    .run(FIX.workspace, runner, FIX.owner, thumbprint, execution.created_at);
  await db
    .prepare("INSERT INTO runner_project_grants (workspace_id,runner_id,project_id) VALUES (?,?,?)")
    .run(FIX.workspace, runner, FIX.projectA);
  await db
    .prepare(
      `INSERT INTO execution_assignments (workspace_id,execution_id,assignment_generation,run_id,task_id,project_id,runner_id,checkout_id,physical_worktree_hash,requesting_human_id,requesting_human_epoch,runner_authorization_epoch,runner_grant_epoch,runner_key_thumbprint,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,1,1,1,?,?)`,
    )
    .run(
      FIX.workspace,
      execution.id,
      run.run.id,
      task.id,
      FIX.projectA,
      runner,
      randomUlid(),
      `sha256:${"b".repeat(64)}`,
      FIX.owner,
      thumbprint,
      execution.created_at,
    );
  success(
    await hub.execute(transitionExecutionCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        runId: run.run.id,
        executionId: execution.id,
        expectedVersion: 1,
        state: "ended",
        endReason: "process_exit",
      },
    }),
  );
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') AS expires_at",
    )
    .get()) as { now: string; expires_at: string };
  const delegationId = randomUlid();
  await db
    .prepare(
      `INSERT INTO oauth_delegations (workspace_id,id,human_id,client_id,resource,project_id,task_id,scopes_json,authorization_epoch,expires_at,created_at) VALUES (?,?,?,?,'https://bfb.example.test/mcp',?,?,?,1,?,?)`,
    )
    .run(
      FIX.workspace,
      delegationId,
      humanId,
      FIX.client,
      FIX.projectA,
      null,
      JSON.stringify(["bfb:task:write"]),
      clock.expires_at,
      clock.now,
    );
  const delegated = {
    workspaceId: FIX.workspace,
    actorHumanId: humanId,
    actorDelegationId: delegationId,
    authorizationEpoch: 1,
  };
  const input = { runId: run.run.id, kind, question: QUESTION, blocking: true };
  const key = randomUlid();
  const attention = success(
    await hub.execute(requestDelegatedAttentionCommand, {
      ...delegated,
      idempotencyKey: key,
      input,
    }),
  );
  return {
    db,
    hub,
    owner,
    task,
    unrelated,
    execution,
    runId: run.run.id,
    humanId,
    delegationId,
    delegated,
    input,
    key,
    attention,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function grant(f: Fixture, taskId: string, permission: "read" | "contribute" | "edit") {
  const id = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,task_id) DO NOTHING",
    )
    .run(FIX.workspace, taskId, FIX.owner, f.attention.requested_at);
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)",
    )
    .run(FIX.workspace, id, taskId, f.humanId, permission, f.attention.requested_at);
  return id;
}

async function revokeGrant(f: Fixture, id: string) {
  await f.db
    .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
    .run(new Date().toISOString(), FIX.workspace, id);
  expect(
    await f.db.prepare("SELECT revoked_at FROM task_human_grants WHERE id=?").get(id),
  ).toMatchObject({ revoked_at: expect.any(String) });
}

function replayDb(f: Fixture, change: () => Promise<void>, parentId?: string) {
  const staged = resultStagedD1(f.db).db;
  let loaded = false,
    observed = false,
    baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    withTransaction: (callback) => source.withTransaction((tx) => callback(wrap(tx))),
    prepare(sql) {
      const statement = source.prepare(sql);
      return {
        run: (...args) => statement.run(...args),
        all: (...args) => statement.all(...args),
        get: async (...args: unknown[]) => {
          const cache = sql.includes("FROM idempotency_records");
          const parentCut =
            loaded && parentId && sql.includes("FROM tasks AS task") && args.includes(parentId);
          if (parentCut && !observed) {
            observed = true;
            await change();
            baseline = await snapshot(f.db);
          }
          const row = await statement.get(...args);
          if (cache && row) {
            loaded = true;
            if (!parentId && !observed) {
              observed = true;
              await change();
              baseline = await snapshot(f.db);
            }
          }
          return row;
        },
      };
    },
  });
  return {
    hub: new WorkspaceHub(wrap(staged)),
    observed: () => observed,
    baseline: () => baseline,
  };
}

describe("human historical business cache delivery", () => {
  it("denies the readable cached target lost just before the old second parent read", async () => {
    const f = await fixture();
    const parent = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, title: "Synthetic cached parent", priority: "P2" },
      }),
    );
    const child = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, parentTaskId: parent.id, title: TITLE, priority: "P2" },
      }),
    );
    const targetGrant = await grant(f, child.id, "edit");
    await grant(f, parent.id, "read");
    const input = { taskId: child.id, expectedVersion: 1, title: TITLE },
      request = {
        workspaceId: FIX.workspace,
        actorHumanId: f.humanId,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input,
      };
    success(await f.hub.execute(updateTaskCommand, request));
    const interleave = replayDb(f, () => revokeGrant(f, targetGrant), parent.id);
    const outcome = await interleave.hub.execute(updateTaskCommand, request);
    expect(interleave.observed()).toBe(true);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "task not found" },
    });
    expect(JSON.stringify(outcome)).not.toContain(TITLE);
    expect(await snapshot(f.db)).toEqual(interleave.baseline());
  });

  it.each(["answer", "resolve"] as const)(
    "withholds cached human %s after contribution loss at saved-result lookup",
    async (kind) => {
      const f = await fixture(),
        grantId = await grant(f, f.task.id, "contribute");
      const answerInput = { attentionId: f.attention.id, expectedVersion: 1, answer: ANSWER };
      const answerKey = randomUlid();
      const answered = success(
        await f.hub.execute(answerAttentionCommand, {
          workspaceId: FIX.workspace,
          actorHumanId: f.humanId,
          authorizationEpoch: 1,
          idempotencyKey: answerKey,
          input: answerInput,
        }),
      );
      const key = randomUlid(),
        request = {
          workspaceId: FIX.workspace,
          actorHumanId: f.humanId,
          authorizationEpoch: 1,
          idempotencyKey: key,
        };
      const command = kind === "answer" ? answerAttentionCommand : resolveAttentionCommand;
      const input =
        kind === "answer"
          ? answerInput
          : { attentionId: f.attention.id, expectedVersion: answered.resource_version };
      // Answer retries use the original successful key; resolution gets its own immutable saved result.
      const replayRequest = {
        ...request,
        ...(kind === "answer" ? { idempotencyKey: answerKey } : {}),
        input,
      };
      if (kind === "resolve")
        success(
          await f.hub.execute(resolveAttentionCommand, {
            ...request,
            input: { attentionId: f.attention.id, expectedVersion: answered.resource_version },
          }),
        );
      const interleave = replayDb(f, () => revokeGrant(f, grantId));
      const outcome = await interleave.hub.execute(command as never, replayRequest as never);
      expect(interleave.observed()).toBe(true);
      expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(outcome)).not.toContain(ANSWER);
      expect(await snapshot(f.db)).toEqual(interleave.baseline());
    },
  );

  it("denies a delegated request cache after independently committed revocation", async () => {
    const f = await fixture();
    const interleave = replayDb(f, async () => {
      const before = await snapshot(f.db);
      await revokeDelegation(f.db, FIX.workspace, f.delegationId, new Date().toISOString());
      expect(
        await f.db
          .prepare("SELECT revoked_at FROM oauth_delegations WHERE id=?")
          .get(f.delegationId),
      ).toMatchObject({ revoked_at: expect.any(String) });
      expect((await snapshot(f.db)).business).toEqual(before.business);
    });
    const outcome = await interleave.hub.execute(requestDelegatedAttentionCommand, {
      ...f.delegated,
      idempotencyKey: f.key,
      input: f.input,
    });
    expect(interleave.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(outcome)).not.toContain(QUESTION);
    expect(await snapshot(f.db)).toEqual(interleave.baseline());
  });

  it.each([FIX.member, FIX.reviewer])(
    "retains historical write-only delegated attention for role %s",
    async (humanId) => {
      const f = await fixture(humanId);
      const answered = success(
        await f.hub.execute(answerAttentionCommand, {
          ...f.owner,
          idempotencyKey: randomUlid(),
          input: { attentionId: f.attention.id, expectedVersion: 1, answer: ANSWER },
        }),
      );
      success(
        await f.hub.execute(resolveAttentionCommand, {
          ...f.owner,
          idempotencyKey: randomUlid(),
          input: { attentionId: f.attention.id, expectedVersion: answered.resource_version },
        }),
      );
      const before = await snapshot(f.db),
        replay = await f.hub.execute(requestDelegatedAttentionCommand, {
          ...f.delegated,
          idempotencyKey: f.key,
          input: f.input,
        });
      expect(replay).toMatchObject({ ok: true, replayed: true, result: f.attention });
      expect(await snapshot(f.db)).toEqual(before);
    },
  );

  it("replays historical task creation fields and cursor without refreshing the saved reply", async () => {
    const f = await fixture(),
      input = { projectId: FIX.projectA, title: TITLE, priority: "P2" as const };
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input,
    };
    const original = await f.hub.execute(createTaskCommand, request),
      task = success(original);
    success(
      await f.hub.execute(updateTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: {
          taskId: task.id,
          expectedVersion: 1,
          title: "Synthetic current task title",
          punchline: "Synthetic current task body",
        },
      }),
    );
    const before = await snapshot(f.db);
    expect(await f.hub.execute(createTaskCommand, request)).toEqual({
      ...original,
      replayed: true,
    });
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("a cached task creation retains its Owner/Member role ceiling after idempotency selection", async () => {
    const f = await fixture(),
      input = { projectId: FIX.projectA, title: TITLE, priority: "P2" as const };
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input,
    };
    success(await f.hub.execute(createTaskCommand, request));
    const cut = replayDb(f, async () => {
      await f.db
        .prepare("UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, f.humanId);
      expect(
        await f.db
          .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND human_id=?")
          .get(FIX.workspace, f.humanId),
      ).toEqual({ role: "reviewer" });
    });
    const outcome = await cut.hub.execute(createTaskCommand, request);
    expect(cut.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(outcome)).not.toContain(TITLE);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it("keeps historical update fields but masks its unreadable historical parent in the final statement", async () => {
    const f = await fixture();
    const parent = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, title: "Synthetic historical parent", priority: "P2" },
      }),
    );
    const child = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, parentTaskId: parent.id, title: TITLE, priority: "P2" },
      }),
    );
    const parentGrant = await grant(f, parent.id, "read");
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { taskId: child.id, expectedVersion: 1, title: TITLE },
    };
    const original = await f.hub.execute(updateTaskCommand, request),
      saved = success(original);
    success(
      await f.hub.execute(updateTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { taskId: child.id, expectedVersion: 2, title: "Synthetic later update" },
      }),
    );
    const cut = replayDb(f, () => revokeGrant(f, parentGrant));
    const replay = await cut.hub.execute(updateTaskCommand, request);
    expect(cut.observed()).toBe(true);
    expect(replay).toEqual({
      ...original,
      replayed: true,
      result: { ...saved, parent_task_id: null },
    });
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it("keeps write-only delegated task update retries without requiring read scope", async () => {
    const f = await fixture(),
      request = {
        ...f.delegated,
        idempotencyKey: randomUlid(),
        input: { taskId: f.unrelated.id, expectedVersion: 1, title: TITLE },
      };
    const original = await f.hub.execute(updateTaskCommand, request);
    success(original);
    const before = await snapshot(f.db);
    expect(await f.hub.execute(updateTaskCommand, request)).toEqual({
      ...original,
      replayed: true,
    });
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("a fresh read grant cannot replace edit permission for a cached update at its old parent cut", async () => {
    const f = await fixture();
    const parent = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, title: "Synthetic edit ceiling parent", priority: "P2" },
      }),
    );
    const child = success(
      await f.hub.execute(createTaskCommand, {
        ...f.owner,
        idempotencyKey: randomUlid(),
        input: { projectId: FIX.projectA, parentTaskId: parent.id, title: TITLE, priority: "P2" },
      }),
    );
    const editGrant = await grant(f, child.id, "edit");
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { taskId: child.id, expectedVersion: 1, title: TITLE },
    };
    success(await f.hub.execute(updateTaskCommand, request));
    const cut = replayDb(
      f,
      async () => {
        await revokeGrant(f, editGrant);
        await grant(f, child.id, "read");
      },
      parent.id,
    );
    const outcome = await cut.hub.execute(updateTaskCommand, request);
    expect(cut.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(outcome)).not.toContain(TITLE);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it("a fresh read grant cannot authorize delivery of a cached human contribution", async () => {
    const f = await fixture(),
      contribute = await grant(f, f.task.id, "contribute");
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: f.humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { attentionId: f.attention.id, expectedVersion: 1, answer: ANSWER },
    };
    success(await f.hub.execute(answerAttentionCommand, request));
    const cut = replayDb(f, async () => {
      await revokeGrant(f, contribute);
      await grant(f, f.task.id, "read");
    });
    const outcome = await cut.hub.execute(answerAttentionCommand, request);
    expect(cut.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(outcome)).not.toContain(ANSWER);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it.each(["client", "project", "task"] as const)(
    "does not adopt changed original nullable %s authority after loading a delegated reply",
    async (field) => {
      const f = await fixture();
      const cut = replayDb(f, async () => {
        if (field === "client") {
          await f.db
            .prepare("UPDATE oauth_delegations SET client_id=? WHERE workspace_id=? AND id=?")
            .run(`${FIX.client}-changed`, FIX.workspace, f.delegationId);
          expect(
            await f.db
              .prepare("SELECT client_id FROM oauth_delegations WHERE id=?")
              .get(f.delegationId),
          ).toEqual({ client_id: `${FIX.client}-changed` });
        } else if (field === "project") {
          await f.db
            .prepare("UPDATE oauth_delegations SET project_id=NULL WHERE workspace_id=? AND id=?")
            .run(FIX.workspace, f.delegationId);
          expect(
            await f.db
              .prepare("SELECT project_id FROM oauth_delegations WHERE id=?")
              .get(f.delegationId),
          ).toEqual({ project_id: null });
        } else {
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.task.id, FIX.workspace, f.delegationId);
          expect(
            await f.db
              .prepare("SELECT task_id FROM oauth_delegations WHERE id=?")
              .get(f.delegationId),
          ).toEqual({ task_id: f.task.id });
        }
      });
      const outcome = await cut.hub.execute(requestDelegatedAttentionCommand, {
        ...f.delegated,
        idempotencyKey: f.key,
        input: f.input,
      });
      expect(cut.observed()).toBe(true);
      expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(outcome)).not.toContain(QUESTION);
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it.each(["scope", "epoch"] as const)(
    "repeats the delegated %s ceiling after saved reply selection",
    async (kind) => {
      const f = await fixture();
      const cut = replayDb(f, async () => {
        if (kind === "scope") {
          const scopes = JSON.stringify(["bfb:task:write", 17]);
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(scopes, FIX.workspace, f.delegationId);
          expect(
            await f.db
              .prepare("SELECT scopes_json FROM oauth_delegations WHERE id=?")
              .get(f.delegationId),
          ).toEqual({ scopes_json: scopes });
        } else expect(await bumpMemberEpoch(f.db, FIX.workspace, f.humanId)).toBe(2);
      });
      const outcome = await cut.hub.execute(requestDelegatedAttentionCommand, {
        ...f.delegated,
        idempotencyKey: f.key,
        input: f.input,
      });
      expect(cut.observed()).toBe(true);
      expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(outcome)).not.toContain(QUESTION);
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it("current kind answer-role loss withholds a saved credential answer even though membership remains", async () => {
    const f = await fixture(FIX.owner, "credential");
    const request = {
      ...f.owner,
      idempotencyKey: randomUlid(),
      input: { attentionId: f.attention.id, expectedVersion: 1, answer: ANSWER },
    };
    success(await f.hub.execute(answerAttentionCommand, request));
    // Promote the other real member first: losing the last Owner is not a valid authorization fixture.
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    const cut = replayDb(f, async () => {
      await f.db
        .prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND human_id=?")
        .run(FIX.workspace, FIX.owner);
      expect(
        await f.db
          .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND human_id=?")
          .get(FIX.workspace, FIX.owner),
      ).toEqual({ role: "member" });
    });
    const outcome = await cut.hub.execute(answerAttentionCommand, request);
    expect(cut.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(outcome)).not.toContain(ANSWER);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it("rejects a synthetically misbound canonical attention row after its historical cache was selected", async () => {
    const f = await fixture();
    const cut = replayDb(f, async () => {
      // Disposable corruption robustness only: do not rewrite the immutable assignment or invent a permission race.
      await f.db
        .prepare("UPDATE attention_requests SET task_id=? WHERE workspace_id=? AND id=?")
        .run(f.unrelated.id, FIX.workspace, f.attention.id);
      expect(
        await f.db.prepare("SELECT task_id FROM attention_requests WHERE id=?").get(f.attention.id),
      ).toEqual({ task_id: f.unrelated.id });
    });
    const outcome = await cut.hub.execute(requestDelegatedAttentionCommand, {
      ...f.delegated,
      idempotencyKey: f.key,
      input: f.input,
    });
    expect(cut.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it("unchanged delegated rows that naturally expire during saved reply lookup do not deliver", async () => {
    const f = await fixture();
    // Bind a short live deadline before admission; the row does not change while the cache await elapses.
    const expiry = (await f.db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 seconds') AS expires_at")
      .get()) as { expires_at: string };
    await f.db
      .prepare("UPDATE oauth_delegations SET expires_at=? WHERE workspace_id=? AND id=?")
      .run(expiry.expires_at, FIX.workspace, f.delegationId);
    const credential = await f.db
      .prepare("SELECT * FROM oauth_delegations WHERE id=?")
      .get(f.delegationId);
    const cut = replayDb(f, async () => {
      const live = () =>
        f.db
          .prepare(
            "SELECT julianday(expires_at)>julianday('now') AS live FROM oauth_delegations WHERE id=?",
          )
          .get(f.delegationId) as Promise<{ live: number }>;
      expect(await live()).toEqual({ live: 1 });
      const deadline = Date.now() + 10_000;
      while ((await live()).live === 1 && Date.now() < deadline) await delay(25);
      expect(await live()).toEqual({ live: 0 });
      expect(
        await f.db.prepare("SELECT * FROM oauth_delegations WHERE id=?").get(f.delegationId),
      ).toEqual(credential);
    });
    const outcome = await cut.hub.execute(requestDelegatedAttentionCommand, {
      ...f.delegated,
      idempotencyKey: f.key,
      input: f.input,
    });
    expect(cut.observed()).toBe(true);
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(JSON.stringify(outcome)).not.toContain(QUESTION);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });
});
