// ABOUTME: Tests creator sharing over explicitly synthetic dormant policies and retained grants.
// ABOUTME: Checks effective metadata, historical retries and atomic late-authority rollback without activation.

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it } from "vitest";
import { bumpMemberEpoch } from "../src/authorization.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub, type HubCommand, type CommandOutcome } from "../src/hub.js";
import { randomUlid, syntheticUlid } from "../src/ids.js";
import { assertTaskAccess } from "../src/task-access.js";
import {
  grantTaskSharingCommand,
  revokeTaskSharingCommand,
  readTaskSharing,
  assertTaskSharingReceipt,
  type TaskSharingReceipt,
  type TaskSharingPermission,
} from "../src/task-sharing.js";
import { createTaskCommand } from "../src/work-commands.js";
import { openDomainDb } from "./helpers.js";
import { resultStagedD1 } from "./result-fixture.js";

const NOW = "2026-10-08T12:00:00.000Z";
const DENIED = { code: "not_found", message: "task sharing not found" };
let db: SqlDatabase, taskId: string, sharedId: string, otherTask: string;
const access = (humanId = FIX.member, authorizationEpoch = 1) => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
function request<T>(input: T, key = randomUlid(), humanId = FIX.member) {
  return {
    workspaceId: FIX.workspace,
    actorHumanId: humanId,
    authorizationEpoch: 1,
    idempotencyKey: key,
    input,
  };
}
function input(
  permission: TaskSharingPermission = "read",
  expectedAccessVersion = 1,
  humanId = FIX.reviewer,
) {
  return { taskId, humanId, permission, expectedAccessVersion };
}
function success<T>(result: CommandOutcome<T>): T {
  expect(result.ok, result.ok ? "committed" : result.error.code).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.result;
}
async function execute<T>(
  command: HubCommand<T, TaskSharingReceipt>,
  value: T,
  key = randomUlid(),
  humanId = FIX.member,
  database = db,
) {
  return new WorkspaceHub(database).execute(command, request(value, key, humanId));
}
async function snapshot() {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const result: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (["sqlite_sequence", "d1_migrations"].includes(name)) continue;
    expect(name.startsWith("sqlite_") || name.startsWith("_cf_")).toBe(false);
    result[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  return result;
}
function before(
  database: SqlDatabase,
  pattern: RegExp,
  change: () => Promise<void>,
  afterRead = false,
) {
  let fired = false;
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    prepare(sql) {
      const statement = source.prepare(sql);
      const cut = async () => {
        if (!fired && pattern.test(sql)) {
          fired = true;
          await change();
        }
      };
      return {
        run: (...params) => statement.run(...params),
        get: async (...params) => {
          if (!afterRead) await cut();
          const result = await statement.get(...params);
          if (afterRead) await cut();
          return result;
        },
        all: async (...params) => {
          await cut();
          return statement.all(...params);
        },
      };
    },
    withTransaction: (fn) => source.withTransaction((tx) => fn(wrap(tx))),
  });
  return { db: wrap(database), fired: () => fired };
}
async function restrict() {
  await db
    .prepare("UPDATE projects SET access_mode='restricted' WHERE workspace_id=? AND id=?")
    .run(FIX.workspace, FIX.projectA);
}
async function rawGrant(
  humanId: string,
  epoch = 1,
  permission: TaskSharingPermission = "read",
  target = taskId,
) {
  const id = randomUlid();
  // Synthetic retained policy history only; normal feature writes use the commands below.
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
    VALUES (?,?,?,?,?,?,?)`,
    )
    .run(FIX.workspace, id, target, humanId, epoch, permission, NOW);
  return id;
}

beforeEach(async () => {
  db = await openDomainDb();
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const task = success(
      await new WorkspaceHub(db).execute(
        createTaskCommand,
        request({
          projectId: FIX.projectA,
          title: `Synthetic sharing task ${index}`,
          priority: "P2",
        }),
      ),
    );
    ids.push(task.id);
    if (index !== 1) {
      // C11 creation remains unavailable: explicitly fixture-only dormant policy.
      await db
        .prepare(
          `INSERT INTO task_privacy
        (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)`,
        )
        .run(FIX.workspace, task.id, FIX.member, NOW);
    }
  }
  [taskId, sharedId, otherTask] = ids as [string, string, string];
});

describe("creator sharing lifecycle", () => {
  it("returns useful creator metadata and an authorized empty sentinel without read effects", async () => {
    const retained = await snapshot();
    expect(await readTaskSharing(db, access(), taskId)).toEqual({
      task_id: taskId,
      access_version: 1,
      grants: [],
      has_more: false,
    });
    expect(await snapshot()).toEqual(retained);
  });
  it.each(["private_owner", "shared", "missing", "other_workspace"] as const)(
    "uses one inaccessible sharing denial for %s",
    async (kind) => {
      const scope =
        kind === "private_owner"
          ? access(FIX.owner)
          : kind === "other_workspace"
            ? { ...access(), workspaceId: randomUlid() }
            : access();
      const id = kind === "shared" ? sharedId : kind === "missing" ? randomUlid() : taskId;
      const retained = await snapshot();
      await expect(readTaskSharing(db, scope, id)).rejects.toMatchObject(DENIED);
      expect(await snapshot()).toEqual(retained);
    },
  );
  it.each(["read", "contribute", "edit"] as const)(
    "does not give a named %s grantee sharing authority",
    async (permission) => {
      await rawGrant(FIX.owner, 1, permission);
      await expect(readTaskSharing(db, access(FIX.owner), taskId)).rejects.toMatchObject(DENIED);
      expect(await execute(grantTaskSharingCommand, input(), undefined, FIX.owner)).toMatchObject({
        ok: false,
        error: DENIED,
      });
    },
  );
  it.each(["actorDelegationId", "actorRunnerId", "actorSystemId"] as const)(
    "rejects %s before business effects",
    async (actor) => {
      const retained = await snapshot();
      const complete = request(input());
      const { actorHumanId: _humanId, ...nonhuman } = complete;
      const outcome = await new WorkspaceHub(db).execute(grantTaskSharingCommand, {
        ...(actor === "actorDelegationId" ? complete : nonhuman),
        [actor]: randomUlid(),
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await snapshot()).toEqual(retained);
    },
  );
  it("direct command calls reject defined empty nonhuman actor labels before reads or effects", async () => {
    const retained = await snapshot();
    for (const actor of ["actorDelegationId", "actorRunnerId", "actorSystemId"] as const) {
      const ctx = {
        workspaceId: FIX.workspace,
        db,
        now: NOW,
        actorHumanId: FIX.member,
        [actor]: "",
        authorizationEpoch: 1,
        cursorBase: 1,
      };
      await expect(grantTaskSharingCommand.run(input(), ctx)).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        revokeTaskSharingCommand.run(
          { taskId, grantId: randomUlid(), expectedAccessVersion: 1 },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await snapshot()).toEqual(retained);
  });
  it.each(["owner", "member", "reviewer"] as const)(
    "%s recipient permissions intersect their current kernel role",
    async (role) => {
      await db
        .prepare("UPDATE workspace_members SET role=? WHERE workspace_id=? AND human_id=?")
        .run(role, FIX.workspace, FIX.reviewer);
      for (const [index, permission] of (["read", "contribute", "edit"] as const).entries()) {
        const granted = success(
          await execute(grantTaskSharingCommand, input(permission, index * 2 + 1)),
        );
        const current = await readTaskSharing(db, access(), taskId);
        expect(current.grants).toEqual([
          {
            id: granted.grant_id,
            human_id: FIX.reviewer,
            authorization_epoch: 1,
            permission,
            created_at: expect.any(String),
          },
        ]);
        for (const action of ["read", "contribute", "edit"] as const) {
          const permitted =
            action === "read" ||
            (action === "contribute" && permission !== "read") ||
            (action === "edit" && permission === "edit" && role !== "reviewer");
          const result = assertTaskAccess(db, access(FIX.reviewer), taskId, action);
          if (permitted) await expect(result).resolves.toMatchObject({ taskId });
          else await expect(result).rejects.toMatchObject({ code: "not_found" });
        }
        success(
          await execute(revokeTaskSharingCommand, {
            taskId,
            grantId: granted.grant_id,
            expectedAccessVersion: index * 2 + 2,
          }),
        );
      }
    },
  );
  it("rejects self, absent recipient, existing grant and stale versions with no additional effects", async () => {
    let retained = await snapshot();
    expect(await execute(grantTaskSharingCommand, input("read", 1, FIX.member))).toMatchObject({
      ok: false,
      error: { code: "invalid_argument" },
    });
    expect(await execute(grantTaskSharingCommand, input("read", 1, randomUlid()))).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "sharing recipient not found" },
    });
    expect(await execute(grantTaskSharingCommand, input("read", 2))).toMatchObject({
      ok: false,
      error: { code: "stale_version" },
    });
    expect(await snapshot()).toEqual(retained);
    success(await execute(grantTaskSharingCommand, input()));
    retained = await snapshot();
    expect(await execute(grantTaskSharingCommand, input("edit", 2))).toMatchObject({
      ok: false,
      error: { code: "already_exists" },
    });
    expect(await snapshot()).toEqual(retained);
  });
  it.each(["extra", "wrong_permission", "newline_id", "missing_version"] as const)(
    "rejects closed-shape %s before effects",
    async (kind) => {
      const value: Record<string, unknown> = { ...input() };
      if (kind === "extra") value.ownerHumanId = FIX.owner;
      if (kind === "wrong_permission") value.permission = "owner";
      if (kind === "newline_id") value.humanId = `${FIX.reviewer}\n`;
      if (kind === "missing_version") delete value.expectedAccessVersion;
      const retained = await snapshot();
      expect(
        await execute(grantTaskSharingCommand, value as unknown as ReturnType<typeof input>),
      ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      expect(await snapshot()).toEqual(retained);
    },
  );
  it("retains revoked identities, requires explicit re-share and rejects foreign/missing/revoked targets", async () => {
    const granted = success(await execute(grantTaskSharingCommand, input("contribute")));
    const revoke = { taskId, grantId: granted.grant_id, expectedAccessVersion: 2 };
    const revoked = success(await execute(revokeTaskSharingCommand, revoke));
    expect(revoked.access_version).toBe(3);
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({
      grants: [],
      access_version: 3,
    });
    const retained = await snapshot();
    const foreign = await rawGrant(FIX.owner, 1, "read", otherTask);
    const afterForeign = await snapshot();
    for (const grantId of [granted.grant_id, foreign, randomUlid()]) {
      expect(
        await execute(revokeTaskSharingCommand, { taskId, grantId, expectedAccessVersion: 3 }),
      ).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "sharing grant not found" },
      });
    }
    expect(await snapshot()).toEqual(afterForeign);
    const reshared = success(await execute(grantTaskSharingCommand, input("edit", 3)));
    expect(reshared.grant_id).not.toBe(granted.grant_id);
    const history = await db
      .prepare("SELECT * FROM task_human_grants WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, granted.grant_id);
    expect(history).toEqual(
      (retained.task_human_grants as Array<{ id: string }>).find((r) => r.id === granted.grant_id),
    );
  });
  it("preserves exact historical retries after revocation while rejecting changed input", async () => {
    const key = randomUlid(),
      value = input();
    const granted = success(await execute(grantTaskSharingCommand, value, key));
    const revokeKey = randomUlid(),
      revoke = { taskId, grantId: granted.grant_id, expectedAccessVersion: 2 };
    const revoked = success(await execute(revokeTaskSharingCommand, revoke, revokeKey));
    const retained = await snapshot();
    expect(await execute(grantTaskSharingCommand, value, key)).toMatchObject({
      ok: true,
      replayed: true,
      result: granted,
    });
    expect(await execute(revokeTaskSharingCommand, revoke, revokeKey)).toMatchObject({
      ok: true,
      replayed: true,
      result: revoked,
    });
    expect(
      await execute(grantTaskSharingCommand, { ...value, permission: "edit" }, key),
    ).toMatchObject({ ok: false, error: { code: "request_rejected" } });
    expect(await snapshot()).toEqual(retained);
  });
  it.each(["recipient", "permission"] as const)(
    "denies a cached grant receipt bound to a different requested %s",
    async (mismatch) => {
      const key = randomUlid(),
        value = input();
      const granted = success(await execute(grantTaskSharingCommand, value, key));
      success(
        await execute(revokeTaskSharingCommand, {
          taskId,
          grantId: granted.grant_id,
          expectedAccessVersion: 2,
        }),
      );
      const substitute = await rawGrant(
        mismatch === "recipient" ? FIX.owner : FIX.reviewer,
        1,
        mismatch === "permission" ? "edit" : "read",
      );
      const cache = (await db
        .prepare("SELECT result_json FROM idempotency_records WHERE idempotency_key=?")
        .get(key)) as { result_json: string };
      // Synthetic stored-receipt corruption; immutable grant identities are never rewritten.
      const stored = JSON.parse(cache.result_json) as { result: TaskSharingReceipt };
      await db
        .prepare("UPDATE idempotency_records SET result_json=? WHERE idempotency_key=?")
        .run(JSON.stringify({ ...stored, result: { ...granted, grant_id: substitute } }), key);
      const retained = await snapshot();
      expect(await execute(grantTaskSharingCommand, value, key)).toMatchObject({
        ok: false,
        error: DENIED,
      });
      expect(await snapshot()).toEqual(retained);
    },
  );
  it("old epoch grants remain inert and do not block explicit sharing at the new epoch", async () => {
    const old = success(await execute(grantTaskSharingCommand, input()));
    await bumpMemberEpoch(db, FIX.workspace, FIX.reviewer);
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({ grants: [] });
    const renewed = success(await execute(grantTaskSharingCommand, input("read", 2)));
    expect(renewed.grant_id).not.toBe(old.grant_id);
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({
      grants: [{ authorization_epoch: 2 }],
    });
    expect(
      await db
        .prepare("SELECT authorization_epoch,revoked_at FROM task_human_grants WHERE id=?")
        .get(old.grant_id),
    ).toEqual({ authorization_epoch: 1, revoked_at: null });
  });
  it("recipient project loss removes effective metadata and rejects a new grant without changing project access", async () => {
    await restrict();
    const granted = success(await execute(grantTaskSharingCommand, input()));
    await db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectA, FIX.reviewer);
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({ grants: [] });
    const retained = await snapshot();
    expect(await execute(grantTaskSharingCommand, input("edit", 2))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await snapshot()).toEqual(retained);
    expect(
      await db.prepare("SELECT revoked_at FROM task_human_grants WHERE id=?").get(granted.grant_id),
    ).toEqual({ revoked_at: null });
  });
  it("bounds current effective grants with ordered one-row lookahead", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 101; index++) {
      const suffix = String(index).padStart(3, "0");
      const humanId = syntheticUlid(`SHAREH${suffix}`),
        grantId = syntheticUlid(`SHAREG${suffix}`);
      await db
        .prepare("INSERT INTO humans(id,email,display_name,created_at) VALUES(?,?,?,?)")
        .run(humanId, `share${index}@synthetic.test`, "Synthetic sharing recipient", NOW);
      await db
        .prepare(
          "INSERT INTO workspace_authorization_epochs(workspace_id,human_id,authorization_epoch,updated_at) VALUES(?,?,1,?)",
        )
        .run(FIX.workspace, humanId, NOW);
      await db
        .prepare(
          "INSERT INTO workspace_members(workspace_id,human_id,role,authorization_epoch,created_at) VALUES(?,?,'member',1,?)",
        )
        .run(FIX.workspace, humanId, NOW);
      await db
        .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES(?,?,?)")
        .run(FIX.workspace, FIX.projectA, humanId);
      await db
        .prepare(
          "INSERT INTO task_human_grants(workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES(?,?,?,?,1,'read',?)",
        )
        .run(FIX.workspace, grantId, taskId, humanId, NOW);
      ids.push(grantId);
    }
    const retained = await snapshot(),
      view = await readTaskSharing(db, access(), taskId);
    expect(view.has_more).toBe(true);
    expect(view.grants.map((g) => g.id)).toEqual(ids.sort().slice(0, 100));
    expect(await snapshot()).toEqual(retained);
  });
  it("a creator who is currently Owner retains the same sharing authority", async () => {
    await db
      .prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.member);
    const receipt = success(await execute(grantTaskSharingCommand, input()));
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({
      access_version: 2,
      grants: [{ id: receipt.grant_id, human_id: FIX.reviewer }],
    });
  });
  it("removal/rejoin never revives a retained old grant or prevents explicit new-epoch sharing", async () => {
    const first = success(await execute(grantTaskSharingCommand, input()));
    const history = await db
      .prepare("SELECT * FROM task_human_grants WHERE id=?")
      .get(first.grant_id);
    // Synthetic membership lifecycle; the immutable grant history is left intact.
    await db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.reviewer);
    await db
      .prepare("DELETE FROM workspace_members WHERE workspace_id=? AND human_id=?")
      .run(FIX.workspace, FIX.reviewer);
    await db
      .prepare(
        "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
      )
      .run(NOW, FIX.workspace, FIX.reviewer);
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({ grants: [] });
    const removed = await snapshot();
    expect(await execute(grantTaskSharingCommand, input("read", 2))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await snapshot()).toEqual(removed);
    await db
      .prepare(
        "UPDATE workspace_authorization_epochs SET authorization_epoch=2,revoked_at=NULL WHERE workspace_id=? AND human_id=?",
      )
      .run(FIX.workspace, FIX.reviewer);
    await db
      .prepare(
        "INSERT INTO workspace_members(workspace_id,human_id,role,authorization_epoch,created_at) VALUES(?,?,'reviewer',2,?)",
      )
      .run(FIX.workspace, FIX.reviewer, NOW);
    await db
      .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES(?,?,?)")
      .run(FIX.workspace, FIX.projectA, FIX.reviewer);
    await expect(assertTaskAccess(db, access(FIX.reviewer, 2), taskId)).rejects.toMatchObject({
      code: "not_found",
    });
    const second = success(await execute(grantTaskSharingCommand, input("read", 2)));
    expect(second.grant_id).not.toBe(first.grant_id);
    expect(await readTaskSharing(db, access(), taskId)).toMatchObject({
      grants: [{ authorization_epoch: 2 }],
    });
    expect(
      await db.prepare("SELECT * FROM task_human_grants WHERE id=?").get(first.grant_id),
    ).toEqual(history);
    await snapshot();
  });
  it.each(["epoch", "project", "role"] as const)(
    "late final selection denies %s loss even for an empty sharing list",
    async (loss) => {
      await restrict();
      let retained: Record<string, unknown> | undefined;
      const wrapped = before(db, /WITH sharing_task AS MATERIALIZED/, async () => {
        if (loss === "epoch") await bumpMemberEpoch(db, FIX.workspace, FIX.member);
        if (loss === "project")
          await db
            .prepare(
              "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.projectA, FIX.member);
        if (loss === "role")
          await db
            .prepare(
              "UPDATE workspace_members SET role='reviewer' WHERE workspace_id=? AND human_id=?",
            )
            .run(FIX.workspace, FIX.member);
        retained = await snapshot();
      });
      await expect(readTaskSharing(wrapped.db, access(), taskId)).rejects.toMatchObject(DENIED);
      expect(wrapped.fired()).toBe(true);
      expect(await snapshot()).toEqual(retained);
    },
  );
  it("cached receipt denies authority lost after the actual cache read without rewriting history", async () => {
    const key = randomUlid(),
      value = input();
    success(await execute(grantTaskSharingCommand, value, key));
    let retained: Record<string, unknown> | undefined;
    const staged = resultStagedD1(db);
    const wrapped = before(
      staged.db,
      /SELECT command_name, result_json FROM idempotency_records/,
      async () => {
        await bumpMemberEpoch(db, FIX.workspace, FIX.member);
        retained = await snapshot();
      },
      true,
    );
    expect(
      await execute(grantTaskSharingCommand, value, key, FIX.member, wrapped.db),
    ).toMatchObject({ ok: false, error: DENIED });
    expect(wrapped.fired()).toBe(true);
    expect(await snapshot()).toEqual(retained);
  });
  it.each([
    "creator_epoch",
    "creator_project",
    "recipient_epoch",
    "recipient_project",
    "version",
    "active_grant",
  ] as const)("grant commit rolls back every effect after independent %s loss", async (loss) => {
    await restrict();
    let retained: Record<string, unknown> | undefined,
      fired = false;
    const staged = resultStagedD1(db, async () => {
      fired = true;
      if (loss === "creator_epoch" || loss === "recipient_epoch")
        await bumpMemberEpoch(
          db,
          FIX.workspace,
          loss === "creator_epoch" ? FIX.member : FIX.reviewer,
        );
      if (loss === "creator_project" || loss === "recipient_project")
        await db
          .prepare(
            "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
          )
          .run(FIX.workspace, FIX.projectA, loss === "creator_project" ? FIX.member : FIX.reviewer);
      if (loss === "version")
        await db
          .prepare("UPDATE task_privacy SET access_version=2 WHERE workspace_id=? AND task_id=?")
          .run(FIX.workspace, taskId);
      if (loss === "active_grant") await rawGrant(FIX.reviewer);
      retained = await snapshot();
    });
    expect(
      await execute(grantTaskSharingCommand, input(), undefined, FIX.member, staged.db),
    ).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(fired).toBe(true);
    expect(await snapshot()).toEqual(retained);
    expect(await db.prepare("SELECT id FROM artifact_mutation_guards").all()).toEqual([]);
  });
  it("revoke commit rejects a independently revoked target and preserves the independent change", async () => {
    const grant = success(await execute(grantTaskSharingCommand, input()));
    let retained: Record<string, unknown> | undefined,
      fired = false;
    const staged = resultStagedD1(db, async () => {
      fired = true;
      await db
        .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
        .run(NOW, FIX.workspace, grant.grant_id);
      retained = await snapshot();
    });
    expect(
      await execute(
        revokeTaskSharingCommand,
        { taskId, grantId: grant.grant_id, expectedAccessVersion: 2 },
        undefined,
        FIX.member,
        staged.db,
      ),
    ).toMatchObject({ ok: false, error: { code: "command_failed" } });
    expect(fired).toBe(true);
    expect(await snapshot()).toEqual(retained);
  });
  it("public receipt final guard withholds a committed historical reply after creator loss", async () => {
    const receipt = success(await execute(grantTaskSharingCommand, input()));
    await bumpMemberEpoch(db, FIX.workspace, FIX.member);
    const retained = await snapshot();
    await expect(assertTaskSharingReceipt(db, access(), receipt)).rejects.toMatchObject(DENIED);
    expect(await snapshot()).toEqual(retained);
  });
  it("security and semantic receipts contain only bounded IDs and access versions", async () => {
    const receipt = success(await execute(grantTaskSharingCommand, input()));
    const rows = (await db
      .prepare(
        "SELECT payload_json FROM audit_events WHERE workspace_id=? AND action='task.sharing.grant'",
      )
      .all(FIX.workspace)) as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json);
    expect(payload.input).toEqual({ taskId });
    expect(payload.result).toEqual(receipt);
    expect(rows[0]!.payload_json).not.toContain("Synthetic sharing task");
    expect(rows[0]!.payload_json).not.toContain(FIX.reviewer);
    expect(rows[0]!.payload_json).not.toContain("permission");
  });
});
