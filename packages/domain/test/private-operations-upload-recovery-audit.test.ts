// ABOUTME: Proves upload-recovery audit receipts resolve exact current failed shared targets.
// ABOUTME: Historical envelope, ledger, actor, time and paging corruption cannot authorize delivery.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_RECOVERY_SYSTEM_ID } from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  readSecurityAudit,
  recoveryActionId,
  resolveStuckUploadCommand,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const NOW = "2026-10-06T12:00:00.000Z";
const OLD = "2026-10-06T10:00:00.000Z";
const ACTION = "ops.recovery.resolve_stuck_upload";
const CANARY = "SYNTHETIC-PRIVATE-UPLOAD-RECOVERY-AUDIT-CANARY";
const access = (humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
const read = (
  db: SqlDatabase,
  options: { after?: string; limit?: number; access?: TaskAccessContext } = {},
) => readSecurityAudit(db, FIX.workspace, { access: access(), ...options });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const task = success(
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: NOW,
      input: { projectId: FIX.projectA, title: "Synthetic recovery audit parent", priority: "P2" },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: NOW,
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
  await db.prepare("DELETE FROM audit_events WHERE workspace_id=?").run(FIX.workspace);
  return { db, hub, taskId: task.id, runId: run.run.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function target(
  f: Fixture,
  options: {
    runId?: string | null;
    versionId?: string;
    artifactId?: string;
    state?: string;
    at?: string;
  } = {},
) {
  const artifactId = options.artifactId ?? randomUlid(),
    versionId = options.versionId ?? randomUlid();
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'log','log',?,?)",
    )
    .run(
      FIX.workspace,
      artifactId,
      options.runId === undefined ? f.runId : options.runId,
      FIX.member,
      OLD,
    );
  // Synthetic metadata only: no uploaded bytes, capability or execution authority.
  await f.db
    .prepare(
      "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at) VALUES (?,?,?,?,'log',64,?,?,?,?)",
    )
    .run(
      FIX.workspace,
      versionId,
      artifactId,
      options.state ?? "failed",
      "a".repeat(64),
      options.state === "available" ? "b".repeat(64) : null,
      options.state === "available"
        ? `workspaces/${FIX.workspace}/runs/${f.runId}/logs/${versionId}.jsonl.zst`
        : null,
      options.at ?? OLD,
    );
  return { artifactId, versionId };
}
async function privatize(f: Fixture) {
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.taskId, FIX.member, NOW);
}
async function grant(f: Fixture, permission: string) {
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,permission,authorization_epoch,created_at) VALUES (?,?,?,?,?,1,?)",
    )
    .run(FIX.workspace, randomUlid(), f.taskId, FIX.owner, permission, NOW);
}
function envelope(
  ids: string[],
  actionId = recoveryActionId("resolve_stuck_upload", { version_ids: ids }),
) {
  return {
    actor: { humanId: FIX.owner, authorizationEpoch: 1 },
    input: { version_ids: ids },
    result: {
      action_id: actionId,
      kind: "resolve_stuck_upload",
      replayed: false,
      resolved: ids.length,
    },
  };
}
type Envelope = ReturnType<typeof envelope>;
async function receipt(
  f: Fixture,
  ids: string[],
  options: {
    actionId?: string;
    auditId?: string;
    at?: string;
    ledgerAt?: string;
    actor?: string;
    replayed?: boolean;
    action?: string;
    ledger?: boolean;
    ledgerActor?: string;
  } = {},
) {
  const actionId =
    options.actionId ?? recoveryActionId("resolve_stuck_upload", { version_ids: ids });
  const auditId = options.auditId ?? randomUlid(),
    at = options.at ?? NOW;
  const value = envelope(ids, actionId);
  value.actor.humanId = options.actor ?? FIX.owner;
  value.result.replayed = options.replayed ?? false;
  if (options.ledger !== false)
    await f.db
      .prepare(
        "INSERT INTO ops_recovery_ledger (workspace_id,action_id,kind,target_json,state,attempt_count,result_json,created_by_human_id,created_at,updated_at) VALUES (?,?,'resolve_stuck_upload',?,'applied',1,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        actionId,
        JSON.stringify({ version_ids: ids }),
        JSON.stringify({ resolved: ids.length }),
        options.ledgerActor ?? FIX.owner,
        options.ledgerAt ?? at,
        options.ledgerAt ?? at,
      );
  await f.db
    .prepare(
      "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(
      FIX.workspace,
      auditId,
      value.actor.humanId,
      options.action ?? ACTION,
      JSON.stringify(value),
      at,
    );
  return { auditId, actionId, value };
}
async function legacyReceipt(f: Fixture, at: string) {
  const auditId = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'ops.recover','{}',?)",
    )
    .run(FIX.workspace, auditId, FIX.owner, at);
  return { auditId, at };
}
async function artifactReceipt(f: Fixture, at: string) {
  const ref = await target(f, { runId: null }),
    auditId = randomUlid();
  // Canonical synthetic abandonment history, without bytes or a live grant.
  await f.db
    .prepare(
      "INSERT INTO artifact_audit_outbox (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at) VALUES (?,?,?,NULL,'artifact.abandoned','{}',?,?)",
    )
    .run(FIX.workspace, auditId, ref.versionId, OLD, at);
  await f.db
    .prepare(
      "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'artifact.abandoned','{}',?)",
    )
    .run(FIX.workspace, auditId, ARTIFACT_RECOVERY_SYSTEM_ID, at);
  return { auditId, at, versionId: ref.versionId };
}
async function expectChronology(f: Fixture, ordered: Array<{ auditId: string; at: string }>) {
  expect((await read(f.db)).entries.map((row) => [row.audit_id, row.created_at])).toEqual(
    ordered.map((row) => [row.auditId, row.at]),
  );
  let after: string | undefined;
  for (const [index, expected] of ordered.entries()) {
    const page = await read(f.db, { after, limit: 1 });
    expect(page.entries.map((row) => [row.audit_id, row.created_at])).toEqual([
      [expected.auditId, expected.at],
    ]);
    expect(page.has_more).toBe(index < ordered.length - 1);
    after = expected.auditId;
  }
  expect(await read(f.db, { after, limit: 1 })).toEqual({ entries: [], has_more: false });
}
async function payload(f: Fixture, id: string, value: unknown) {
  await f.db
    .prepare("UPDATE audit_events SET payload_json=? WHERE audit_id=?")
    .run(typeof value === "string" ? value : JSON.stringify(value), id);
}
async function expectHidden(f: Fixture, auditId: string) {
  expect(await read(f.db)).toEqual({ entries: [], has_more: false });
  await expect(read(f.db, { after: auditId })).rejects.toMatchObject({
    code: "invalid_argument",
    message: "unknown audit cursor",
  });
}
async function proof(f: Fixture, actor = FIX.owner) {
  return issueStepUpProof(
    f.db,
    actor,
    {
      action: "ops.recover",
      workspaceId: FIX.workspace,
      targetId: `ops-recover:resolve_stuck_upload:${FIX.workspace}`,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: "2026-10-06T12:05:00.000Z",
    },
    NOW,
  );
}
async function execute(f: Fixture, ids: string[], actor = FIX.owner) {
  return success(
    await f.hub.execute(resolveStuckUploadCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: actor,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: NOW,
      input: { versionIds: ids, stepUpProofId: await proof(f, actor) },
    }),
  );
}
function beforeSelection(db: SqlDatabase, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        ...statement,
        async get(...parameters: unknown[]) {
          if (!fired && sql.includes("audit_events")) {
            fired = true;
            await change();
          }
          return statement.get(...parameters);
        },
      };
    },
  };
}
async function rotate(db: SqlDatabase) {
  await db
    .prepare(
      "UPDATE workspace_members SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
  await db
    .prepare(
      "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE workspace_id=? AND human_id=?",
    )
    .run(FIX.workspace, FIX.owner);
}
async function demote(db: SqlDatabase) {
  await db.prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?").run(FIX.member);
  await db.prepare("UPDATE workspace_members SET role='member' WHERE human_id=?").run(FIX.owner);
}
async function restrict(db: SqlDatabase) {
  await db.prepare("UPDATE projects SET access_mode='restricted' WHERE id=?").run(FIX.projectA);
  await db
    .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
    .run(FIX.projectA, FIX.owner);
}
async function malformedRun(f: Fixture, kind: "missing_task" | "wrong_project") {
  const id = randomUlid();
  // Synthetic historical corruption, not a production mutation or creator claim.
  await f.db.prepare("PRAGMA foreign_keys=OFF").run();
  try {
    await f.db
      .prepare(
        "INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at) VALUES (?,?,?,?,?,?,'open','unknown',1,?)",
      )
      .run(
        FIX.workspace,
        id,
        kind === "wrong_project" ? FIX.projectB : FIX.projectA,
        kind === "missing_task" ? randomUlid() : f.taskId,
        FIX.owner,
        FIX.profileCodex,
        NOW,
      );
  } finally {
    await f.db.prepare("PRAGMA foreign_keys=ON").run();
  }
  return id;
}

describe("canonical upload-recovery security audit", () => {
  it("retains real Hub original and fresh-proof retry with unchanged redacted input display", async () => {
    const f = await fixture();
    const refs = [
      await target(f, { state: "uploading" }),
      await target(f, { runId: null, state: "uploading" }),
    ];
    const ids = refs.map((row) => row.versionId).reverse();
    const first = await execute(f, ids);
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
      .run(FIX.member);
    const retry = await execute(f, ids, FIX.member);
    expect(retry).toEqual({ ...first, replayed: true });
    const page = await read(f.db);
    expect(page.entries.map((entry) => entry.payload)).toEqual([
      {
        actor: { humanId: FIX.owner, authorizationEpoch: 1 },
        input: { version_ids: "[redacted]" },
        result: {
          action_id: first.action_id,
          kind: "resolve_stuck_upload",
          replayed: false,
          resolved: 2,
        },
      },
      {
        actor: { humanId: FIX.member, authorizationEpoch: 1 },
        input: { version_ids: "[redacted]" },
        result: {
          action_id: first.action_id,
          kind: "resolve_stuck_upload",
          replayed: true,
          resolved: 2,
        },
      },
    ]);
    expect(page.has_more).toBe(false);
  });
  it("retains an older ledger retry without original audit, attempt-count-one or creator-current-membership requirements", async () => {
    const f = await fixture(),
      ref = await target(f);
    const r = await receipt(f, [ref.versionId], {
      replayed: true,
      ledgerAt: OLD,
      ledgerActor: FIX.member,
    });
    await f.db
      .prepare("UPDATE ops_recovery_ledger SET attempt_count=4 WHERE action_id=?")
      .run(r.actionId);
    await execute(f, [ref.versionId]);
    expect((await read(f.db)).entries).toHaveLength(2);
    await f.db
      .prepare("UPDATE workspace_authorization_epochs SET revoked_at=? WHERE human_id=?")
      .run(NOW, FIX.member);
    expect((await read(f.db)).entries).toHaveLength(2);
  });
  it("omits a mixed visible/private target receipt completely without returning partial counts", async () => {
    const f = await fixture(),
      bound = await target(f),
      free = await target(f, { runId: null });
    const r = await receipt(f, [free.versionId, bound.versionId]);
    await privatize(f);
    await expectHidden(f, r.auditId);
  });
  it.each(["read", "contribute", "edit"])(
    "private %s grants do not authorize operations history",
    async (permission) => {
      const f = await fixture(),
        ref = await target(f),
        r = await receipt(f, [ref.versionId]);
      await privatize(f);
      await grant(f, permission);
      await expectHidden(f, r.auditId);
    },
  );
  it("private creator Owner does not override shared-only delivery", async () => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId]);
    await privatize(f);
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
      .run(FIX.member);
    expect(await read(f.db, { access: access(FIX.member) })).toEqual({
      entries: [],
      has_more: false,
    });
    await expect(
      read(f.db, { after: r.auditId, access: access(FIX.member) }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it.each(["missing_run", "missing_task", "wrong_project", "uploading", "available", "retained"])(
    "omits %s target history",
    async (kind) => {
      const f = await fixture();
      const runId =
        kind === "missing_run"
          ? randomUlid()
          : kind === "missing_task" || kind === "wrong_project"
            ? await malformedRun(f, kind)
            : f.runId;
      const ref = await target(f, {
        runId,
        state: ["uploading", "available", "retained"].includes(kind) ? kind : "failed",
      });
      const r = await receipt(f, [ref.versionId]);
      await expectHidden(f, r.auditId);
    },
  );
  it("does not reapply upload age or live grants to failed history", async () => {
    const f = await fixture(),
      ref = await target(f, { at: NOW }),
      r = await receipt(f, [ref.versionId]);
    await f.db
      .prepare(
        "INSERT INTO artifact_upload_grants (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,expected_digest,expires_at,consumed_at,created_at) VALUES (?,?,?,?,?,1,?,'log',64,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        randomUlid(),
        ref.versionId,
        "b".repeat(64),
        FIX.owner,
        f.runId,
        "a".repeat(64),
        "2026-10-06T12:10:00.000Z",
        NOW,
        NOW,
      );
    expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.auditId]);
  });
  it.each([
    "OPS.RECOVERY.RESOLVE_STUCK_UPLOAD",
    "ops.Recovery.resolve_stuck_upload",
    "ops.recovery.unknown",
  ])("quarantines unsupported namespace %s", async (action) => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId], { action });
    await expectHidden(f, r.auditId);
  });
  const corrupt: Array<[string, (r: Envelope) => unknown]> = [
    ["root scalar", () => 1],
    ["root array", () => []],
    ["root extra", (r) => ({ ...r, task_id: CANARY })],
    ["actor string object", (r) => ({ ...r, actor: JSON.stringify(r.actor) })],
    ["input string object", (r) => ({ ...r, input: JSON.stringify(r.input) })],
    ["result string object", (r) => ({ ...r, result: JSON.stringify(r.result) })],
    ["actor extra", (r) => ({ ...r, actor: { ...r.actor, delegationId: randomUlid() } })],
    ["actor mismatch", (r) => ({ ...r, actor: { ...r.actor, humanId: FIX.member } })],
    ["actor NUL", (r) => ({ ...r, actor: { ...r.actor, humanId: `${FIX.owner}\u0000${CANARY}` } })],
    ["epoch zero", (r) => ({ ...r, actor: { ...r.actor, authorizationEpoch: 0 } })],
    ["epoch fractional", (r) => ({ ...r, actor: { ...r.actor, authorizationEpoch: 1.5 } })],
    [
      "epoch unsafe",
      (r) => ({ ...r, actor: { ...r.actor, authorizationEpoch: 9007199254740992 } }),
    ],
    ["input extra", (r) => ({ ...r, input: { ...r.input, private_task_id: CANARY } })],
    ["input scalar", (r) => ({ ...r, input: { version_ids: 1 } })],
    [
      "input string array",
      (r) => ({ ...r, input: { version_ids: JSON.stringify(r.input.version_ids) } }),
    ],
    [
      "input duplicate",
      (r) => ({ ...r, input: { version_ids: [...r.input.version_ids, ...r.input.version_ids] } }),
    ],
    ["input wrong type", (r) => ({ ...r, input: { version_ids: [1] } })],
    ["input missing", (r) => ({ ...r, input: { version_ids: [randomUlid()] } })],
    [
      "input NUL",
      (r) => ({ ...r, input: { version_ids: [`${r.input.version_ids[0]}\u0000${CANARY}`] } }),
    ],
    ["result extra", (r) => ({ ...r, result: { ...r.result, task_id: CANARY } })],
    ["result kind", (r) => ({ ...r, result: { ...r.result, kind: "clear_recovery_state" } })],
    ["result replay integer", (r) => ({ ...r, result: { ...r.result, replayed: 0 } })],
    ["result count fractional", (r) => ({ ...r, result: { ...r.result, resolved: 1.5 } })],
    ["result count mismatch", (r) => ({ ...r, result: { ...r.result, resolved: 2 } })],
    [
      "result action uppercase",
      (r) => ({ ...r, result: { ...r.result, action_id: r.result.action_id.toUpperCase() } }),
    ],
    [
      "result action NUL",
      (r) => ({ ...r, result: { ...r.result, action_id: `${r.result.action_id}\u0000${CANARY}` } }),
    ],
  ];
  it.each(corrupt)("omits malformed %s without changing stored history", async (_name, change) => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId]);
    await payload(f, r.auditId, change(r.value));
    const stored = await f.db
      .prepare("SELECT payload_json FROM audit_events WHERE audit_id=?")
      .get(r.auditId);
    await expectHidden(f, r.auditId);
    expect(
      await f.db.prepare("SELECT payload_json FROM audit_events WHERE audit_id=?").get(r.auditId),
    ).toEqual(stored);
  });
  it.each(["root", "actor", "input", "result"])("rejects duplicate %s keys", async (part) => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId]);
    const raw = JSON.stringify(r.value);
    const changed =
      part === "root"
        ? raw.replace('"actor":', '"actor":{},"actor":')
        : part === "actor"
          ? raw.replace('"humanId":', '"humanId":"ignored","humanId":')
          : part === "input"
            ? raw.replace('"version_ids":', '"version_ids":[],"version_ids":')
            : raw.replace('"resolved":', '"resolved":0,"resolved":');
    await payload(f, r.auditId, changed);
    await expectHidden(f, r.auditId);
  });
  it.each([
    "missing",
    "kind",
    "state",
    "target_scalar",
    "target_array_string",
    "target_extra",
    "target_duplicate_key",
    "target_duplicate_id",
    "result_extra",
    "result_duplicate_key",
    "result_fractional",
    "result_wrong_count",
    "creator",
    "created_time",
    "updated_time",
  ])("omits corrupt ledger %s", async (kind) => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId], { ledger: kind !== "missing" });
    if (kind === "kind")
      await f.db
        .prepare("UPDATE ops_recovery_ledger SET kind='clear_recovery_state' WHERE action_id=?")
        .run(r.actionId);
    else if (kind === "state")
      await f.db
        .prepare("UPDATE ops_recovery_ledger SET state='failed' WHERE action_id=?")
        .run(r.actionId);
    else if (kind.startsWith("target_")) {
      const values: Record<string, string> = {
        target_scalar: "null",
        target_array_string: JSON.stringify({ version_ids: JSON.stringify([ref.versionId]) }),
        target_extra: JSON.stringify({ version_ids: [ref.versionId], task_id: CANARY }),
        target_duplicate_key: `{"version_ids":[],"version_ids":["${ref.versionId}"]}`,
        target_duplicate_id: JSON.stringify({ version_ids: [ref.versionId, ref.versionId] }),
      };
      await f.db
        .prepare("UPDATE ops_recovery_ledger SET target_json=? WHERE action_id=?")
        .run(values[kind], r.actionId);
    } else if (kind.startsWith("result_")) {
      const values: Record<string, string> = {
        result_extra: '{"resolved":1,"task_id":"SYNTHETIC"}',
        result_duplicate_key: '{"resolved":0,"resolved":1}',
        result_fractional: '{"resolved":1.5}',
        result_wrong_count: '{"resolved":2}',
      };
      await f.db
        .prepare("UPDATE ops_recovery_ledger SET result_json=? WHERE action_id=?")
        .run(values[kind], r.actionId);
    } else if (kind === "creator")
      await f.db
        .prepare("UPDATE ops_recovery_ledger SET created_by_human_id=? WHERE action_id=?")
        .run(FIX.member, r.actionId);
    else if (kind === "created_time" || kind === "updated_time")
      await f.db
        .prepare(
          `UPDATE ops_recovery_ledger SET ${kind === "created_time" ? "created_at" : "updated_at"}=? WHERE action_id=?`,
        )
        .run(`${NOW}\u0000${CANARY}`, r.actionId);
    await expectHidden(f, r.auditId);
  });
  it("requires exact input and ledger target order", async () => {
    const f = await fixture(),
      a = await target(f),
      b = await target(f),
      r = await receipt(f, [a.versionId, b.versionId]);
    r.value.input.version_ids.reverse();
    await payload(f, r.auditId, r.value);
    await expectHidden(f, r.auditId);
  });
  it.each(["ledger", "input"])(
    "matches decoded %s target values despite escaped JSON and whitespace",
    async (side) => {
      const f = await fixture(),
        ref = await target(f),
        r = await receipt(f, [ref.versionId]);
      const escaped = `\\u${ref.versionId.charCodeAt(0).toString(16).padStart(4, "0")}${ref.versionId.slice(1)}`;
      if (side === "ledger")
        await f.db
          .prepare("UPDATE ops_recovery_ledger SET target_json=? WHERE action_id=?")
          .run(`{ "version_ids" : [ "${escaped}" ] }`, r.actionId);
      else
        await payload(
          f,
          r.auditId,
          JSON.stringify(r.value).replace(JSON.stringify(ref.versionId), `"${escaped}"`),
        );
      expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.auditId]);
    },
  );
  it("binds a typed stored action ID without claiming SQL hash attestation", async () => {
    const f = await fixture(),
      ref = await target(f);
    const r = await receipt(f, [ref.versionId], {
      actionId: `ops:resolve_stuck_upload:${"0".repeat(32)}`,
    });
    expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.auditId]);
  });
  it("normalizes a non-JSON ledger array string before any JSON array processing", async () => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId]);
    await f.db
      .prepare("UPDATE ops_recovery_ledger SET target_json=? WHERE action_id=?")
      .run(JSON.stringify({ version_ids: CANARY }), r.actionId);
    await expectHidden(f, r.auditId);
  });
  it.each([0, 51])("rejects complete %s-target receipt and ledger arrays", async (length) => {
    const f = await fixture(),
      ids = Array.from({ length }, () => randomUlid()),
      r = await receipt(f, ids);
    await expectHidden(f, r.auditId);
  });
  it.each(["2026-10-06T11:59:59.999Z", "2026-10-06T12:00:00.001Z"])(
    "requires exact original ledger time for %s",
    async (ledgerAt) => {
      const f = await fixture(),
        ref = await target(f),
        r = await receipt(f, [ref.versionId], { ledgerAt });
      await expectHidden(f, r.auditId);
    },
  );
  it("omits a genuinely absent target with a matching receipt and ledger", async () => {
    const f = await fixture(),
      r = await receipt(f, [randomUlid()]);
    await expectHidden(f, r.auditId);
  });
  it("omits a foreign failed version rather than borrowing workspace authority", async () => {
    const f = await fixture(),
      workspaceId = randomUlid(),
      artifactId = randomUlid(),
      versionId = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version) VALUES (?,'recovery-audit-foreign','eu',?,1)",
      )
      .run(workspaceId, NOW);
    await f.db
      .prepare(
        "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,NULL,'log','log',?,?)",
      )
      .run(workspaceId, artifactId, FIX.owner, OLD);
    await f.db
      .prepare(
        "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'failed','log',64,?,?)",
      )
      .run(workspaceId, versionId, artifactId, "a".repeat(64), OLD);
    const r = await receipt(f, [versionId]);
    await expectHidden(f, r.auditId);
  });
  it.each([
    ["2026-10-06T12:00:00Z", "2026-10-06T12:00:00.001Z", true],
    ["2026-10-06T12:00:00.2Z", "2026-10-06T12:00:00.1Z", false],
    ["2026-10-06T12:00:00.000002Z", "2026-10-06T12:00:00.000001Z", false],
    ["2026-10-06T12:00:00.1Z", "2026-10-06T12:00:00.100000Z", true],
  ])("compares retry UTC %s to %s precisely", async (ledgerAt, at, visible) => {
    const f = await fixture(),
      ref = await target(f),
      r = await receipt(f, [ref.versionId], {
        ledgerAt: String(ledgerAt),
        at: String(at),
        replayed: true,
      });
    if (visible) expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.auditId]);
    else await expectHidden(f, r.auditId);
  });
  it.each([
    ["2026-10-06T12:00:00Z", "2026-10-06T12:00:00.1Z"],
    ["2026-10-06T12:00:00.1Z", "2026-10-06T12:00:00.100001Z"],
    ["2026-10-06T12:00:00.000001Z", "2026-10-06T12:00:00.000002Z"],
  ])("pages chronology from %s to %s without rewriting timestamps", async (earlier, later) => {
    const f = await fixture(),
      lateRef = await target(f, { runId: null }),
      earlyRef = await target(f, { runId: null }),
      late = await receipt(f, [lateRef.versionId], { at: later }),
      early = await receipt(f, [earlyRef.versionId], { at: earlier });
    await expectChronology(f, [
      { auditId: early.auditId, at: earlier },
      { auditId: late.auditId, at: later },
    ]);
  });
  it.each([
    ["2026-10-06T12:00:00Z", "2026-10-06T12:00:00.000000Z"],
    ["2026-10-06T12:00:00.1Z", "2026-10-06T12:00:00.100000Z"],
  ])("uses insertion chronology for equal instants %s and %s", async (firstAt, secondAt) => {
    const f = await fixture(),
      firstRef = await target(f, { runId: null }),
      secondRef = await target(f, { runId: null }),
      first = await receipt(f, [firstRef.versionId], { at: firstAt }),
      second = await receipt(f, [secondRef.versionId], { at: secondAt });
    await expectChronology(f, [
      { auditId: first.auditId, at: firstAt },
      { auditId: second.auditId, at: secondAt },
    ]);
  });
  it("shares chronology across canonical artifact and recovery while holding legacy pages", async () => {
    const f = await fixture(),
      ref = await target(f, { runId: null }),
      later = await legacyReceipt(f, "2026-10-06T12:00:00.100001Z"),
      artifact = await artifactReceipt(f, "2026-10-06T12:00:00Z"),
      recoveryAt = "2026-10-06T12:00:00.000000Z",
      recovery = await receipt(f, [ref.versionId], { at: recoveryAt }),
      fraction = await artifactReceipt(f, "2026-10-06T12:00:00.1Z");
    await expectChronology(f, [artifact, { auditId: recovery.auditId, at: recoveryAt }, fraction]);
    await expect(read(f.db, { after: later.auditId })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
    expect((await read(f.db)).entries[0]?.payload).toEqual({
      schema_version: 1,
      outbox_id: artifact.auditId,
      version_id: artifact.versionId,
      grant_id: null,
      source_action: "artifact.abandoned",
      occurred_at: OLD,
    });
  });
  it("holds malformed legacy timestamps without changing canonical chronology", async () => {
    const f = await fixture(),
      malformed = await legacyReceipt(f, "2026-10-06T12:00:00 malformed"),
      ref = await target(f, { runId: null }),
      at = "2026-10-06T12:00:00Z",
      valid = await receipt(f, [ref.versionId], { at });
    await expectChronology(f, [{ auditId: valid.auditId, at }]);
    await expect(read(f.db, { after: malformed.auditId })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
  });
  it.each(["audit_id", "audit_time", "version_id", "artifact_id", "run_id"])(
    "rejects joined canonical %s NULs",
    async (field) => {
      const f = await fixture();
      const nul = `${randomUlid()}\u0000${CANARY}`;
      const ref = await target(f, {
        ...(field === "version_id" ? { versionId: nul } : {}),
        ...(field === "artifact_id" ? { artifactId: nul } : {}),
        ...(field === "run_id" ? { runId: `${f.runId}\u0000${CANARY}` } : {}),
      });
      const r = await receipt(f, [ref.versionId], {
        ...(field === "audit_id" ? { auditId: nul } : {}),
        ...(field === "audit_time" ? { at: `${NOW}\u0000${CANARY}` } : {}),
      });
      await expectHidden(f, r.auditId);
    },
  );
  it("filters hidden-only rows before page slots and has_more", async () => {
    const f = await fixture(),
      privateRef = await target(f),
      free = await target(f, { runId: null });
    await receipt(f, [privateRef.versionId]);
    const visible = await receipt(f, [free.versionId]);
    await privatize(f);
    expect((await read(f.db, { limit: 1 })).entries.map((row) => row.audit_id)).toEqual([
      visible.auditId,
    ]);
    expect((await read(f.db, { limit: 1 })).has_more).toBe(false);
    expect(await read(f.db, { after: visible.auditId, limit: 1 })).toEqual({
      entries: [],
      has_more: false,
    });
  });
  it.each(["privacy", "project", "epoch", "role", "count", "ledger"])(
    "rechecks %s in the final source selection",
    async (loss) => {
      const f = await fixture(),
        ref = await target(f),
        r = await receipt(f, [ref.versionId]);
      const db = beforeSelection(f.db, async () => {
        if (loss === "privacy") await privatize(f);
        else if (loss === "project") await restrict(f.db);
        else if (loss === "epoch") await rotate(f.db);
        else if (loss === "role") await demote(f.db);
        else if (loss === "count")
          await f.db
            .prepare(
              "UPDATE ops_recovery_ledger SET result_json='{\"resolved\":0}' WHERE action_id=?",
            )
            .run(r.actionId);
        else
          await f.db.prepare("DELETE FROM ops_recovery_ledger WHERE action_id=?").run(r.actionId);
      });
      if (loss === "epoch" || loss === "role")
        await expect(read(db)).rejects.toMatchObject({
          code: "not_found",
          message: "operations scope not found",
        });
      else expect(await read(db)).toEqual({ entries: [], has_more: false });
    },
  );
  it.each(["epoch", "role"])("denies empty page and unknown anchor after %s loss", async (loss) => {
    const f = await fixture();
    const db = beforeSelection(f.db, () => (loss === "epoch" ? rotate(f.db) : demote(f.db)));
    await expect(read(db, { after: randomUlid() })).rejects.toMatchObject({
      code: "not_found",
      message: "operations scope not found",
    });
  });
  it("holds unrelated legacy families without rewriting retained resource IDs", async () => {
    const f = await fixture(),
      id = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'ops.recover',?,?)",
      )
      .run(
        FIX.workspace,
        id,
        FIX.owner,
        JSON.stringify({ action_id: "legacy", task_id: "synthetic-uncertified" }),
        NOW,
      );
    expect(await read(f.db)).toEqual({ entries: [], has_more: false });
    expect(
      await f.db.prepare("SELECT payload_json FROM audit_events WHERE audit_id=?").get(id),
    ).toEqual({
      payload_json: JSON.stringify({ action_id: "legacy", task_id: "synthetic-uncertified" }),
    });
  });
});
