// ABOUTME: Proves uncertified diagnostic snapshots reject before cache, proof and mutation effects.
// ABOUTME: Historical diagnostic copies are retained but unavailable in audit and semantic replay pages.

import { createAuthorizationContext, type SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIX } from "../src/fixtures.js";
import { listWorkspaceEvents, WorkspaceHub, type HubCommand } from "../src/hub.js";
import { randomUlid } from "../src/ids.js";
import {
  buildDiagnosticInventory,
  consentDiagnosticUploadCommand,
  createDiagnosticBundleCommand,
  readSecurityAudit,
  renderDiagnosticInventory,
  sanitizeDiagnosticValue,
  scanDiagnosticText,
  type DiagnosticInventory,
} from "../src/operations.js";
import { issueStepUpProof } from "../src/step-up.js";
import { openDomainDb } from "./helpers.js";

const NOW = "2026-10-07T12:00:00.000Z";
const DENIAL = { code: "request_rejected", message: "diagnostic bundles are unavailable" };
const ACCESS = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };
const INVENTORY: DiagnosticInventory = {
  schema_version: 1,
  workspace_id: FIX.workspace,
  generated_at: NOW,
  generated_by: FIX.owner,
  sections: [{ name: "work", fields: { tasks: 7 } }],
};
const commands = [createDiagnosticBundleCommand, consentDiagnosticUploadCommand] as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

function recordSql(db: SqlDatabase) {
  const statements: string[] = [];
  const wrap = (source: SqlDatabase): SqlDatabase => ({
    ...source,
    prepare(sql) {
      statements.push(sql);
      return source.prepare(sql);
    },
    withTransaction(fn) {
      return source.withTransaction((tx) => fn(wrap(tx)));
    },
  });
  return { db: wrap(db), statements };
}
async function storedBundle(db: SqlDatabase, state = "pending_consent") {
  const id = randomUlid();
  await db
    .prepare(
      `INSERT INTO diagnostic_bundles (workspace_id,id,created_by_human_id,state,inventory_json,bundle_hash,redaction_status,r2_key,created_at,consented_at,uploaded_at,expires_at,last_error)
    VALUES (?,?,?,?,?,?,'passed',?,?,?,?,?,NULL)`,
    )
    .run(
      FIX.workspace,
      id,
      FIX.owner,
      state,
      JSON.stringify(INVENTORY),
      "a".repeat(64),
      state === "uploaded" ? `workspaces/${FIX.workspace}/diagnostics/${id}.json` : null,
      NOW,
      state === "consented" || state === "uploaded" ? NOW : null,
      state === "uploaded" ? NOW : null,
      "2026-10-08T12:00:00.000Z",
    );
  return id;
}
async function proof(db: SqlDatabase, name: string, id: string) {
  return issueStepUpProof(
    db,
    FIX.owner,
    {
      action: name === "diagnostic.generate" ? "diagnostic.generate" : "diagnostic.upload",
      workspaceId: FIX.workspace,
      targetId:
        name === "diagnostic.generate"
          ? `diagnostic:generate:${FIX.workspace}`
          : `diagnostic:${id}`,
      scopes: [],
      authorizationEpoch: 1,
      expiresAt: "2026-10-07T12:05:00.000Z",
    },
    NOW,
  );
}
function input(name: string, bundleId: string, proofId: string) {
  return name === "diagnostic.generate"
    ? { stepUpProofId: proofId }
    : { bundleId, stepUpProofId: proofId };
}
async function cache(db: SqlDatabase, name: string, key: string) {
  const raw = JSON.stringify({
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    cursor: 23,
    result: { inventory_json: JSON.stringify(INVENTORY), state: "uploaded", id: randomUlid() },
  });
  await db
    .prepare(
      "INSERT INTO idempotency_records (workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,?,?,?,?)",
    )
    .run(FIX.workspace, key, name, raw, NOW);
  return raw;
}
async function snapshot(db: SqlDatabase) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "diagnostic_bundles",
    "passkey_step_up_proofs",
    "idempotency_records",
    "workspace_cursors",
    "semantic_events",
    "audit_events",
    "outbox_records",
  ])
    result[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return result;
}
async function historicalCopies(db: SqlDatabase) {
  const ids: string[] = [];
  for (const [index, action] of [
    "diagnostic.generate",
    "diagnostic.upload_consent",
    "DIAGNOSTIC.future",
    "ops.retention.set",
  ].entries()) {
    const id = randomUlid();
    ids.push(id);
    await db
      .prepare(
        "INSERT INTO audit_events (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        id,
        FIX.owner,
        action,
        JSON.stringify({ bundle_id: randomUlid(), state: "consented", task_count: 7 }),
        NOW,
      );
    await db
      .prepare(
        "INSERT INTO semantic_events (workspace_id,event_id,workspace_cursor,kind,payload_json,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        FIX.workspace,
        id,
        index + 1,
        action,
        JSON.stringify({ inventory_json: JSON.stringify(INVENTORY), task_count: 7 }),
        NOW,
      );
  }
  return ids;
}

describe("diagnostic snapshot quarantine", () => {
  it.each(commands)(
    "rejects $name with a valid Owner proof without consuming or writing",
    async (command) => {
      const db = await openDomainDb(),
        bundleId = await storedBundle(db),
        proofId = await proof(db, command.name, bundleId),
        before = await snapshot(db),
        tracked = recordSql(db);
      const outcome = await new WorkspaceHub(tracked.db).execute(
        command as HubCommand<object, unknown>,
        {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: randomUlid(),
          now: NOW,
          input: input(command.name, bundleId, proofId),
        },
      );
      expect(outcome).toEqual({ ok: false, error: DENIAL });
      expect(
        tracked.statements.some((sql) =>
          /diagnostic_bundles|passkey_step_up_proofs|idempotency_records|workspace_cursors|semantic_events|audit_events|outbox_records/.test(
            sql,
          ),
        ),
      ).toBe(false);
      expect(await snapshot(db)).toEqual(before);
    },
  );
  it.each(commands)(
    "rejects cached $name before reading the successful historical record",
    async (command) => {
      const db = await openDomainDb(),
        key = randomUlid(),
        raw = await cache(db, command.name, key),
        tracked = recordSql(db);
      expect(
        await new WorkspaceHub(tracked.db).execute(command as HubCommand<object, unknown>, {
          workspaceId: FIX.workspace,
          actorHumanId: FIX.owner,
          authorizationEpoch: 1,
          idempotencyKey: key,
          now: NOW,
          input: input(command.name, randomUlid(), randomUlid()),
        }),
      ).toEqual({ ok: false, error: DENIAL });
      expect(tracked.statements.some((sql) => sql.includes("idempotency_records"))).toBe(false);
      expect(
        await db
          .prepare(
            "SELECT result_json FROM idempotency_records WHERE workspace_id=? AND idempotency_key=?",
          )
          .get(FIX.workspace, key),
      ).toEqual({ result_json: raw });
    },
  );
  it.each(commands)("checks current authority before cached $name quarantine", async (command) => {
    const db = await openDomainDb(),
      key = randomUlid();
    await cache(db, command.name, key);
    for (const authority of [
      { actorHumanId: FIX.member, authorizationEpoch: 1, code: "forbidden" },
      { actorHumanId: FIX.owner, authorizationEpoch: 2, code: "stale_authorization" },
      {
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        actorDelegationId: randomUlid(),
        code: "forbidden",
      },
    ]) {
      const outcome = await new WorkspaceHub(db).execute(command as HubCommand<object, unknown>, {
        workspaceId: FIX.workspace,
        idempotencyKey: key,
        now: NOW,
        input: input(command.name, randomUlid(), randomUlid()),
        ...authority,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: authority.code } });
    }
  });
  it("rejects mixed actors at Hub admission before any source or authority lookup", async () => {
    const db = await openDomainDb(),
      tracked = recordSql(db);
    for (const actor of [{ actorRunnerId: randomUlid() }, { actorSystemId: randomUlid() }]) {
      const outcome = await new WorkspaceHub(tracked.db).execute(createDiagnosticBundleCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { stepUpProofId: randomUlid() },
        ...actor,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_command_request" } });
    }
    expect(tracked.statements).toEqual([]);
  });
  it("does not select resource state or absent proof to choose consent denial", async () => {
    const db = await openDomainDb();
    for (const state of [
      "pending_consent",
      "consented",
      "uploaded",
      "expired",
      "failed",
      "missing",
    ]) {
      const id = state === "missing" ? randomUlid() : await storedBundle(db, state);
      const outcome = await new WorkspaceHub(db).execute(consentDiagnosticUploadCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        now: NOW,
        input: { bundleId: id, stepUpProofId: randomUlid() },
      });
      expect(outcome).toEqual({ ok: false, error: DENIAL });
    }
  });
  it("preserves structural closed input gates ahead of quarantine", async () => {
    const db = await openDomainDb();
    expect(
      await new WorkspaceHub(db).execute(createDiagnosticBundleCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { stepUpProofId: randomUlid(), extra: true } as { stepUpProofId: string },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(
      await new WorkspaceHub(db).execute(consentDiagnosticUploadCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: { bundleId: "malformed", stepUpProofId: randomUlid() },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });
  it.each(commands)(
    "preserves $name proof presence, type and nonempty gates without reads",
    async (command) => {
      const db = await openDomainDb(),
        tracked = recordSql(db);
      for (const stepUpProofId of [undefined, 42, ""]) {
        const requestInput =
          command.name === "diagnostic.generate" ? {} : { bundleId: randomUlid() };
        if (stepUpProofId !== undefined) Object.assign(requestInput, { stepUpProofId });
        expect(
          await new WorkspaceHub(tracked.db).execute(command as HubCommand<object, unknown>, {
            workspaceId: FIX.workspace,
            actorHumanId: FIX.owner,
            authorizationEpoch: 1,
            idempotencyKey: randomUlid(),
            input: requestInput,
          }),
        ).toEqual({
          ok: false,
          error: { code: "step_up_invalid", message: "step-up proof is required" },
        });
        expect(
          await new WorkspaceHub(tracked.db).execute(command as HubCommand<object, unknown>, {
            workspaceId: FIX.workspace,
            actorHumanId: FIX.member,
            authorizationEpoch: 1,
            idempotencyKey: randomUlid(),
            input: requestInput,
          }),
        ).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
      expect(
        tracked.statements.some((sql) =>
          /passkey_step_up_proofs|diagnostic_bundles|idempotency_records|workspace_cursors/.test(
            sql,
          ),
        ),
      ).toBe(false);
    },
  );
  it("denies production inventory before all source reads", async () => {
    const db = await openDomainDb(),
      tracked = recordSql(db);
    await expect(
      buildDiagnosticInventory(tracked.db, FIX.workspace, FIX.owner, NOW),
    ).rejects.toMatchObject(DENIAL);
    expect(tracked.statements).toEqual([]);
  });
  it("denies legacy and claimed-new-schema body rendering while preserving pure scanners", () => {
    for (const inventory of [INVENTORY, { ...INVENTORY, schema_version: 99 }])
      expect(() => renderDiagnosticInventory(inventory as DiagnosticInventory)).toThrowError(
        DENIAL.message,
      );
    expect(scanDiagnosticText(JSON.stringify(INVENTORY))).toEqual([]);
    expect(sanitizeDiagnosticValue({ task_count: 7, body: "Synthetic private prose" })).toEqual({
      task_count: 7,
    });
  });
  it("omits diagnostic audit before page/count and gives hidden and missing anchors the same denial", async () => {
    const db = await openDomainDb(),
      ids = await historicalCopies(db),
      before = await snapshot(db);
    const result = await readSecurityAudit(db, FIX.workspace, { access: ACCESS, limit: 1 });
    expect(result.entries).toEqual([]);
    expect(result.has_more).toBe(false);
    for (const anchor of [...ids, randomUlid()])
      await expect(
        readSecurityAudit(db, FIX.workspace, { access: ACCESS, after: anchor }),
      ).rejects.toMatchObject({ code: "invalid_argument", message: "unknown audit cursor" });
    expect(await snapshot(db)).toEqual(before);
  });
  it("keeps current audit scope denial ahead of a diagnostic anchor", async () => {
    const db = await openDomainDb(),
      ids = await historicalCopies(db);
    await expect(
      readSecurityAudit(db, FIX.workspace, {
        access: { ...ACCESS, authorizationEpoch: 2 },
        after: ids[0],
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "operations scope not found" });
  });
  it("holds semantic replay without rewriting diagnostic copies or source cursors", async () => {
    const db = await openDomainDb();
    await historicalCopies(db);
    const before = await snapshot(db),
      authorization = createAuthorizationContext({
        workspaceId: FIX.workspace,
        principalId: FIX.owner,
        authorizationEpoch: 1,
        jurisdiction: "eu",
      });
    await expect(
      listWorkspaceEvents(db, authorization, {
        afterCursor: 0,
        throughCursor: 4,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
    expect(await snapshot(db)).toEqual(before);
  });
  it("holds semantic replay before parsing malformed retained payloads", async () => {
    const db = await openDomainDb();
    await historicalCopies(db);
    const authorization = createAuthorizationContext({
      workspaceId: FIX.workspace,
      principalId: FIX.owner,
      authorizationEpoch: 1,
      jurisdiction: "eu",
    });
    await db
      .prepare(
        "UPDATE semantic_events SET payload_json='not JSON' WHERE workspace_id=? AND workspace_cursor=1",
      )
      .run(FIX.workspace);
    await expect(
      listWorkspaceEvents(db, authorization, { afterCursor: 0, throughCursor: 4, limit: 1 }),
    ).rejects.toMatchObject({ code: "request_rejected", message: "event feeds are unavailable" });
  });
});
