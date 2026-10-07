// ABOUTME: Exercises delegated artifact commit fences through genuine authenticated MCP and the staged Hub.
// ABOUTME: Verified uploads, permission changes and natural expiry prove rollback without altering immutable sources.

import { setTimeout as delay } from "node:timers/promises";

import type { SqlDatabase } from "@bfb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ARTIFACT_GRANT_TTL_MS,
  artifactHash,
  artifactObjectKey,
  recordVerifiedUpload,
  redeemUploadGrant,
} from "../../../packages/domain/src/artifacts.js";
import { FIX } from "../../../packages/domain/src/fixtures.js";
import { WorkspaceHub } from "../../../packages/domain/src/hub.js";
import { randomUlid } from "../../../packages/domain/src/ids.js";
import type {
  CreateDelegatedArtifactResult,
  FinalizeDelegatedArtifactResult,
} from "../../../packages/domain/src/remote-parity.js";
import { createTaskCommand } from "../../../packages/domain/src/work-commands.js";
import { createRunCommand } from "../../../packages/domain/src/work-records.js";
import { issueSyntheticMcpAccess, openDomainDb } from "../../../packages/domain/test/helpers.js";
import { success } from "../../../packages/domain/test/launch-fixture.js";
import { resultStagedD1 } from "../../../packages/domain/test/result-fixture.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { handleMcpRequest } from "../src/mcp/handler.js";

const BYTES = Buffer.from("SYNTHETIC-MCP-DELEGATED-ARTIFACT-COMMIT");
const DIGEST = artifactHash(BYTES);
const SIZE = BYTES.byteLength;
const EFFECT_TABLES = [
  "artifacts",
  "artifact_versions",
  "artifact_upload_grants",
  "artifact_upload_receipts",
  "artifact_objects",
  "artifact_audit_outbox",
  "semantic_events",
  "audit_events",
  "outbox_records",
  "idempotency_records",
] as const;
type Operation = "new_create" | "existing_create" | "finalize";
type Published = Omit<CreateDelegatedArtifactResult, "upload_grant"> & {
  upload_grant: { grant_id: string; version_id: string; secret: string; expires_at: string };
};
type Outcome =
  | { ok: true; result: Published | FinalizeDelegatedArtifactResult; replayed: boolean }
  | { ok: false; error: { code: string; message: string } };

beforeEach(() => {
  vi.useRealTimers();
});

async function fixture(expiry = "+10 minutes") {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    owner = { workspaceId: FIX.workspace, actorHumanId: FIX.owner, authorizationEpoch: 1 };
  const task = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic MCP artifact commit task",
        priority: "P2",
      },
    }),
  );
  const otherTask = success(
    await hub.execute(createTaskCommand, {
      ...owner,
      idempotencyKey: randomUlid(),
      input: {
        projectId: FIX.projectA,
        title: "Synthetic unrelated MCP artifact task",
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
  const clock = (await db
    .prepare(
      "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS observed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS expires_at",
    )
    .get(expiry)) as { observed_at: string; expires_at: string };
  const auth = await issueSyntheticMcpAccess(db, {
    humanId: FIX.member,
    projectId: FIX.projectA,
    taskId: task.id,
    scopes: ["bfb:read", "bfb:task:write", "offline_access"],
    now: clock.observed_at,
    expiresAt: clock.expires_at,
  });
  return { db, taskId: task.id, otherTaskId: otherTask.id, runId: run.run.id, ...clock, ...auth };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function call(
  f: Fixture,
  committingDb: SqlDatabase,
  operation: Operation,
  key: string,
  created?: Published,
) {
  const tool = operation === "finalize" ? "bfb_finalize_artifact" : "bfb_publish_artifact";
  if (operation !== "new_create" && !created) throw new Error("Existing artifact source required");
  const args =
    operation === "finalize"
      ? { version_id: created!.version_id, content_hash: DIGEST, size: SIZE, request_id: key }
      : {
          ...(operation === "existing_create" ? { artifact_id: created!.artifact_id } : {}),
          run_id: f.runId,
          format: "markdown",
          role: "review",
          declared_size: SIZE,
          expected_digest: DIGEST,
          request_id: key,
        };
  const response = await handleMcpRequest(
    new Request("https://bfb.example.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
        Host: "bfb.example.test",
        authorization: `Bearer ${f.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": {
              name: "bfb-synthetic-artifact-commit",
              version: "1.0.0",
            },
          },
        },
      }),
    }),
    {
      // Original OAuth-query database; only the real committing WorkspaceHub is staged.
      db: f.db,
      workspaceHubNs: createTestWorkspaceHubNamespace(committingDb),
      allowedHostnames: ["bfb.example.test"],
      appOrigin: "https://bfb.example.test",
      abuseSecret: "c11-synthetic-artifact-commit-abuse-secret-8b635c",
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
  const text = reply.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return { outcome: JSON.parse(text!) as Outcome, isError: reply.result?.isError };
}

async function upload(f: Fixture) {
  const { outcome } = await call(f, f.db, "new_create", randomUlid());
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(outcome.error.code);
  const created = outcome.result as Published;
  expect(created.state).toBe("uploading");
  expect(typeof created.upload_grant.secret).toBe("string");
  const consumed = await redeemUploadGrant(f.db, {
    grantId: created.upload_grant.grant_id,
    secret: created.upload_grant.secret,
    now: new Date().toISOString(),
  });
  await f.db.withTransaction((tx) =>
    recordVerifiedUpload(tx, {
      grantId: consumed.grantId,
      consumeAttemptId: consumed.consumeAttemptId,
      contentHash: DIGEST,
      size: SIZE,
      now: new Date().toISOString(),
    }),
  );
  return created;
}

async function effects(f: Fixture) {
  const rows: Record<string, unknown[]> = {};
  for (const table of EFFECT_TABLES)
    rows[table] = await f.db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY rowid`)
      .all(FIX.workspace);
  return {
    rows,
    cursor: (await f.db
      .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
      .get(FIX.workspace)) as { cursor: number },
    guards: await f.db.prepare("SELECT * FROM artifact_mutation_guards ORDER BY id").all(),
    task: await f.db
      .prepare("SELECT * FROM tasks WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.taskId),
    run: await f.db
      .prepare("SELECT * FROM runs WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, f.runId),
  };
}

async function verifiedSource(f: Fixture, created: Published) {
  const key = artifactObjectKey({
    workspaceId: FIX.workspace,
    role: "review",
    runId: f.runId,
    versionId: created.version_id,
    contentHash: DIGEST,
  });
  expect(
    await f.db
      .prepare(
        `SELECT version.id AS version_id,version.artifact_id,version.state,version.format AS version_format,
        version.declared_size,version.expected_digest,artifact.run_id,artifact.format AS artifact_format,
        artifact.role,run.task_id,run.purpose,task.project_id
       FROM artifact_versions AS version
       JOIN artifacts AS artifact ON artifact.workspace_id=version.workspace_id AND artifact.id=version.artifact_id
       JOIN runs AS run ON run.workspace_id=artifact.workspace_id AND run.id=artifact.run_id
       JOIN tasks AS task ON task.workspace_id=run.workspace_id AND task.id=run.task_id
       WHERE version.workspace_id=? AND version.id=?`,
      )
      .get(FIX.workspace, created.version_id),
  ).toEqual({
    version_id: created.version_id,
    artifact_id: created.artifact_id,
    state: "uploading",
    version_format: "markdown",
    declared_size: SIZE,
    expected_digest: DIGEST,
    run_id: f.runId,
    artifact_format: "markdown",
    role: "review",
    task_id: f.taskId,
    purpose: "work",
    project_id: FIX.projectA,
  });
  expect(
    await f.db
      .prepare("SELECT * FROM artifact_upload_receipts WHERE workspace_id=? AND version_id=?")
      .get(FIX.workspace, created.version_id),
  ).toMatchObject({ content_hash: DIGEST, size: SIZE });
  expect(
    await f.db
      .prepare("SELECT * FROM artifact_objects WHERE workspace_id=? AND r2_key=?")
      .get(FIX.workspace, key),
  ).toMatchObject({ content_hash: DIGEST, size: SIZE, r2_key: key });
  expect(
    await f.db
      .prepare("SELECT consumed_at FROM artifact_upload_grants WHERE workspace_id=? AND id=?")
      .get(FIX.workspace, created.upload_grant.grant_id),
  ).toMatchObject({ consumed_at: expect.any(String) });
}

function observePreparation(db: SqlDatabase, observe: (at: string) => void): SqlDatabase {
  return {
    ...db,
    withTransaction(work) {
      return db.withTransaction((tx) =>
        work({
          ...tx,
          prepare(sql) {
            const statement = tx.prepare(sql);
            return {
              ...statement,
              run(...parameters) {
                const at = sql.includes("INSERT INTO artifact_versions")
                  ? parameters.at(-1)
                  : /UPDATE artifact_versions\s+SET state = 'available'/.test(sql)
                    ? parameters[2]
                    : undefined;
                if (at !== undefined) {
                  expect(typeof at).toBe("string");
                  observe(at as string);
                }
                return statement.run(...parameters);
              },
            };
          },
        }),
      );
    },
  };
}

async function clockWitness(f: Fixture) {
  return (await f.db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS database_now,
      julianday(expires_at)>julianday('now') AS live
     FROM oauth_delegations WHERE workspace_id=? AND id=?`,
    )
    .get(FIX.workspace, f.delegationId)) as { database_now: string; live: number };
}

describe("mounted delegated artifact commit authority", () => {
  it.each<Operation>(["new_create", "existing_create", "finalize"])(
    "%s commits through authenticated MCP after a healthy delay with unchanged observation timestamps",
    async (operation) => {
      const f = await fixture(),
        created = operation === "new_create" ? undefined : await upload(f),
        before = await effects(f),
        key = randomUlid();
      let reached = false,
        observedAt = "",
        flushAt = "";
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        expect(observedAt).not.toBe("");
        if (operation === "finalize") await verifiedSource(f, created!);
        await delay(250);
        const flush = await clockWitness(f);
        expect(flush.live).toBe(1);
        flushAt = flush.database_now;
      });
      const started = Date.now();
      const { outcome, isError } = await call(
        f,
        observePreparation(staged.db, (at) => (observedAt = at)),
        operation,
        key,
        created,
      );
      expect(reached).toBe(true);
      expect(isError).not.toBe(true);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.error.code);
      expect(Object.keys(outcome).sort()).toEqual(["ok", "replayed", "result"]);
      expect(outcome.replayed).toBe(false);
      expect(Date.parse(observedAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(flushAt) - Date.parse(observedAt)).toBeGreaterThanOrEqual(200);
      const after = await effects(f);
      for (const table of EFFECT_TABLES) {
        const delta =
          [
            "semantic_events",
            "audit_events",
            "outbox_records",
            "idempotency_records",
            "artifact_audit_outbox",
          ].includes(table) ||
          (operation !== "finalize" &&
            ["artifact_versions", "artifact_upload_grants"].includes(table)) ||
          (operation === "new_create" && table === "artifacts")
            ? 1
            : 0;
        expect(after.rows[table]!.length).toBe(before.rows[table]!.length + delta);
      }
      expect(after.cursor.cursor).toBe(before.cursor.cursor + 1);
      expect(after.guards).toEqual([]);
      expect(after.run).toEqual(before.run);
      expect(after.task).toEqual(before.task);
      expect(
        await f.db
          .prepare(
            `SELECT ${operation === "finalize" ? "available_at" : "created_at"} AS at FROM artifact_versions WHERE workspace_id=? AND id=?`,
          )
          .get(FIX.workspace, outcome.result.version_id),
      ).toEqual({ at: observedAt });
      for (const table of [
        "semantic_events",
        "audit_events",
        "outbox_records",
        "idempotency_records",
      ])
        expect((after.rows[table]!.at(-1) as { created_at: string }).created_at).toBe(observedAt);
      if (operation !== "finalize") {
        const published = outcome.result as Published;
        expect(Date.parse(published.upload_grant.expires_at) - Date.parse(observedAt)).toBe(
          ARTIFACT_GRANT_TTL_MS,
        );
        expect(JSON.stringify(after.rows)).not.toContain(published.upload_grant.secret);
      }
      if (created) expect(JSON.stringify(after.rows)).not.toContain(created.upload_grant.secret);
    },
  );

  it.each([
    ["new_create", "revoked"],
    ["existing_create", "write_scope"],
    ["existing_create", "boundary"],
    ["finalize", "private_grant"],
  ] as const)(
    "%s rejects independent %s loss after genuine admission and rolls back the entire batch",
    async (operation, loss) => {
      const f = await fixture(),
        created = operation === "new_create" ? undefined : await upload(f);
      let grantId = "";
      if (loss === "private_grant") {
        await f.db
          .prepare(
            "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
          )
          .run(FIX.workspace, f.taskId, FIX.owner, f.observed_at);
        grantId = randomUlid();
        await f.db
          .prepare(
            `INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at)
           VALUES (?,?,?,?,1,'contribute',?)`,
          )
          .run(FIX.workspace, grantId, f.taskId, FIX.member, f.observed_at);
      }
      const before = await effects(f);
      let reached = false;
      let lossApplied = false;
      const staged = resultStagedD1(f.db, async () => {
        reached = true;
        if (operation === "finalize") await verifiedSource(f, created!);
        if (loss === "revoked")
          await f.db
            .prepare("UPDATE oauth_delegations SET revoked_at=? WHERE workspace_id=? AND id=?")
            .run(new Date().toISOString(), FIX.workspace, f.delegationId);
        else if (loss === "write_scope")
          await f.db
            .prepare("UPDATE oauth_delegations SET scopes_json=? WHERE workspace_id=? AND id=?")
            .run(JSON.stringify(["bfb:read"]), FIX.workspace, f.delegationId);
        else if (loss === "boundary")
          await f.db
            .prepare("UPDATE oauth_delegations SET task_id=? WHERE workspace_id=? AND id=?")
            .run(f.otherTaskId, FIX.workspace, f.delegationId);
        else
          await f.db
            .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
            .run(new Date().toISOString(), FIX.workspace, grantId);
        lossApplied = true;
      });
      const { outcome, isError } = await call(f, staged.db, operation, randomUlid(), created);
      expect(reached).toBe(true);
      expect(lossApplied).toBe(true);
      expect(isError).toBe(true);
      expect(outcome).toEqual({
        ok: false,
        error: { code: "command_failed", message: "command failed" },
      });
      expect(await effects(f)).toEqual(before);
      if (created) expect(JSON.stringify(outcome)).not.toContain(created.upload_grant.secret);
    },
  );

  it("retains one legitimate competing finalization but rolls back the prepared second finalization", async () => {
    const f = await fixture(),
      created = await upload(f);
    let reached = false,
      competitorEffects: Awaited<ReturnType<typeof effects>> | undefined;
    const staged = resultStagedD1(f.db, async () => {
      reached = true;
      await verifiedSource(f, created);
      const competing = await call(f, f.db, "finalize", randomUlid(), created);
      expect(competing.outcome.ok).toBe(true);
      competitorEffects = await effects(f);
    });
    const { outcome, isError } = await call(f, staged.db, "finalize", randomUlid(), created);
    expect(reached).toBe(true);
    expect(isError).toBe(true);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(await effects(f)).toEqual(competitorEffects);
    expect(
      await f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM artifact_audit_outbox WHERE workspace_id=? AND version_id=? AND action='artifact.finalized'",
        )
        .get(FIX.workspace, created.version_id),
    ).toEqual({ n: 1 });
  });

  it("rolls back verified finalization when its unchanged credential naturally expires after admission", async () => {
    const f = await fixture("+3 seconds"),
      created = await upload(f),
      before = await effects(f),
      original = await f.db
        .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.delegationId);
    let reachedWhileLive = false,
      expired = false,
      observedAt = "";
    const staged = resultStagedD1(f.db, async () => {
      reachedWhileLive = (await clockWitness(f)).live === 1;
      expect(reachedWhileLive).toBe(true);
      expect(Date.parse(observedAt)).toBeLessThan(Date.parse(f.expires_at));
      await verifiedSource(f, created);
      const deadline = performance.now() + 10_000;
      while ((await clockWitness(f)).live === 1) {
        if (performance.now() >= deadline)
          throw new Error("Synthetic MCP delegation did not naturally expire");
        await delay(50);
      }
      expired = (await clockWitness(f)).live === 0;
      expect(expired).toBe(true);
      expect(
        await f.db
          .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
          .get(FIX.workspace, f.delegationId),
      ).toEqual(original);
    });
    const { outcome, isError } = await call(
      f,
      observePreparation(staged.db, (at) => (observedAt = at)),
      "finalize",
      randomUlid(),
      created,
    );
    expect(reachedWhileLive).toBe(true);
    expect(expired).toBe(true);
    expect(isError).toBe(true);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "command_failed", message: "command failed" },
    });
    expect(await effects(f)).toEqual(before);
    expect(
      await f.db
        .prepare("SELECT * FROM oauth_delegations WHERE workspace_id=? AND id=?")
        .get(FIX.workspace, f.delegationId),
    ).toEqual(original);
  });
});
