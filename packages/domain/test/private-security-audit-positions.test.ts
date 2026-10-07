// ABOUTME: Proves public security-audit pagination uses opaque principal-bound positions instead of audit identities.
// ABOUTME: Canonical run-free finalized receipts provide genuine positive controls for the position transition.

import { adaptD1, type D1Like, type D1StatementLike, type SqlDatabase } from "@bfb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_RECOVERY_SYSTEM_ID } from "../src/artifacts.js";
import { FIX } from "../src/fixtures.js";
import { randomUlid } from "../src/ids.js";
import { WorkspaceHub } from "../src/hub.js";
import { issueSecurityAuditPositionCommand, readSecurityAudit } from "../src/operations.js";
import {
  createSecurityAuditPosition,
  hashSecurityAuditPosition,
  isSecurityAuditPosition,
} from "../src/security-audit-positions.js";
import { createTaskCommand } from "../src/work-commands.js";
import { createRunCommand } from "../src/work-records.js";
import { openDomainDb } from "./helpers.js";
import { success } from "./launch-fixture.js";
import { auditPositionIssuer } from "./security-audit-helpers.js";

const access = { workspaceId: FIX.workspace, humanId: FIX.owner, authorizationEpoch: 1 };

afterEach(() => vi.useRealTimers());

async function fixture(boundIndices: number[] = []) {
  const db = await openDomainDb();
  const hub = new WorkspaceHub(db);
  const task = success(
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic audit position parent", priority: "P2" },
    }),
  );
  const run = success(
    await hub.execute(createRunCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
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
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const artifactId = randomUlid(),
      versionId = randomUlid(),
      outboxId = randomUlid();
    const createdAt = `2026-10-06T12:00:0${index}.000Z`;
    await db
      .prepare(
        `INSERT INTO artifacts
      (workspace_id,id,run_id,format,role,created_by_human_id,created_at)
      VALUES (?,?,?,'markdown','review',?,?)`,
      )
      .run(
        FIX.workspace,
        artifactId,
        boundIndices.includes(index) ? run.run.id : null,
        FIX.member,
        createdAt,
      );
    // Synthetic recorded publication metadata; no artifact bytes or capabilities are created.
    await db
      .prepare(
        `INSERT INTO artifact_versions
      (workspace_id,id,artifact_id,state,format,declared_size,expected_digest,content_hash,r2_key,created_at,available_at)
      VALUES (?,?,?,'available','markdown',64,?,?,?,?,?)`,
      )
      .run(
        FIX.workspace,
        versionId,
        artifactId,
        "a".repeat(64),
        "b".repeat(64),
        `workspaces/${FIX.workspace}/artifacts/sha256/${"b".repeat(64)}`,
        createdAt,
        createdAt,
      );
    await db
      .prepare(
        `INSERT INTO artifact_audit_outbox
      (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
      VALUES (?,?,?,NULL,'artifact.finalized','{}',?,?)`,
      )
      .run(FIX.workspace, outboxId, versionId, createdAt, createdAt);
    await db
      .prepare(
        `INSERT INTO audit_events
      (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
      VALUES (?,?,?,'artifact.finalized','{}',?)`,
      )
      .run(FIX.workspace, outboxId, ARTIFACT_RECOVERY_SYSTEM_ID, createdAt);
    ids.push(outboxId);
  }
  return { db, ids, taskId: task.id, issue: auditPositionIssuer(db, access) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cursorError = { code: "invalid_argument", message: "unknown audit cursor" };
async function privatize(f: Fixture) {
  await f.db
    .prepare(
      `INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at)
    VALUES (?,?,?,?)`,
    )
    .run(FIX.workspace, f.taskId, FIX.member, new Date().toISOString());
}
async function ledger(f: Fixture, handle: string) {
  return (await f.db
    .prepare(`SELECT * FROM security_audit_positions WHERE position_hash=?`)
    .get(hashSecurityAuditPosition(handle))) as {
    position_hash: string;
    capture_ceiling: number;
    expires_at: string;
    audience_json: string;
    anchor_audit_id: string;
    anchor_sort_key: string;
    anchor_rowid: number;
    after_hash: string | null;
  };
}
function stagedDatabase(db: SqlDatabase, beforeBatch: () => Promise<void>): SqlDatabase {
  const binding: D1Like = {
    prepare(sql) {
      let params: unknown[] = [];
      const statement: D1StatementLike = {
        bind(...values) {
          expect(values.length).toBeLessThanOrEqual(100);
          params = values;
          return statement;
        },
        async first() {
          return (await db.prepare(sql).get(...params)) ?? null;
        },
        async all() {
          return { results: await db.prepare(sql).all(...params) };
        },
        async run() {
          const result = await db.prepare(sql).run(...params);
          return { meta: { changes: result.changes ?? 0 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      await beforeBatch();
      return db.withTransaction(async () => {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      });
    },
  };
  return adaptD1(binding);
}

describe("security-audit positions", () => {
  it("rejects a genuine visible audit identity as a public after position", async () => {
    const f = await fixture();
    const control = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 100 });
    expect(control.entries.map((row) => row.audit_id)).toEqual(f.ids);
    await expect(
      readSecurityAudit(f.db, FIX.workspace, { access, limit: 1, after: f.ids[0]! }),
    ).rejects.toMatchObject({ code: "invalid_argument", message: "unknown audit cursor" });
  });

  it("provides an opaque continuation rather than requiring the last visible audit identity", async () => {
    const f = await fixture();
    const page = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue);
    expect(page.entries.map((row) => row.audit_id)).toEqual([f.ids[0]]);
    expect(page.has_more).toBe(true);
    expect((page as { next_cursor?: string }).next_cursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("fails unavailable without an issuer only when continuation is necessary", async () => {
    const f = await fixture();
    await expect(
      readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }),
    ).rejects.toMatchObject({
      code: "request_rejected",
      message: "audit positions are unavailable",
    });
    const terminal = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 100 });
    expect(terminal.has_more).toBe(false);
    expect(terminal.next_cursor).toBeNull();
    expect(await f.db.prepare("SELECT * FROM security_audit_positions").all()).toEqual([]);
  });

  it("uses canonical random handles and rejects noncanonical final bits, newlines and raw ids", () => {
    const handle = createSecurityAuditPosition();
    expect(isSecurityAuditPosition(handle)).toBe(true);
    expect(hashSecurityAuditPosition(handle)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecurityAuditPosition(handle)).not.toBe(handle);
    const zero = Buffer.alloc(32).toString("base64url");
    for (const invalid of [
      zero.slice(0, -1) + "B",
      zero + "\n",
      zero + "\u0000",
      randomUlid(),
      "!",
    ])
      expect(isSecurityAuditPosition(invalid)).toBe(false);
  });

  it("traverses reusable positions while descendants inherit ceiling and fixed expiry", async () => {
    const f = await fixture();
    const first = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue);
    const root = await ledger(f, first.next_cursor!);
    expect(root.anchor_audit_id).toBe(f.ids[0]);
    const second = await readSecurityAudit(
      f.db,
      FIX.workspace,
      { access, limit: 1, after: first.next_cursor! },
      f.issue,
    );
    const child = await ledger(f, second.next_cursor!);
    expect(child.capture_ceiling).toBe(root.capture_ceiling);
    expect(child.expires_at).toBe(root.expires_at);
    expect(child.after_hash).toBe(root.position_hash);
    const repeated = await readSecurityAudit(
      f.db,
      FIX.workspace,
      { access, limit: 1, after: first.next_cursor! },
      f.issue,
    );
    expect(repeated.entries).toEqual(second.entries);
    expect(repeated.next_cursor).not.toBe(second.next_cursor);
    const third = await readSecurityAudit(
      f.db,
      FIX.workspace,
      { access, limit: 1, after: second.next_cursor! },
      f.issue,
    );
    expect(third.entries.map((row) => row.audit_id)).toEqual([f.ids[2]]);
    expect(third).toMatchObject({ has_more: false, next_cursor: null });
    const persisted = JSON.stringify(
      await f.db.prepare("SELECT * FROM security_audit_positions").all(),
    );
    expect(persisted).not.toContain(first.next_cursor!);
    for (const table of [
      "idempotency_records",
      "audit_events",
      "semantic_events",
      "outbox_records",
    ])
      expect(JSON.stringify(await f.db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(
        first.next_cursor!,
      );
  });

  it("excludes newer backdated insertions while a position is live", async () => {
    const f = await fixture();
    const first = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue);
    const old = (await f.db
      .prepare("SELECT * FROM artifact_audit_outbox WHERE id=?")
      .get(f.ids[0])) as { version_id: string };
    const newer = randomUlid(),
      at = "2026-10-06T12:00:00.500Z";
    await f.db
      .prepare(
        `INSERT INTO artifact_audit_outbox
      (workspace_id,id,version_id,grant_id,action,payload_json,created_at,dispatched_at)
      VALUES (?,?,?,NULL,'artifact.finalized','{}',?,?)`,
      )
      .run(FIX.workspace, newer, old.version_id, at, at);
    await f.db
      .prepare(
        `INSERT INTO audit_events
      (workspace_id,audit_id,actor_principal_id,action,payload_json,created_at)
      VALUES (?,?,?,'artifact.finalized','{}',?)`,
      )
      .run(FIX.workspace, newer, ARTIFACT_RECOVERY_SYSTEM_ID, at);
    const second = await readSecurityAudit(
      f.db,
      FIX.workspace,
      { access, limit: 1, after: first.next_cursor! },
      f.issue,
    );
    expect(second.entries.map((row) => row.audit_id)).toEqual([f.ids[1]]);
    expect(
      (await readSecurityAudit(f.db, FIX.workspace, { access, limit: 100 })).entries.map(
        (row) => row.audit_id,
      ),
    ).toEqual([f.ids[0], newer, f.ids[1], f.ids[2]]);
  });

  it("binds the human and effective limit while preserving current Owner precedence", async () => {
    const f = await fixture();
    const page = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue);
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
      .run(FIX.member);
    for (const options of [
      { access, limit: 2 },
      { access: { ...access, humanId: FIX.member }, limit: 1 },
    ])
      await expect(
        readSecurityAudit(f.db, FIX.workspace, { ...options, after: page.next_cursor! }, f.issue),
      ).rejects.toMatchObject(cursorError);
    const foreignWorkspace = randomUlid(),
      at = new Date().toISOString();
    await f.db
      .prepare(
        "INSERT INTO workspaces(id,slug,jurisdiction,created_at) VALUES (?,'position-foreign','eu',?)",
      )
      .run(foreignWorkspace, at);
    await f.db
      .prepare(
        "INSERT INTO workspace_members(workspace_id,human_id,role,authorization_epoch,created_at) VALUES (?,?,'owner',1,?)",
      )
      .run(foreignWorkspace, FIX.owner, at);
    await f.db
      .prepare(
        "INSERT INTO workspace_authorization_epochs(workspace_id,human_id,authorization_epoch,revoked_at,updated_at) VALUES (?,?,1,NULL,?)",
      )
      .run(foreignWorkspace, FIX.owner, at);
    await expect(
      readSecurityAudit(f.db, foreignWorkspace, {
        access: { ...access, workspaceId: foreignWorkspace },
        limit: 1,
        after: page.next_cursor!,
      }),
    ).rejects.toMatchObject(cursorError);
    await f.db
      .prepare("UPDATE workspace_members SET role='member' WHERE human_id=? AND workspace_id=?")
      .run(FIX.owner, FIX.workspace);
    await expect(
      readSecurityAudit(f.db, FIX.workspace, { access, after: "malformed" }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "operations scope not found",
    });
  });

  it("fails unavailable rather than truncating an oversized current audience", async () => {
    const f = await fixture();
    const ids = Array.from({ length: 1130 }, () => randomUlid());
    await f.db
      .prepare(
        `INSERT INTO projects(workspace_id,id,name,slug,tint,resource_version,created_at,access_mode)
      SELECT ?,value,'Synthetic bounded audience',lower(value),'#3B82F6',1,?,'workspace' FROM json_each(?)`,
      )
      .run(FIX.workspace, new Date().toISOString(), JSON.stringify(ids));
    await expect(
      readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue),
    ).rejects.toMatchObject({
      code: "request_rejected",
      message: "audit positions are unavailable",
    });
    expect(await f.db.prepare("SELECT * FROM security_audit_positions").all()).toEqual([]);
  });

  it.each(["expand", "contract"] as const)("invalidates same-epoch audience %s", async (change) => {
    const f = await fixture();
    await f.db.prepare("UPDATE projects SET access_mode='restricted' WHERE id=?").run(FIX.projectB);
    if (change === "expand")
      await f.db
        .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
        .run(FIX.projectB, FIX.owner);
    const page = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue);
    if (change === "expand")
      await f.db
        .prepare("INSERT INTO project_access(workspace_id,project_id,human_id) VALUES (?,?,?)")
        .run(FIX.workspace, FIX.projectB, FIX.owner);
    else
      await f.db
        .prepare("DELETE FROM project_access WHERE project_id=? AND human_id=?")
        .run(FIX.projectB, FIX.owner);
    await expect(
      readSecurityAudit(
        f.db,
        FIX.workspace,
        { access, limit: 1, after: page.next_cursor! },
        f.issue,
      ),
    ).rejects.toMatchObject(cursorError);
  });

  it.each(["privacy", "source", "tuple"] as const)(
    "rejects a previously valid anchor after %s loss",
    async (loss) => {
      const f = await fixture([0]);
      const page = await readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, f.issue);
      if (loss === "privacy") await privatize(f);
      else if (loss === "source") {
        // Synthetic historical corruption: production outbox rows are append-only.
        await f.db.prepare("DROP TRIGGER artifact_audit_outbox_immutable_delete").run();
        await f.db.prepare("DELETE FROM artifact_audit_outbox WHERE id=?").run(f.ids[0]);
      } else {
        // Synthetic historical tuple rebuilding invalidates live positions rather than reinterpreting them.
        await f.db.prepare("DROP TRIGGER artifact_audit_outbox_dispatch_once").run();
        const at = "2026-10-06T12:00:00.250Z";
        await f.db
          .prepare("UPDATE artifact_audit_outbox SET dispatched_at=? WHERE id=?")
          .run(at, f.ids[0]);
        await f.db
          .prepare("UPDATE audit_events SET created_at=? WHERE audit_id=?")
          .run(at, f.ids[0]);
      }
      await expect(
        readSecurityAudit(
          f.db,
          FIX.workspace,
          { access, limit: 1, after: page.next_cursor! },
          f.issue,
        ),
      ).rejects.toMatchObject(cursorError);
    },
  );

  it("checks fresh expiry after the final awaited selector", async () => {
    const f = await fixture();
    let deadline = "";
    const wrapped: SqlDatabase = {
      ...f.db,
      prepare(sql) {
        const statement = f.db.prepare(sql);
        return {
          ...statement,
          async get(...params) {
            const result = await statement.get(...params);
            if (sql.includes("issued_position AS MATERIALIZED") && deadline)
              vi.setSystemTime(new Date(Date.parse(deadline) + 1));
            return result;
          },
        };
      },
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    await expect(
      readSecurityAudit(wrapped, FIX.workspace, { access, limit: 1 }, async (input) => {
        await f.issue(input);
        deadline = (
          (await f.db
            .prepare("SELECT expires_at FROM security_audit_positions WHERE position_hash=?")
            .get(input.positionHash)) as { expires_at: string }
        ).expires_at;
      }),
    ).rejects.toMatchObject(cursorError);
  });

  it("rejects a changed last-delivered cut after successful issuance", async () => {
    const f = await fixture([0]);
    await expect(
      readSecurityAudit(f.db, FIX.workspace, { access, limit: 1 }, async (input) => {
        await f.issue(input);
        await privatize(f);
      }),
    ).rejects.toMatchObject(cursorError);
  });

  it.each(["delivered", "lookahead"] as const)(
    "rolls back the whole Hub batch after non-anchor %s loss",
    async (which) => {
      const f = await fixture(which === "delivered" ? [0] : [2]);
      const before = await f.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all();
      let changed = false;
      const staged = stagedDatabase(f.db, async () => {
        if (!changed) {
          changed = true;
          await privatize(f);
        }
      });
      const outcome = await new WorkspaceHub(staged).execute(issueSecurityAuditPositionCommand, {
        workspaceId: FIX.workspace,
        actorHumanId: FIX.owner,
        authorizationEpoch: 1,
        idempotencyKey: randomUlid(),
        input: {
          positionHash: hashSecurityAuditPosition(createSecurityAuditPosition()),
          afterHash: null,
          limit: 2,
        },
      });
      expect(changed).toBe(true);
      expect(outcome).toMatchObject({ ok: false, error: { code: "command_failed" } });
      expect(await f.db.prepare("SELECT * FROM security_audit_positions").all()).toEqual([]);
      expect(await f.db.prepare("SELECT * FROM security_audit_position_guards").all()).toEqual([]);
      expect(await f.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all()).toEqual(before);
    },
  );

  it("uses safe registered receipts, rejects cached issuance and rechecks current authority first", async () => {
    const f = await fixture();
    const request = {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: {
        positionHash: hashSecurityAuditPosition(createSecurityAuditPosition()),
        afterHash: null,
        limit: 1,
      },
    };
    const hub = new WorkspaceHub(f.db);
    expect(await hub.execute(issueSecurityAuditPositionCommand, request)).toMatchObject({
      ok: true,
      result: { issued: true },
    });
    expect(await hub.execute(issueSecurityAuditPositionCommand, request)).toMatchObject({
      ok: false,
      error: { code: "request_rejected" },
    });
    const receipt = (await f.db
      .prepare("SELECT payload_json FROM audit_events WHERE action='ops.audit_position.issue'")
      .get()) as { payload_json: string };
    expect(JSON.parse(receipt.payload_json)).toEqual({
      actor: { humanId: FIX.owner, authorizationEpoch: 1 },
      input: {},
      result: { issued: true },
    });
    await f.db
      .prepare("UPDATE workspace_members SET role='owner' WHERE human_id=?")
      .run(FIX.member);
    await f.db
      .prepare("UPDATE workspace_members SET role='member' WHERE human_id=?")
      .run(FIX.owner);
    expect(await hub.execute(issueSecurityAuditPositionCommand, request)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
