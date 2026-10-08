// ABOUTME: Exercises unregistered private creation preparation and authority-family child quotas.
// ABOUTME: Synthetic staged D1 cuts verify immutable lineage, bounded receipts, retry fences and full rollback.

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it } from "vitest";
import { bumpMemberEpoch } from "../src/authorization.js";
import { resolveCommand } from "../src/command-catalog.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { createPrivateTaskCommand } from "../src/private-task-creation.js";
import {
  capturePublicBusinessAuthority,
  finalizePublicBusinessResult,
  withPublicBusinessAuthority,
} from "../src/public-business.js";
import { assertTaskAccess } from "../src/task-access.js";
import { grantTaskSharingCommand } from "../src/task-sharing.js";
import {
  assertAgentChildLimit,
  createTaskCommand,
  getTask,
  type CreateTaskInput,
} from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { resultStagedD1 } from "./result-fixture.js";

const now = "2026-10-08T12:00:00.000Z";
const title = "Synthetic unregistered private creation";
let db: SqlDatabase;
let hub: WorkspaceHub;
function actor(humanId = FIX.member) {
  return { workspaceId: FIX.workspace, actorHumanId: humanId, authorizationEpoch: 1, now };
}
function request(input: Partial<CreateTaskInput> = {}, humanId = FIX.member, key = randomUlid()) {
  return {
    ...actor(humanId),
    idempotencyKey: key,
    input: { projectId: FIX.projectA, title, priority: "P2", ...input } as CreateTaskInput,
  };
}
async function create(input: Partial<CreateTaskInput> = {}, humanId = FIX.member) {
  return success(await hub.execute(createPrivateTaskCommand, request(input, humanId)));
}
async function grant(taskId: string, permission: "read" | "contribute" | "edit" = "edit") {
  const policy = (await db
    .prepare("SELECT access_version FROM task_privacy WHERE task_id=?")
    .get(taskId)) as {
    access_version: number;
  };
  return success(
    await hub.execute(grantTaskSharingCommand, {
      ...actor(),
      idempotencyKey: randomUlid(),
      input: {
        taskId,
        humanId: FIX.owner,
        permission,
        expectedAccessVersion: policy.access_version,
      },
    }),
  );
}
async function snapshot() {
  const rows = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const result: Record<string, unknown[]> = {};
  for (const { name } of rows) {
    if (name.startsWith("sqlite_")) continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    result[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return result;
}
async function loseProject(humanId = FIX.member) {
  expect(
    (
      await db
        .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
        .run(FIX.workspace, FIX.projectA, humanId)
    ).changes,
  ).toBe(1);
}

beforeEach(async () => {
  db = await openDomainDb();
  hub = new WorkspaceHub(db);
});

describe("held direct-human private creation preparation", () => {
  it("creates an inferred-owner root atomically with a prose-free canonical receipt", async () => {
    expect(resolveCommand("task.private.create")).toBeUndefined();
    const created = await create();
    expect(created).toEqual({
      task_id: expect.any(String),
      project_id: FIX.projectA,
      parent_task_id: null,
      privacy_root_task_id: created.task_id,
    });
    expect(
      await db
        .prepare("SELECT owner_human_id,access_version FROM task_privacy WHERE task_id=?")
        .get(created.task_id),
    ).toEqual({ owner_human_id: FIX.member, access_version: 1 });
    expect(await getTask(db, FIX.workspace, created.task_id)).toBeUndefined();
    expect(
      await getTask(db, FIX.workspace, created.task_id, {
        workspaceId: FIX.workspace,
        humanId: FIX.member,
        authorizationEpoch: 1,
      }),
    ).toMatchObject({ title });
    expect(
      await getTask(db, FIX.workspace, created.task_id, {
        workspaceId: FIX.workspace,
        humanId: FIX.owner,
        authorizationEpoch: 1,
      }),
    ).toBeUndefined();
    for (const table of [
      "audit_events",
      "semantic_events",
      "outbox_records",
      "idempotency_records",
    ]) {
      expect(JSON.stringify(await db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(title);
    }
    expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("allows a private root beneath an editable shared parent without sharing it", async () => {
    const shared = success(await hub.execute(createTaskCommand, request({}, FIX.owner)));
    const created = await create({ parentTaskId: shared.id });
    expect(created).toMatchObject({
      parent_task_id: shared.id,
      privacy_root_task_id: created.task_id,
    });
    expect(await db.prepare("SELECT * FROM task_privacy_inheritance").all()).toEqual([]);
    expect(
      await getTask(db, FIX.workspace, created.task_id, {
        workspaceId: FIX.workspace,
        humanId: FIX.owner,
        authorizationEpoch: 1,
      }),
    ).toBeUndefined();
  });

  it("a named editor creates depth-two descendants without becoming their privacy owner", async () => {
    const root = await create();
    await grant(root.task_id);
    const child = await create({ parentTaskId: root.task_id }, FIX.owner);
    const nested = await create({ parentTaskId: child.task_id }, FIX.owner);
    for (const descendant of [child, nested]) {
      expect(descendant.privacy_root_task_id).toBe(root.task_id);
      expect(
        await db
          .prepare("SELECT created_by_human_id,created_by_delegation_id FROM tasks WHERE id=?")
          .get(descendant.task_id),
      ).toEqual({ created_by_human_id: FIX.owner, created_by_delegation_id: null });
      expect(
        await db.prepare("SELECT * FROM task_privacy WHERE task_id=?").all(descendant.task_id),
      ).toEqual([]);
      expect(
        await assertTaskAccess(
          db,
          { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 },
          descendant.task_id,
          "edit",
        ),
      ).toMatchObject({ privateOwnerHumanId: FIX.member, accessVersion: 2 });
    }
  });

  it.each(["read", "contribute"] as const)(
    "%s sharing cannot authorize private child creation",
    async (permission) => {
      const root = await create();
      await grant(root.task_id, permission);
      const before = await snapshot();
      expect(
        await hub.execute(
          createPrivateTaskCommand,
          request({ parentTaskId: root.task_id }, FIX.owner),
        ),
      ).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["actorDelegationId", "actorRunnerId", "actorSystemId"] as const)(
    "rejects %s without creating business state",
    async (field) => {
      const before = await snapshot();
      const operation = request();
      const envelope =
        field === "actorDelegationId"
          ? operation
          : {
              workspaceId: operation.workspaceId,
              authorizationEpoch: operation.authorizationEpoch,
              idempotencyKey: operation.idempotencyKey,
              now: operation.now,
              input: operation.input,
            };
      expect(
        await hub.execute(createPrivateTaskCommand, { ...envelope, [field]: randomUlid() }),
      ).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(["ownerHumanId", "visibility", "audience", "rootTaskId", "grantHumanIds"])(
    "rejects caller-selected %s instead of normalizing private intent",
    async (field) => {
      const operation = request();
      const before = await snapshot();
      expect(
        await hub.execute(createPrivateTaskCommand, {
          ...operation,
          input: { ...operation.input, [field]: FIX.owner },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await snapshot()).toEqual(before);
    },
  );

  it("retains original role/project ceilings even after current authority expands", async () => {
    const restricted = actor(FIX.reviewer);
    const authority = await capturePublicBusinessAuthority(db, restricted);
    await db
      .prepare("UPDATE workspace_members SET role='member' WHERE human_id=?")
      .run(FIX.reviewer);
    const before = await snapshot();
    const operation = request({}, FIX.reviewer);
    expect(
      await hub.execute(createPrivateTaskCommand, {
        ...operation,
        input: withPublicBusinessAuthority(createPrivateTaskCommand, operation.input, authority),
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await snapshot()).toEqual(before);
    await loseProject();
    const narrow = await capturePublicBusinessAuthority(db, actor());
    expect(narrow.projectIds).not.toContain(FIX.projectA);
    await db
      .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
      .run(FIX.workspace, FIX.projectA, FIX.member);
    const restored = request(),
      restoredBefore = await snapshot();
    expect(
      await hub.execute(createPrivateTaskCommand, {
        ...restored,
        input: withPublicBusinessAuthority(createPrivateTaskCommand, restored.input, narrow),
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await snapshot()).toEqual(restoredBefore);
  });

  it("keeps exact receipts historical but rejects changed retries and lost current project/epoch", async () => {
    const operation = request();
    const first = await hub.execute(createPrivateTaskCommand, operation);
    success(first);
    const before = await snapshot();
    expect(await hub.execute(createPrivateTaskCommand, operation)).toEqual({
      ...first,
      replayed: true,
    });
    expect(
      await hub.execute(createPrivateTaskCommand, {
        ...operation,
        input: { ...operation.input, title: title + " changed" },
      }),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(await snapshot()).toEqual(before);
    await loseProject();
    const deniedBefore = await snapshot();
    expect(await hub.execute(createPrivateTaskCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await snapshot()).toEqual(deniedBefore);
    await bumpMemberEpoch(db, FIX.workspace, FIX.member);
    expect(await hub.execute(createPrivateTaskCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "stale_authorization" },
    });
  });

  it("rejects extra fields in synthetic corrupted cached receipts instead of delivering them", async () => {
    const operation = request();
    success(await hub.execute(createPrivateTaskCommand, operation));
    const row = (await db
      .prepare(
        "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
      )
      .get(FIX.workspace, operation.idempotencyKey)) as { result_json: string };
    const stored = JSON.parse(row.result_json) as { result: Record<string, unknown> };
    stored.result.body = "Synthetic corrupt receipt field";
    await db
      .prepare(
        "UPDATE idempotency_records SET result_json=? WHERE workspace_id=? AND idempotency_key=?",
      )
      .run(JSON.stringify(stored), FIX.workspace, operation.idempotencyKey);
    const before = await snapshot();
    expect(await hub.execute(createPrivateTaskCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["project", "root-grant"] as const)(
    "late %s loss rolls back every staged business/Hub effect and permits a repaired same-key retry",
    async (cut) => {
      const root = await create(),
        sharing = await grant(root.task_id);
      const humanId = cut === "project" ? FIX.member : FIX.owner;
      const operation = request({ parentTaskId: root.task_id }, humanId);
      let baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
      let observed = false;
      const staged = resultStagedD1(db, async () => {
        if (observed) return;
        observed = true;
        if (cut === "project") await loseProject(humanId);
        else
          await db
            .prepare("UPDATE task_human_grants SET revoked_at=? WHERE id=?")
            .run(now, sharing.grant_id);
        baseline = await snapshot();
      });
      // This is a synthetic prebatch cut, not competing commands through the production FIFO.
      expect(
        await new WorkspaceHub(staged.db).execute(createPrivateTaskCommand, operation),
      ).toMatchObject({ ok: false, error: { code: "command_failed", message: "command failed" } });
      expect(observed).toBe(true);
      expect(await snapshot()).toEqual(baseline);
      if (cut === "project")
        await db
          .prepare("INSERT INTO project_access (workspace_id,project_id,human_id) VALUES (?,?,?)")
          .run(FIX.workspace, FIX.projectA, humanId);
      else await grant(root.task_id);
      expect(
        success(
          await new WorkspaceHub(resultStagedD1(db).db).execute(
            createPrivateTaskCommand,
            operation,
          ),
        ),
      ).toMatchObject({ privacy_root_task_id: root.task_id });
      expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(await db.prepare("SELECT * FROM artifact_mutation_guards").all()).toEqual([]);
    },
  );

  it("an association write failure cannot retain a shared child or Hub bookkeeping", async () => {
    const root = await create();
    const operation = request({ parentTaskId: root.task_id });
    const before = await snapshot();
    const staged = resultStagedD1(db);
    staged.fail(/INSERT INTO task_privacy_inheritance/u);
    const subject = new WorkspaceHub(staged.db);
    expect(await subject.execute(createPrivateTaskCommand, operation)).toMatchObject({
      ok: false,
      error: { code: "command_failed" },
    });
    expect(await snapshot()).toEqual(before);
    staged.fail();
    expect(success(await subject.execute(createPrivateTaskCommand, operation))).toMatchObject({
      privacy_root_task_id: root.task_id,
    });
  });

  it("post-Hub final selection withholds committed private creation after project loss without undoing history", async () => {
    const operation = request();
    const authority = await capturePublicBusinessAuthority(db, actor());
    const prepared = withPublicBusinessAuthority(
      createPrivateTaskCommand,
      operation.input,
      authority,
    );
    const created = success(
      await hub.execute(createPrivateTaskCommand, { ...operation, input: prepared }),
    );
    await loseProject();
    const retained = await snapshot();
    await expect(
      finalizePublicBusinessResult(createPrivateTaskCommand, prepared, created, {
        ...actor(),
        db,
        cursorBase: 0,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await snapshot()).toEqual(retained);
    expect(
      await db
        .prepare("SELECT owner_human_id FROM task_privacy WHERE task_id=?")
        .get(created.task_id),
    ).toEqual({ owner_human_id: FIX.member });
  });
});

describe("authority-family agent child quota", () => {
  it("private roots below a shared parent cannot consume its hidden shared-child quota", async () => {
    const parent = success(await hub.execute(createTaskCommand, request({}, FIX.owner)));
    for (let index = 0; index < 20; index++) await create({ parentTaskId: parent.id });
    await expect(assertAgentChildLimit(db, FIX.workspace, parent.id)).resolves.toBeUndefined();
    for (let index = 0; index < 20; index++)
      success(
        await hub.execute(createTaskCommand, request({ parentTaskId: parent.id }, FIX.owner)),
      );
    await expect(assertAgentChildLimit(db, FIX.workspace, parent.id)).rejects.toMatchObject({
      code: "child_limit_reached",
    });
    await db
      .prepare(
        "UPDATE tasks SET state='done' WHERE id=(SELECT id FROM tasks WHERE parent_task_id=? AND created_by_human_id=? LIMIT 1)",
      )
      .run(parent.id, FIX.owner);
    await expect(assertAgentChildLimit(db, FIX.workspace, parent.id)).resolves.toBeUndefined();
  });

  it("private parents count all active same-root children, not only agent-authored children", async () => {
    const root = await create();
    const children = [];
    for (let index = 0; index < 20; index++)
      children.push(await create({ parentTaskId: root.task_id }));
    await expect(assertAgentChildLimit(db, FIX.workspace, root.task_id)).rejects.toMatchObject({
      code: "child_limit_reached",
    });
    await db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(children[0]!.task_id);
    await expect(assertAgentChildLimit(db, FIX.workspace, root.task_id)).resolves.toBeUndefined();
  });
});
