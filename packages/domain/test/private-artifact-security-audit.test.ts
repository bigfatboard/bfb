// ABOUTME: Proves canonical artifact audit delivery through current shared-parent Owner authority.
// ABOUTME: Historical payload, lineage, grant, cursor and credential corruption cannot enter pages.

import type { SqlDatabase } from "@bfb/db";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_AUDIT_ACTIONS,
  dispatchArtifactAuditCommand,
} from "../src/artifact-maintenance.js";
import { ARTIFACT_RECOVERY_SYSTEM_ID } from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { WorkspaceHub } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import { readSecurityAudit } from "../src/operations.js";
import type { TaskAccessContext } from "../src/task-access.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";

const SOURCE_TIME = "2026-10-06T12:00:00.000Z";
const DISPATCH_TIME = "2026-10-06T12:01:00.000Z";
const CANARY = "SYNTHETIC-PRIVATE-ARTIFACT-AUDIT-CANARY";
const access = (humanId = FIX.owner, authorizationEpoch = 1): TaskAccessContext => ({
  workspaceId: FIX.workspace,
  humanId,
  authorizationEpoch,
});
const read = (
  db: SqlDatabase,
  options: { after?: string; limit?: number; access?: TaskAccessContext } = {},
) => readSecurityAudit(db, FIX.workspace, { access: access(), ...options });
const uploadActions = new Set([
  "artifact.grant_issued",
  "artifact.grant_reissued",
  "artifact.grant_consumed",
  "artifact.upload_verified",
]);
const viewActions = new Set(["artifact.view_issued", "artifact.view_redeemed"]);

async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db);
  const task = success(
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: SOURCE_TIME,
      input: { projectId: FIX.projectA, title: "Synthetic artifact audit parent", priority: "P2" },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      now: SOURCE_TIME,
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
async function privatize(f: Fixture) {
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.taskId, FIX.member, SOURCE_TIME);
}
async function receipt(
  f: Fixture,
  action: string,
  options: {
    runId?: string | null;
    grantKind?: "upload" | "view" | "none" | "missing";
    grantRunId?: string | null;
    grantVersionId?: string;
    outboxId?: string;
    versionId?: string;
    artifactId?: string;
    wrapperId?: string;
    sourceVersionId?: string;
    sourceTime?: string;
    dispatchTime?: string;
    actor?: string;
    auditAction?: string;
    direct?: boolean;
    wrapper?: boolean;
    actualDispatch?: boolean;
  } = {},
) {
  const artifactId = options.artifactId ?? randomUlid(),
    versionId = options.versionId ?? randomUlid(),
    outboxId = options.outboxId ?? randomUlid(),
    wrapperId = options.wrapperId ?? randomUlid();
  const runId = options.runId === undefined ? f.runId : options.runId;
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,?,'markdown','review',?,?)",
    )
    .run(FIX.workspace, artifactId, runId, FIX.member, SOURCE_TIME);
  // Synthetic immutable history only, with no bucket bytes or live capability.
  await f.db
    .prepare(
      `INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
    VALUES (?,?,?,'available','markdown',64,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      versionId,
      artifactId,
      "a".repeat(64),
      "b".repeat(64),
      `workspaces/${FIX.workspace}/artifacts/sha256/${"b".repeat(64)}`,
      SOURCE_TIME,
      SOURCE_TIME,
    );
  const grantKind =
    options.grantKind ??
    (uploadActions.has(action) ? "upload" : viewActions.has(action) ? "view" : "none");
  const grantId = grantKind === "none" ? null : randomUlid();
  if (grantKind === "upload")
    await f.db
      .prepare(
        `INSERT INTO artifact_upload_grants
    (workspace_id,id,version_id,grant_hash,human_id,authorization_epoch,run_id,format,declared_size,expected_digest,expires_at,consumed_at,created_at)
    VALUES (?,?,?,?,?,1,?,'markdown',64,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        grantId,
        options.grantVersionId ?? versionId,
        randomUlid().padEnd(64, "a"),
        FIX.owner,
        options.grantRunId === undefined ? runId : options.grantRunId,
        "a".repeat(64),
        "2026-10-06T12:00:30.000Z",
        SOURCE_TIME,
        SOURCE_TIME,
      );
  if (grantKind === "view")
    await f.db
      .prepare(
        `INSERT INTO artifact_view_grants
    (workspace_id,id,version_id,grant_hash,view_nonce_hash,human_id,session_hash,authorization_epoch,content_hash,expires_at,consumed_at,created_at)
    VALUES (?,?,?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        grantId,
        options.grantVersionId ?? versionId,
        randomUlid().padEnd(64, "a"),
        "c".repeat(64),
        FIX.owner,
        "d".repeat(64),
        "b".repeat(64),
        "2026-10-06T12:00:30.000Z",
        SOURCE_TIME,
        SOURCE_TIME,
      );
  const projection = {
    schema_version: 1,
    outbox_id: outboxId,
    version_id: options.sourceVersionId ?? versionId,
    grant_id: grantId,
    source_action: action,
    occurred_at: options.sourceTime ?? SOURCE_TIME,
  };
  const dispatchTime = options.dispatchTime ?? DISPATCH_TIME;
  await f.db
    .prepare(
      `INSERT INTO artifact_audit_outbox (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
    VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      FIX.workspace,
      outboxId,
      projection.version_id,
      grantId,
      action,
      JSON.stringify({ task_id: CANARY, grant_hash: CANARY }),
      projection.occurred_at,
      options.actualDispatch ? null : dispatchTime,
    );
  const wrapper = {
    actor: { systemId: ARTIFACT_RECOVERY_SYSTEM_ID, authorizationEpoch: 1 },
    input: { outbox_id: outboxId },
    result: projection,
  };
  if (options.actualDispatch)
    success(
      await f.hub.execute(dispatchArtifactAuditCommand, {
        workspaceId: FIX.workspace,
        actorSystemId: ARTIFACT_RECOVERY_SYSTEM_ID,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: dispatchTime,
        input: { outboxId },
      }),
    );
  else {
    if (options.direct !== false)
      await f.db
        .prepare(
          "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          FIX.workspace,
          outboxId,
          options.actor ?? ARTIFACT_RECOVERY_SYSTEM_ID,
          options.auditAction ?? action,
          `not JSON ${CANARY}`,
          dispatchTime,
        );
    if (options.wrapper !== false)
      await f.db
        .prepare(
          "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'artifact.dispatch_audit',?,?)",
        )
        .run(
          FIX.workspace,
          wrapperId,
          options.actor ?? ARTIFACT_RECOVERY_SYSTEM_ID,
          JSON.stringify(wrapper),
          dispatchTime,
        );
  }
  return { artifactId, versionId, outboxId, wrapperId, grantId, projection, wrapper };
}
async function setWrapper(f: Fixture, id: string, payload: unknown) {
  await f.db
    .prepare("UPDATE audit_events SET payload_json=? WHERE audit_id=?")
    .run(typeof payload === "string" ? payload : JSON.stringify(payload), id);
}
function beforeSelection(db: SqlDatabase, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const run = async () => {
        if (!fired && sql.includes("audit_events")) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async get(...params: unknown[]) {
          await run();
          return statement.get(...params);
        },
        async all(...params: unknown[]) {
          await run();
          return statement.all(...params);
        },
      };
    },
  };
}
async function malformedRun(f: Fixture, kind: "missing_task" | "wrong_project") {
  const id = randomUlid();
  // Synthetic historical corruption, never a product command or forged author.
  await f.db.prepare("PRAGMA foreign_keys = OFF").run();
  try {
    await f.db
      .prepare(
        `INSERT INTO runs (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
      VALUES (?,?,?,?,?,?,'open','unknown',1,?)`,
      )
      .run(
        FIX.workspace,
        id,
        kind === "wrong_project" ? FIX.projectB : FIX.projectA,
        kind === "missing_task" ? randomUlid() : f.taskId,
        FIX.owner,
        FIX.profileCodex,
        SOURCE_TIME,
      );
  } finally {
    await f.db.prepare("PRAGMA foreign_keys = ON").run();
  }
  return id;
}
async function foreignVersion(f: Fixture) {
  const ws = randomUlid(),
    artifact = randomUlid(),
    version = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO workspaces (id,slug,jurisdiction,created_at,resource_version) VALUES (?,'audit-foreign','eu',?,1)",
    )
    .run(ws, SOURCE_TIME);
  await f.db
    .prepare(
      "INSERT INTO artifacts (workspace_id,id,run_id,format,role,created_by_human_id,created_at) VALUES (?,?,NULL,'markdown','review',?,?)",
    )
    .run(ws, artifact, FIX.member, SOURCE_TIME);
  await f.db
    .prepare(
      "INSERT INTO artifact_versions (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,created_at) VALUES (?,?,?,'uploading','markdown',64,?,?)",
    )
    .run(ws, version, artifact, "a".repeat(64), SOURCE_TIME);
  return version;
}

describe("canonical artifact security audit", () => {
  it("requires explicit human access without inferring Owner", async () => {
    const f = await fixture();
    await receipt(f, "artifact.finalized");
    await expect(readSecurityAudit(f.db, FIX.workspace, undefined as never)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      readSecurityAudit(f.db, FIX.workspace, { limit: 1 } as never),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
  it.each(ARTIFACT_AUDIT_ACTIONS)(
    "rebuilds %s and its wrapper without historical payloads",
    async (action) => {
      const f = await fixture(),
        r = await receipt(f, action);
      const result = await read(f.db);
      expect(result).toEqual({
        entries: [
          {
            audit_id: r.outboxId,
            actor_principal_id: ARTIFACT_RECOVERY_SYSTEM_ID,
            action,
            payload: r.projection,
            created_at: DISPATCH_TIME,
          },
          {
            audit_id: r.wrapperId,
            actor_principal_id: ARTIFACT_RECOVERY_SYSTEM_ID,
            action: "artifact.dispatch_audit",
            payload: r.wrapper,
            created_at: DISPATCH_TIME,
          },
        ],
        has_more: false,
      });
      expect(JSON.stringify(result)).not.toContain(CANARY);
      expect(
        (
          (await f.db
            .prepare("SELECT payload_json FROM audit_events WHERE audit_id=?")
            .get(r.outboxId)) as { payload_json: string }
        ).payload_json,
      ).toContain(CANARY);
    },
  );
  it("accepts both receipts produced by actual Hub dispatch", async () => {
    const f = await fixture(),
      r = await receipt(f, "artifact.finalized", { actualDispatch: true });
    const result = await read(f.db);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].payload).toEqual(r.projection);
    expect(result.entries[1].payload).toEqual(r.wrapper);
  });
  it.each(["creator", "read", "contribute", "edit"] as const)(
    "excludes private receipts for %s including named Owner grants",
    async (permission) => {
      const f = await fixture();
      for (const action of ARTIFACT_AUDIT_ACTIONS) await receipt(f, action);
      await privatize(f);
      if (permission === "creator")
        await f.db
          .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
          .run(FIX.member);
      else
        await f.db
          .prepare(
            "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,?,?)",
          )
          .run(FIX.workspace, randomUlid(), f.taskId, FIX.owner, permission, SOURCE_TIME);
      expect(
        await read(f.db, { access: access(permission === "creator" ? FIX.member : FIX.owner) }),
      ).toEqual({ entries: [], has_more: false });
    },
  );
  it("retains expired/consumed grant and retained version history for true NULL runfree parents", async () => {
    const f = await fixture();
    const r = await receipt(f, "artifact.grant_consumed", { runId: null });
    await f.db.prepare("UPDATE artifact_versions SET state='retained' WHERE id=?").run(r.versionId);
    expect((await read(f.db)).entries).toHaveLength(2);
  });
  it.each(["missing_task", "wrong_project", "foreign"] as const)(
    "does not infer workspace authority from %s lineage",
    async (kind) => {
      const f = await fixture();
      const r = await receipt(
        f,
        "artifact.finalized",
        kind === "foreign"
          ? { sourceVersionId: await foreignVersion(f) }
          : { runId: await malformedRun(f, kind) },
      );
      expect(await read(f.db, { limit: 1 })).toEqual({ entries: [], has_more: false });
      for (const after of [r.outboxId, r.wrapperId])
        await expect(read(f.db, { after })).rejects.toMatchObject({
          code: "invalid_argument",
          message: "unknown audit cursor",
        });
    },
  );
  it.each(["artifact.grant_issued", "artifact.view_issued"] as const)(
    "requires exact %s grant/version association",
    async (action) => {
      const f = await fixture(),
        valid = await receipt(f, "artifact.finalized"),
        invalid = await receipt(f, action, { grantVersionId: valid.versionId });
      expect((await read(f.db, { limit: 2 })).entries.map((row) => row.audit_id)).toEqual([
        valid.outboxId,
        valid.wrapperId,
      ]);
      expect((await read(f.db, { limit: 2 })).has_more).toBe(false);
      await expect(read(f.db, { after: invalid.outboxId })).rejects.toMatchObject({
        code: "invalid_argument",
        message: "unknown audit cursor",
      });
    },
  );
  it.each(["outboxId", "versionId", "artifactId", "wrapperId"] as const)(
    "filters non-ULID canonical %s before metadata delivery",
    async (field) => {
      const f = await fixture(),
        r = await receipt(f, "artifact.finalized", { [field]: CANARY });
      const result = await read(f.db, { limit: 1 });
      expect(result.entries.map((row) => row.audit_id)).toEqual(
        field === "wrapperId" ? [r.outboxId] : [],
      );
      expect(result.has_more).toBe(false);
      expect(JSON.stringify(result)).not.toContain(CANARY);
    },
  );
  it.each([
    "outboxId",
    "versionId",
    "artifactId",
    "wrapperId",
    "sourceTime",
    "dispatchTime",
  ] as const)(
    "rejects canonical %s NUL suffix before pagination and anchor delivery",
    async (field) => {
      const f = await fixture();
      const value = `${field === "sourceTime" ? SOURCE_TIME : field === "dispatchTime" ? DISPATCH_TIME : randomUlid()}\u0000${CANARY}`;
      const r = await receipt(f, "artifact.finalized", { [field]: value });
      const result = await read(f.db, { limit: 1 });
      expect(result).toEqual({
        entries:
          field === "wrapperId"
            ? [
                {
                  audit_id: r.outboxId,
                  actor_principal_id: ARTIFACT_RECOVERY_SYSTEM_ID,
                  action: "artifact.finalized",
                  payload: r.projection,
                  created_at: DISPATCH_TIME,
                },
              ]
            : [],
        has_more: false,
      });
      expect(JSON.stringify(result)).not.toContain(CANARY);
      for (const after of field === "wrapperId" ? [r.wrapperId] : [r.outboxId, r.wrapperId]) {
        await expect(read(f.db, { after })).rejects.toMatchObject({
          code: "invalid_argument",
          message: "unknown audit cursor",
        });
      }
    },
  );
  it.each([
    "2026-02-29T12:00:00Z",
    "1900-02-29T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-01-00T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:60:00Z",
    "2026-01-01T12:00:60Z",
    "2026-01-01 12:00:00Z",
    "2026-01-01t12:00:00Z",
    "2026-1-01T12:00:00Z",
    "2026-01-01T1x:00:00Z",
    "2026-01-01T12:00:00+03:00",
    "2026-01-01T12:00:00.Z",
    "2026-01-01T12:00:00.1234567Z",
    `${SOURCE_TIME} ${CANARY}`,
  ])("filters invalid canonical UTC source %s before pagination", async (sourceTime) => {
    const f = await fixture();
    await receipt(f, "artifact.finalized", { sourceTime });
    expect(await read(f.db, { limit: 1 })).toEqual({ entries: [], has_more: false });
  });
  it.each(["2024-02-29T23:59:59Z", "2000-02-29T12:00:00.1Z", "2026-10-06T12:00:00.123456Z"])(
    "retains typed UTC persistence shape %s",
    async (sourceTime) => {
      const f = await fixture();
      await receipt(f, "artifact.finalized", { sourceTime });
      expect((await read(f.db)).entries).toHaveLength(2);
    },
  );
  it.each(["audit_time", "counterpart_time", "dispatch_time"] as const)(
    "filters broken %s canonical dispatch tuple",
    async (kind) => {
      const f = await fixture(),
        r = await receipt(
          f,
          "artifact.finalized",
          kind === "dispatch_time" ? { dispatchTime: CANARY } : {},
        );
      if (kind !== "dispatch_time")
        await f.db
          .prepare("UPDATE audit_events SET created_at=? WHERE audit_id=?")
          .run(SOURCE_TIME, kind === "audit_time" ? r.wrapperId : r.outboxId);
      const rows = (await read(f.db)).entries.map((row) => row.audit_id);
      expect(rows).toEqual(kind === "audit_time" ? [r.outboxId] : []);
    },
  );
  it.each([
    "missing_run",
    "missing_version",
    "upload_wrong_run",
    "upload_wrong_table",
    "view_wrong_table",
    "null_grant",
    "unexpected_grant",
    "wrong_actor",
    "unsupported",
    "case_variant",
    "bad_time",
  ] as const)("omits %s before pagination and anchor resolution", async (kind) => {
    const f = await fixture();
    const action =
      kind === "view_wrong_table"
        ? "artifact.view_issued"
        : kind === "unexpected_grant"
          ? "artifact.finalized"
          : "artifact.grant_issued";
    const r = await receipt(f, action, {
      ...(kind === "missing_run" ? { runId: randomUlid() } : {}),
      ...(kind === "missing_version" ? { sourceVersionId: randomUlid() } : {}),
      ...(kind === "upload_wrong_run" ? { grantRunId: null } : {}),
      ...(kind === "upload_wrong_table" ? { grantKind: "view" as const } : {}),
      ...(kind === "view_wrong_table" || kind === "unexpected_grant"
        ? { grantKind: "upload" as const }
        : {}),
      ...(kind === "null_grant" ? { grantKind: "none" as const } : {}),
      ...(kind === "wrong_actor" ? { actor: FIX.owner } : {}),
      ...(kind === "unsupported" ? { auditAction: "artifact.create_version", wrapper: false } : {}),
      ...(kind === "case_variant" ? { auditAction: "Artifact.grant_issued", wrapper: false } : {}),
      ...(kind === "bad_time" ? { sourceTime: CANARY } : {}),
    });
    expect(await read(f.db, { limit: 1 })).toEqual({ entries: [], has_more: false });
    await expect(read(f.db, { after: r.outboxId })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
  });
  it.each([null, 7, [], "not JSON", { actor: null }, { actor: [], input: null, result: null }])(
    "omits malformed historical wrapper %j without JSON errors",
    async (payload) => {
      const f = await fixture(),
        r = await receipt(f, "artifact.finalized");
      await setWrapper(f, r.wrapperId, payload);
      expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.outboxId]);
    },
  );
  it.each([
    "root_extra",
    "actor_extra",
    "input_extra",
    "result_extra",
    "actor",
    "epoch",
    "input_id",
    "result_id",
    "version",
    "grant",
    "action",
    "time",
    "schema",
    "orphan",
  ] as const)("omits invalid wrapper %s while keeping valid direct receipt", async (kind) => {
    const f = await fixture(),
      r = await receipt(f, "artifact.finalized"),
      wrapper = structuredClone(r.wrapper) as {
        actor: Record<string, unknown>;
        input: Record<string, unknown>;
        result: Record<string, unknown>;
      };
    if (kind === "root_extra") Object.assign(wrapper, { task_id: CANARY });
    else if (kind.endsWith("_extra"))
      wrapper[kind.slice(0, -6) as "actor" | "input" | "result"].task_id = CANARY;
    else if (kind === "actor") wrapper.actor.systemId = FIX.owner;
    else if (kind === "epoch") wrapper.actor.authorizationEpoch = 2;
    else if (kind === "input_id") wrapper.input.outbox_id = randomUlid();
    else if (kind === "result_id") wrapper.result.outbox_id = randomUlid();
    else if (kind === "version") wrapper.result.version_id = randomUlid();
    else if (kind === "grant") wrapper.result.grant_id = randomUlid();
    else if (kind === "action") wrapper.result.source_action = "artifact.abandoned";
    else if (kind === "time") wrapper.result.occurred_at = DISPATCH_TIME;
    else if (kind === "schema") wrapper.result.schema_version = "1";
    else await f.db.prepare("DELETE FROM audit_events WHERE audit_id=?").run(r.outboxId);
    await setWrapper(f, r.wrapperId, wrapper);
    expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual(
      kind === "orphan" ? [] : [r.outboxId],
    );
    await expect(read(f.db, { after: r.wrapperId })).rejects.toMatchObject({
      code: "invalid_argument",
      message: "unknown audit cursor",
    });
  });
  it.each(["root", "actor", "input", "result"] as const)(
    "rejects duplicate keys in wrapper %s",
    async (kind) => {
      const f = await fixture(),
        r = await receipt(f, "artifact.finalized");
      let payload = JSON.stringify(r.wrapper);
      if (kind === "root") payload = payload.replace('"actor":', `"actor":{},"actor":`);
      else if (kind === "actor")
        payload = payload.replace('"systemId":', `"systemId":"${CANARY}","systemId":`);
      else if (kind === "input")
        payload = payload.replace('"input":{', `"input":{"outbox_id":"${CANARY}",`);
      else payload = payload.replace('"result":{', `"result":{"version_id":"${CANARY}",`);
      await setWrapper(f, r.wrapperId, payload);
      expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.outboxId]);
    },
  );
  it.each(["actor", "input", "result"] as const)(
    "rejects serialized JSON strings in wrapper %s object fields",
    async (field) => {
      const f = await fixture(),
        r = await receipt(f, "artifact.finalized");
      const wrapper = { ...r.wrapper, [field]: JSON.stringify(r.wrapper[field]) };
      await setWrapper(f, r.wrapperId, wrapper);
      expect((await read(f.db)).entries.map((row) => row.audit_id)).toEqual([r.outboxId]);
    },
  );
  it("does not let hidden rows consume pages or has_more and uses uniform hidden/unknown anchors", async () => {
    const f = await fixture(),
      visible = await receipt(f, "artifact.finalized", { runId: null }),
      hidden = await receipt(f, "artifact.finalized");
    await privatize(f);
    const page = await read(f.db, { limit: 2 });
    expect(page.entries.map((row) => row.audit_id)).toEqual([visible.outboxId, visible.wrapperId]);
    expect(page.has_more).toBe(false);
    for (const after of [hidden.outboxId, hidden.wrapperId, randomUlid()])
      await expect(read(f.db, { after })).rejects.toMatchObject({
        code: "invalid_argument",
        message: "unknown audit cursor",
      });
    expect(await read(f.db, { after: visible.wrapperId })).toEqual({
      entries: [],
      has_more: false,
    });
  });
  it.each(["epoch", "role", "privacy", "project"] as const)(
    "rechecks %s at final page/anchor selection",
    async (loss) => {
      const f = await fixture(),
        r = await receipt(f, "artifact.finalized");
      const db = beforeSelection(f.db, async () => {
        if (loss === "privacy") await privatize(f);
        else if (loss === "project") {
          await f.db
            .prepare("UPDATE projects SET access_mode='restricted' WHERE id=?")
            .run(FIX.projectA);
          await f.db
            .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
            .run(FIX.projectA, FIX.owner);
        } else if (loss === "role") {
          await f.db
            .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
            .run(FIX.member);
          await f.db
            .prepare("UPDATE workspace_members SET role='member' WHERE human_id=?")
            .run(FIX.owner);
        } else {
          await f.db
            .prepare("UPDATE workspace_members SET authorization_epoch=2 WHERE human_id=?")
            .run(FIX.owner);
          await f.db
            .prepare(
              "UPDATE workspace_authorization_epochs SET authorization_epoch=2 WHERE human_id=?",
            )
            .run(FIX.owner);
        }
      });
      await expect(read(db, { after: r.outboxId })).rejects.toMatchObject(
        loss === "epoch" || loss === "role"
          ? { code: "not_found", message: "operations scope not found" }
          : { code: "invalid_argument", message: "unknown audit cursor" },
      );
    },
  );
  it("checks current Owner scope before unknown anchor even when the page is empty", async () => {
    const f = await fixture();
    await expect(
      read(f.db, { access: access(FIX.member), after: randomUlid() }),
    ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
    await expect(read(f.db, { access: access(FIX.owner, 2) })).rejects.toMatchObject({
      code: "not_found",
      message: "operations scope not found",
    });
  });
  it("preserves unrelated audit sanitizer behavior without certifying its IDs", async () => {
    const f = await fixture(),
      id = randomUlid();
    await f.db
      .prepare(
        "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,'legacy.unrelated',?,?)",
      )
      .run(
        FIX.workspace,
        id,
        FIX.owner,
        JSON.stringify({ task_id: CANARY, body: CANARY, grant_secret: CANARY }),
        DISPATCH_TIME,
      );
    expect((await read(f.db)).entries[0].payload).toEqual({ task_id: CANARY });
  });
});
