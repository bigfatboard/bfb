// ABOUTME: Proves private artifact bytes remain gated after asynchronous object reads.
// ABOUTME: Synthetic task grants and fake R2 interleavings exercise the mounted byte consumer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactHash,
  createArtifactCommand,
  createViewGrantCommand,
  finalizeArtifactCommand,
  FIX,
  mintUploadGrantSecret,
  mintViewGrantSecret,
  mintViewNonce,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  WorkspaceHub,
  type HubCommand,
} from "@bfb/domain";
import { openDomainDb } from "../../../packages/domain/test/helpers.js";
import { createArtifactFetchHandler } from "../src/index.js";

const NOW = "2026-10-06T12:00:00.000Z";
const ORIGIN = "https://artifacts.bfb.example.test";
const PRIVATE_TEXT = "SYNTHETIC_PRIVATE_VIEW_BYTES";
const BYTES = new TextEncoder().encode(PRIVATE_TEXT);
const DIGEST = artifactHash(BYTES);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const db = await openDomainDb(),
    hub = new WorkspaceHub(db),
    taskId = randomUlid(),
    runId = randomUlid(),
    taskGrantId = randomUlid();
  await db
    .prepare(
      `INSERT INTO tasks
    (workspace_id,id,project_id,title,state,priority,next_owner_type,punchline,resource_version,created_by_human_id,created_at)
    VALUES (?,?,?,'Synthetic private view task','ready','P2','unassigned','Synthetic',1,?,?)`,
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
    (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)`,
    )
    .run(FIX.workspace, taskGrantId, taskId, FIX.owner, NOW);
  const command = <I, R>(definition: HubCommand<I, R>, input: I, humanId: string) =>
    hub.execute(definition, {
      workspaceId: FIX.workspace,
      actorHumanId: humanId,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input,
    });
  const upload = mintUploadGrantSecret();
  const created = await command(
    createArtifactCommand,
    {
      runId,
      format: "markdown",
      role: "review",
      declaredSize: BYTES.length,
      expectedDigest: DIGEST,
      grantSecretHash: upload.secretHash,
    },
    FIX.member,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  const publication = created.result;
  const consumed = await db.withTransaction((tx) =>
    redeemUploadGrant(tx, {
      grantId: publication.upload_grant.grant_id,
      secret: upload.secret,
      now: NOW,
    }),
  );
  await db.withTransaction((tx) =>
    recordVerifiedUpload(tx, {
      grantId: consumed.grantId,
      consumeAttemptId: consumed.consumeAttemptId,
      contentHash: DIGEST,
      size: BYTES.length,
      now: NOW,
    }),
  );
  const final = await command(
    finalizeArtifactCommand,
    {
      versionId: publication.version_id,
      contentHash: DIGEST,
      size: BYTES.length,
    },
    FIX.member,
  );
  if (!final.ok) throw new Error(JSON.stringify(final));
  const secret = mintViewGrantSecret(),
    nonce = mintViewNonce();
  const issued = await command(
    createViewGrantCommand,
    {
      versionId: publication.version_id,
      grantSecretHash: secret.secretHash,
      viewNonce: nonce,
      sessionHash: artifactHash("synthetic session"),
    },
    FIX.owner,
  );
  if (!issued.ok) throw new Error(JSON.stringify(issued));
  const viewId = issued.result.view_id;
  const hooks: { get?: () => Promise<void>; bytes?: () => Promise<void>; content?: Uint8Array } =
    {};
  let gets = 0;
  const bucket = {
    async get() {
      gets++;
      await hooks.get?.();
      return {
        async arrayBuffer() {
          await hooks.bytes?.();
          return (hooks.content ?? BYTES).slice().buffer as ArrayBuffer;
        },
      };
    },
  } as unknown as R2Bucket;
  const revoke = async () => {
    await db.prepare("UPDATE task_human_grants SET revoked_at=? WHERE id=?").run(NOW, taskGrantId);
  };
  const env = {
    ARTIFACTS: bucket,
    DB: {} as D1Database,
    ARTIFACT_ORIGIN: ORIGIN,
    APP_ORIGIN: "https://bfb.example.test",
    ENVIRONMENT: "local",
    ARTIFACT_VIEWER_ENABLED: "true",
    UPLOAD_ABUSE_SECRET: "synthetic-private-view-abuse-secret-71aa90xx",
  };
  const redeem = (id = viewId) =>
    createArtifactFetchHandler({ db, now: NOW })(
      new Request(`${ORIGIN}/view/${id}/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "192.0.2.77",
        },
        body: new URLSearchParams({ view_secret: secret.secret, view_nonce: nonce }).toString(),
      }),
      env,
    );
  return { db, hooks, revoke, redeem, viewId, publication, gets: () => gets };
}

async function expectRejected(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error: "request_rejected", message: "request rejected" });
  expect(text).not.toContain(PRIVATE_TEXT);
  expect(text).not.toContain(DIGEST);
  expect(response.headers.get("etag")).toBeNull();
}

describe("private artifact byte delivery", () => {
  it("serves an available version to its current read grantee", async () => {
    const f = await fixture(),
      response = await f.redeem();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(PRIVATE_TEXT);
    expect(f.gets()).toBe(1);
  });
  it.each(["before", "get", "bytes"] as const)(
    "rejects revoke at %s uniformly without bytes or digest",
    async (timing) => {
      const f = await fixture();
      if (timing === "before") await f.revoke();
      else f.hooks[timing] = f.revoke;
      await expectRejected(await f.redeem());
      await expectRejected(await f.redeem(randomUlid()));
      expect(f.gets()).toBe(timing === "before" ? 0 : 1);
      expect(
        await f.db.prepare("SELECT consumed_at FROM artifact_view_grants WHERE id=?").get(f.viewId),
      ).toEqual({ consumed_at: timing === "before" ? null : NOW });
    },
  );
  it("rechecks the retained human epoch after the object body await", async () => {
    const f = await fixture();
    f.hooks.bytes = async () => {
      await f.db
        .prepare("UPDATE workspace_authorization_epochs SET revoked_at=? WHERE human_id=?")
        .run(NOW, FIX.owner);
    };
    await expectRejected(await f.redeem());
  });
  it("rejects revoked authority before reporting object integrity", async () => {
    const f = await fixture();
    f.hooks.bytes = f.revoke;
    f.hooks.content = new TextEncoder().encode("synthetic altered object");
    await expectRejected(await f.redeem());
  });
});
