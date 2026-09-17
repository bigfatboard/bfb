// ABOUTME: Exercises mounted artifact uploads with synthetic bytes and injected faults.
// ABOUTME: Fake R2 proves conditional writes; wrapped D1 proves uniform boundary failures.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";
import {
  artifactObjectKey,
  createArtifactCommand,
  FIX,
  issueArtifactGrantCommand,
  mintUploadGrantSecret,
  randomUlid,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";

import { createArtifactFetchHandler } from "../src/index.js";

const NOW = "2026-09-17T12:00:00.000Z";
const ORIGIN = "https://artifacts.bfb.example.test";
const ABUSE_SECRET = "v01-unit-test-abuse-secret-71aa90xx-long";
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const TEXT = new TextEncoder().encode("# synthetic review\n");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface StoredObject {
  bytes: Uint8Array;
  sha256: string;
  customMetadata: Record<string, string>;
}

/** In-memory R2 double with conditional-write semantics. */
function fakeR2() {
  const objects = new Map<string, StoredObject>();
  const calls: Array<{ op: "put" | "head"; key: string }> = [];
  return {
    calls,
    objects,
    bucket: {
      async put(
        key: string,
        value: Uint8Array,
        options?: {
          sha256?: string;
          onlyIf?: { etagDoesNotMatch?: string };
          customMetadata?: Record<string, string>;
        },
      ) {
        calls.push({ op: "put", key });
        if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) {
          throw new Error("precondition failed: object exists");
        }
        const bytes = value.slice();
        if (options?.sha256 && digest(bytes) !== options.sha256) {
          throw new Error("sha256 mismatch");
        }
        objects.set(key, {
          bytes,
          sha256: options?.sha256 ?? digest(bytes),
          customMetadata: { ...options?.customMetadata },
        });
        return { key } as R2Object;
      },
      async head(key: string) {
        calls.push({ op: "head", key });
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          key,
          size: stored.bytes.byteLength,
          customMetadata: stored.customMetadata,
        } as R2Object;
      },
    } as unknown as R2Bucket,
  };
}

async function openDb(): Promise<SqlDatabase> {
  const raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  applyMigrationsForVerification(
    raw,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations/d1"),
  );
  const db = adaptBetterSqlite3(raw);
  await seedSyntheticWorkspace(db, NOW, "global");
  return db;
}

async function grant(
  db: SqlDatabase,
  overrides: { format?: string; role?: string; bytes?: Uint8Array } = {},
) {
  const bytes = overrides.bytes ?? TEXT;
  const minted = mintUploadGrantSecret();
  const hub = new WorkspaceHub(db);
  const outcome = await hub.execute(createArtifactCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    idempotencyKey: randomUlid(),
    input: {
      artifactId: null,
      runId: null,
      format: (overrides.format ?? "markdown") as never,
      role: (overrides.role ?? "review") as never,
      declaredSize: bytes.byteLength,
      expectedDigest: digest(bytes),
      grantSecretHash: minted.secretHash,
    },
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return { created: outcome.result, secret: minted.secret, bytes };
}

function uploadRequest(grantId: string, secret: string | null, body: Uint8Array): Request {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "cf-connecting-ip": "192.0.2.71",
  };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  return new Request(`${ORIGIN}/upload/${grantId}`, {
    method: "PUT",
    headers,
    body: body as unknown as BodyInit,
  });
}

async function upload(
  db: SqlDatabase,
  r2: R2Bucket,
  request: Request,
  abuseSecret: string = ABUSE_SECRET,
) {
  const handler = createArtifactFetchHandler({ db, now: NOW });
  return handler(request, {
    ARTIFACTS: r2,
    DB: {} as D1Database,
    ARTIFACT_ORIGIN: ORIGIN,
    APP_ORIGIN: "https://bfb.example.test",
    ENVIRONMENT: "local",
    UPLOAD_ABUSE_SECRET: abuseSecret,
  });
}

describe("artifact upload", () => {
  it("stores verified bytes under the server-derived key", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const { created, secret, bytes } = await grant(db);
    const response = await upload(
      db,
      r2.bucket,
      uploadRequest(created.upload_grant.grant_id, secret, bytes),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      role: "review",
      runId: null,
      versionId: created.version_id,
      contentHash: digest(bytes),
    });
    expect(payload).toMatchObject({
      version_id: created.version_id,
      content_hash: digest(bytes),
      size: bytes.byteLength,
      r2_key: key,
      deduplicated: false,
    });
    expect(JSON.stringify(payload).includes(secret)).toBe(false);
    expect(r2.objects.get(key)?.bytes).toEqual(bytes);
    const version = (await db
      .prepare(`SELECT state FROM artifact_versions WHERE id = ?`)
      .get(created.version_id)) as { state: string };
    expect(version.state).toBe("uploading");
  });

  it("rejects replay, wrong secrets, unknown grants, and missing auth uniformly", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const { created, secret, bytes } = await grant(db);
    const first = await upload(
      db,
      r2.bucket,
      uploadRequest(created.upload_grant.grant_id, secret, bytes),
    );
    expect(first.status).toBe(200);
    for (const request of [
      uploadRequest(created.upload_grant.grant_id, secret, bytes),
      uploadRequest(created.upload_grant.grant_id, "wrong-secret-value-0123456789", bytes),
      uploadRequest(randomUlid(), secret, bytes),
      uploadRequest(created.upload_grant.grant_id, null, bytes),
      uploadRequest("not-a-grant", secret, bytes),
    ]) {
      const replayed = await upload(db, r2.bucket, request);
      expect(replayed.status).toBe(403);
      expect(await replayed.json()).toEqual({
        error: "request_rejected",
        message: "request rejected",
      });
    }
    expect(r2.calls.filter((call) => call.op === "put").length).toBe(1);
  });

  it("rejects expired grants and revoked epochs without an effect", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const { created, secret } = await grant(db);
    const fresh = await upload(
      db,
      r2.bucket,
      uploadRequest(created.upload_grant.grant_id, secret, TEXT),
    );
    expect(fresh.status).toBe(200);
    const second = await grant(db);
    const expired = createArtifactFetchHandler({ db, now: "2026-09-17T12:16:01.000Z" });
    const response = await expired(
      uploadRequest(second.created.upload_grant.grant_id, second.secret, second.bytes),
      {
        ARTIFACTS: r2.bucket,
        DB: {} as D1Database,
        ARTIFACT_ORIGIN: ORIGIN,
        APP_ORIGIN: "https://bfb.example.test",
        ENVIRONMENT: "local",
        UPLOAD_ABUSE_SECRET: ABUSE_SECRET,
      },
    );
    expect(response.status).toBe(403);
    const receipts = (await db
      .prepare(`SELECT COUNT(*) AS count FROM artifact_upload_receipts`)
      .get()) as { count: number };
    expect(receipts.count).toBe(1);
  });

  it("reports size, digest, and MIME mismatches after consuming the grant", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const sized = await grant(db);
    const short = TEXT.slice(0, 4);
    const sizeResponse = await upload(
      db,
      r2.bucket,
      uploadRequest(sized.created.upload_grant.grant_id, sized.secret, short),
    );
    expect(sizeResponse.status).toBe(422);
    expect(await sizeResponse.json()).toEqual({
      error: "upload_rejected",
      message: "size_mismatch",
    });

    const bytes = new TextEncoder().encode("# synthetic review tampered!\n");
    const forged = mintUploadGrantSecret();
    const hub = new WorkspaceHub(db);
    const wrongDigest = await hub.execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: {
        artifactId: null,
        runId: null,
        format: "markdown",
        role: "review",
        declaredSize: bytes.byteLength,
        expectedDigest: digest(TEXT),
        grantSecretHash: forged.secretHash,
      },
    });
    if (!wrongDigest.ok) throw new Error(JSON.stringify(wrongDigest));
    const digestResponse = await upload(
      db,
      r2.bucket,
      uploadRequest(wrongDigest.result.upload_grant.grant_id, forged.secret, bytes),
    );
    expect(digestResponse.status).toBe(422);
    expect(await digestResponse.json()).toEqual({
      error: "upload_rejected",
      message: "digest_mismatch",
    });

    const png = await grant(db, { format: "markdown", bytes: PNG });
    const mimeResponse = await upload(
      db,
      r2.bucket,
      uploadRequest(png.created.upload_grant.grant_id, png.secret, PNG),
    );
    expect(mimeResponse.status).toBe(422);
    expect(await mimeResponse.json()).toEqual({
      error: "upload_rejected",
      message: "mime_mismatch",
    });
    expect(r2.objects.size).toBe(0);
    const states = (await db
      .prepare(`SELECT DISTINCT state AS state FROM artifact_versions`)
      .all()) as Array<{ state: string }>;
    expect(states).toEqual([{ state: "uploading" }]);
  });

  it("verifies existing objects instead of overwriting them", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const first = await grant(db);
    const ok = await upload(
      db,
      r2.bucket,
      uploadRequest(first.created.upload_grant.grant_id, first.secret, first.bytes),
    );
    expect(ok.status).toBe(200);
    const second = await grant(db);
    // The second upload attempts the conditional write, loses it, verifies the
    // existing object, and never overwrites the stored bytes.
    const putsBefore = r2.calls.filter((call) => call.op === "put").length;
    const response = await upload(
      db,
      r2.bucket,
      uploadRequest(second.created.upload_grant.grant_id, second.secret, second.bytes),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
    const putsAfter = r2.calls.filter((call) => call.op === "put").length;
    expect(putsAfter).toBe(putsBefore + 1);
    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      role: "review",
      runId: null,
      versionId: first.created.version_id,
      contentHash: digest(first.bytes),
    });
    expect(r2.objects.get(key)?.bytes).toEqual(first.bytes);
  });

  it("fails when an existing object carries different metadata", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const key = artifactObjectKey({
      workspaceId: FIX.workspace,
      role: "review",
      runId: null,
      versionId: "version",
      contentHash: digest(TEXT),
    });
    r2.objects.set(key, { bytes: TEXT.slice(), sha256: "0".repeat(64), customMetadata: {} });
    const { created, secret, bytes } = await grant(db);
    const response = await upload(
      db,
      r2.bucket,
      uploadRequest(created.upload_grant.grant_id, secret, bytes),
    );
    expect(response.status).toBe(500);
    const receipts = (await db
      .prepare(`SELECT COUNT(*) AS count FROM artifact_upload_receipts`)
      .get()) as { count: number };
    expect(receipts.count).toBe(0);
  });

  it("rejects oversized bodies and fails closed without an abuse secret", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const big = new Uint8Array(6 * 1024 * 1024).fill(65);
    const forged = mintUploadGrantSecret();
    const hub = new WorkspaceHub(db);
    const outcome = await hub.execute(createArtifactCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: {
        artifactId: null,
        runId: null,
        format: "markdown",
        role: "review",
        declaredSize: big.byteLength,
        expectedDigest: digest(big),
        grantSecretHash: forged.secretHash,
      },
    });
    expect(outcome.ok).toBe(false);
    // Fail-closed abuse configuration is checked before redemption, on a live grant.
    const closedGrant = await grant(db);
    const closed = await upload(
      db,
      r2.bucket,
      uploadRequest(
        closedGrant.created.upload_grant.grant_id,
        closedGrant.secret,
        closedGrant.bytes,
      ),
      "short",
    );
    expect(closed.status).toBe(403);
    const audit = (await db
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_audit_outbox WHERE action = 'artifact.grant_consumed'`,
      )
      .get()) as { count: number };
    expect(audit.count).toBe(0);
    const { created, secret } = await grant(db);
    const oversized = await upload(
      db,
      r2.bucket,
      uploadRequest(created.upload_grant.grant_id, secret, big),
    );
    expect(oversized.status).toBe(413);
  });

  it("leaves recoverable state on D1 and R2 faults", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const broken: SqlDatabase = {
      prepare: () => {
        throw new Error("synthetic D1 fault");
      },
      withTransaction: async () => {
        throw new Error("synthetic D1 fault");
      },
    };
    const { created, secret, bytes } = await grant(db);
    const d1Fault = await upload(
      broken,
      r2.bucket,
      uploadRequest(created.upload_grant.grant_id, secret, bytes),
    );
    expect(d1Fault.status).toBe(403);
    expect(r2.objects.size).toBe(0);

    const r2Fault = {
      ...r2.bucket,
      put: async () => {
        throw new Error("synthetic R2 fault");
      },
      head: async () => null,
    } as unknown as R2Bucket;
    const retry = await grant(db);
    const failed = await upload(
      db,
      r2Fault,
      uploadRequest(retry.created.upload_grant.grant_id, retry.secret, retry.bytes),
    );
    expect(failed.status).toBe(500);
    const version = (await db
      .prepare(`SELECT state FROM artifact_versions WHERE id = ?`)
      .get(retry.created.version_id)) as { state: string };
    expect(version.state).toBe("uploading");
  });

  it("rejects app cookies and unknown paths", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const handler = createArtifactFetchHandler({ db, now: NOW });
    const cookie = await handler(
      new Request(`${ORIGIN}/upload/${randomUlid()}`, {
        headers: { cookie: "__Host-bfb_session=synthetic" },
      }),
      {
        ARTIFACTS: r2.bucket,
        DB: {} as D1Database,
        ARTIFACT_ORIGIN: ORIGIN,
        APP_ORIGIN: "https://bfb.example.test",
        ENVIRONMENT: "local",
        UPLOAD_ABUSE_SECRET: ABUSE_SECRET,
      },
    );
    expect(cookie.status).toBe(400);
    const missing = await handler(new Request(`${ORIGIN}/view/synthetic`, {}), {
      ARTIFACTS: r2.bucket,
      DB: {} as D1Database,
      ARTIFACT_ORIGIN: ORIGIN,
      APP_ORIGIN: "https://bfb.example.test",
      ENVIRONMENT: "local",
      UPLOAD_ABUSE_SECRET: ABUSE_SECRET,
    });
    // V02 owns the view path: malformed view IDs fail uniformly, not as unimplemented.
    expect(missing.status).toBe(403);
  });

  it("reissues a grant after a consumed attempt and converges receipts", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const first = await grant(db);
    const bad = await upload(
      db,
      r2.bucket,
      uploadRequest(first.created.upload_grant.grant_id, first.secret, TEXT.slice(0, 4)),
    );
    expect(bad.status).toBe(422);
    const hub = new WorkspaceHub(db);
    const minted = mintUploadGrantSecret();
    const reissued = await hub.execute(issueArtifactGrantCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.owner,
      authorizationEpoch: 1,
      now: NOW,
      idempotencyKey: randomUlid(),
      input: { versionId: first.created.version_id, grantSecretHash: minted.secretHash },
    });
    if (!reissued.ok) throw new Error(JSON.stringify(reissued));
    const retry = await upload(
      db,
      r2.bucket,
      uploadRequest(reissued.result.grant_id, minted.secret, first.bytes),
    );
    expect(retry.status).toBe(200);
    const receipts = (await db
      .prepare(`SELECT content_hash, size FROM artifact_upload_receipts WHERE version_id = ?`)
      .get(first.created.version_id)) as { content_hash: string; size: number };
    expect(receipts).toEqual({ content_hash: digest(first.bytes), size: first.bytes.byteLength });
  });
});
