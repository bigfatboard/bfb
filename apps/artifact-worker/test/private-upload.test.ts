// ABOUTME: Proves private upload receipt effects require current contribution after byte awaits.
// ABOUTME: Mounted fake R2 and request-body interleavings never disclose rejected artifact metadata.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactHash,
  createArtifactCommand,
  FIX,
  mintUploadGrantSecret,
  randomUlid,
  WorkspaceHub,
} from "@bfb/domain";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { createArtifactFetchHandler } from "../src/index.js";

const NOW = "2026-10-06T12:00:00.000Z";
const ORIGIN = "https://artifacts.bfb.example.test";
const TEXT = "SYNTHETIC_PRIVATE_UPLOAD_BYTES";
const BYTES = new TextEncoder().encode(TEXT);
const DIGEST = artifactHash(BYTES);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const db = await openDomainDb(),
    taskId = randomUlid(),
    runId = randomUlid(),
    taskGrantId = randomUlid();
  await db
    .prepare(
      `INSERT INTO tasks
    (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,resource_version,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic private upload task','ready','P2','unassigned','Synthetic',1,?,?)`,
    )
    .run(FIX.workspace, taskId, FIX.projectA, FIX.member, NOW);
  await db
    .prepare(
      `INSERT INTO runs
    (workspace_id,id,project_id,task_id,requested_by_human_id,agent_profile_id,result_state,activity,resource_version,created_at)
    VALUES (?,?,?,?,?,?,'open','unknown',1,?)`,
    )
    .run(FIX.workspace, runId, FIX.projectA, taskId, FIX.member, FIX.profileCodex, NOW);
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, taskId, FIX.member, NOW);
  await db
    .prepare(
      `INSERT INTO task_human_grants
    (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'contribute',?)`,
    )
    .run(FIX.workspace, taskGrantId, taskId, FIX.owner, NOW);
  const minted = mintUploadGrantSecret(),
    outcome = await new WorkspaceHub(db).execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: {
        runId,
        format: "markdown",
        role: "review",
        declaredSize: BYTES.length,
        expectedDigest: DIGEST,
        grantSecretHash: minted.secretHash,
      },
    });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  const created = outcome.result,
    hooks: { put?: () => Promise<void>; body?: () => Promise<void> } = {};
  let puts = 0;
  const bucket = {
    async put() {
      puts++;
      await hooks.put?.();
      return { key: "synthetic" };
    },
  } as unknown as R2Bucket;
  const revoke = async () => {
    await db.prepare("UPDATE task_human_grants SET revoked_at=? WHERE id=?").run(NOW, taskGrantId);
  };
  const upload = async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await hooks.body?.();
          controller.enqueue(BYTES);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return createArtifactFetchHandler({ db, now: NOW })(
      new Request(`${ORIGIN}/upload/${created.upload_grant.grant_id}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${minted.secret}`,
          "cf-connecting-ip": "192.0.2.78",
        },
        body,
        duplex: "half",
      } as RequestInit),
      {
        ARTIFACTS: bucket,
        DB: {} as D1Database,
        ARTIFACT_ORIGIN: ORIGIN,
        APP_ORIGIN: "https://bfb.example.test",
        ENVIRONMENT: "local",
        ARTIFACT_VIEWER_ENABLED: "true",
        UPLOAD_ABUSE_SECRET: "synthetic-private-upload-abuse-secret-71aa90xx",
      },
    );
  };
  return { db, created, hooks, revoke, upload, puts: () => puts };
}

describe("private upload receipt delivery", () => {
  it("records verified bytes while contribution remains current", async () => {
    const f = await fixture(),
      response = await f.upload();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version_id: f.created.version_id,
      content_hash: DIGEST,
    });
    expect(
      await f.db.prepare("SELECT COUNT(*) AS total FROM artifact_upload_receipt_sources").get(),
    ).toEqual({ total: 1 });
    expect(
      await f.db
        .prepare("SELECT state FROM artifact_versions WHERE id=?")
        .get(f.created.version_id),
    ).toEqual({ state: "uploading" });
  });
  it.each(["before", "body", "put"] as const)(
    "denies contribution revoke at %s without receipt or metadata",
    async (timing) => {
      const f = await fixture();
      if (timing === "before") await f.revoke();
      else f.hooks[timing] = f.revoke;
      const response = await f.upload(),
        text = await response.text();
      expect(response.status).toBe(timing === "before" ? 403 : 409);
      expect(JSON.parse(text)).toEqual(
        timing === "before"
          ? { error: "request_rejected", message: "request rejected" }
          : { error: "upload_conflict" },
      );
      for (const privateValue of [
        TEXT,
        DIGEST,
        f.created.version_id,
        f.created.artifact_id,
        FIX.workspace,
      ])
        expect(text).not.toContain(privateValue);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("etag")).toBeNull();
      expect(f.puts()).toBe(timing === "before" ? 0 : 1);
      for (const table of [
        "artifact_objects",
        "artifact_upload_receipts",
        "artifact_upload_receipt_sources",
      ])
        expect(await f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT * FROM artifact_audit_outbox WHERE action='artifact.upload_verified'")
          .all(),
      ).toEqual([]);
      expect(
        await f.db
          .prepare("SELECT state FROM artifact_versions WHERE id=?")
          .get(f.created.version_id),
      ).toEqual({ state: "uploading" });
    },
  );
});
