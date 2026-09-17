// ABOUTME: Exercises mounted view bootstrap and redemption against synthetic bytes.
// ABOUTME: Fake R2 proves header policy, uniform failures, budgets, and byte integrity.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { adaptBetterSqlite3, applyMigrationsForVerification, type SqlDatabase } from "@bfb/db";
import {
  artifactHash,
  artifactObjectKey,
  createArtifactCommand,
  createViewGrantCommand,
  finalizeArtifactCommand,
  FIX,
  issueViewGrantResponse,
  mintUploadGrantSecret,
  mintViewGrantSecret,
  mintViewNonce,
  randomUlid,
  recordVerifiedUpload,
  redeemUploadGrant,
  seedSyntheticWorkspace,
  WorkspaceHub,
} from "@bfb/domain";
import { bumpMemberEpoch } from "@bfb/domain";

import { createArtifactFetchHandler } from "../src/index.js";
import {
  buildViewBootstrap,
  VIEW_BOOTSTRAP_SCRIPT,
  viewBootstrapCsp,
  viewFinalCsp,
  VIEW_PERMISSIONS_POLICY,
} from "../src/view.js";

const NOW = "2026-09-17T12:00:00.000Z";
const LATE = "2026-09-17T12:05:01.000Z";
const ORIGIN = "https://artifacts.bfb.example.test";
const APP_ORIGIN = "https://bfb.example.test";
const ABUSE_SECRET = "v02-unit-test-abuse-secret-71aa90xx-long";
const SESSION_HASH = createHash("sha256").update("synthetic-session").digest("hex");
const HTML = new TextEncoder().encode(
  `<!doctype html><html><head><title>t</title></head><body><script>fetch("https://bfb.example.test/api").then(()=>top.location="https://evil.example.test")</script><form action="https://evil.example.test" method="post"><input name="x"></form></body></html>`,
);
const MARKDOWN = new TextEncoder().encode(`# synthetic review\n`);
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33,
]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface StoredObject {
  bytes: Uint8Array;
}

/** In-memory R2 double with get/put/head and call accounting. */
function fakeR2() {
  const objects = new Map<string, StoredObject>();
  const calls: Array<{ op: "put" | "head" | "get"; key: string }> = [];
  return {
    calls,
    objects,
    bucket: {
      async put(key: string, value: Uint8Array) {
        calls.push({ op: "put", key });
        objects.set(key, { bytes: value.slice() });
        return { key } as R2Object;
      },
      async head(key: string) {
        calls.push({ op: "head", key });
        const stored = objects.get(key);
        if (!stored) return null;
        return { key, size: stored.bytes.byteLength } as R2Object;
      },
      async get(key: string) {
        calls.push({ op: "get", key });
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          key,
          size: stored.bytes.byteLength,
          async arrayBuffer() {
            return stored.bytes.slice().buffer as ArrayBuffer;
          },
        } as unknown as R2ObjectBody;
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

function env(r2: R2Bucket) {
  return {
    ARTIFACTS: r2,
    DB: {} as D1Database,
    ARTIFACT_ORIGIN: ORIGIN,
    APP_ORIGIN,
    ENVIRONMENT: "local",
    UPLOAD_ABUSE_SECRET: ABUSE_SECRET,
  };
}

async function call(
  db: SqlDatabase,
  r2: R2Bucket,
  request: Request,
  now: string = NOW,
): Promise<Response> {
  return createArtifactFetchHandler({ db, now })(request, env(r2));
}

async function publish(
  db: SqlDatabase,
  r2: { bucket: R2Bucket; objects: Map<string, StoredObject> },
  options: { format: string; bytes: Uint8Array },
): Promise<{ version_id: string; content_hash: string }> {
  const hub = new WorkspaceHub(db);
  const minted = mintUploadGrantSecret();
  const created = await hub.execute(createArtifactCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    idempotencyKey: randomUlid(),
    input: {
      artifactId: null,
      runId: null,
      format: options.format as never,
      role: "review" as never,
      declaredSize: options.bytes.byteLength,
      expectedDigest: digest(options.bytes),
      grantSecretHash: minted.secretHash,
    },
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  await redeemUploadGrant(db, {
    grantId: created.result.upload_grant.grant_id,
    secret: minted.secret,
    now: NOW,
  });
  const key = artifactObjectKey({
    workspaceId: FIX.workspace,
    role: "review",
    runId: null,
    versionId: created.result.version_id,
    contentHash: digest(options.bytes),
  });
  await r2.bucket.put(key, options.bytes);
  await recordVerifiedUpload(db, {
    workspaceId: FIX.workspace,
    versionId: created.result.version_id,
    runId: null,
    role: "review",
    contentHash: digest(options.bytes),
    r2Key: key,
    size: options.bytes.byteLength,
    now: NOW,
  });
  const finalized = await hub.execute(finalizeArtifactCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    idempotencyKey: randomUlid(),
    input: {
      versionId: created.result.version_id,
      contentHash: digest(options.bytes),
      size: options.bytes.byteLength,
    },
  });
  if (!finalized.ok) throw new Error(JSON.stringify(finalized));
  return { version_id: created.result.version_id, content_hash: digest(options.bytes) };
}

async function issue(
  db: SqlDatabase,
  versionId: string,
): Promise<{ view_id: string; secret: string; nonce: string }> {
  const hub = new WorkspaceHub(db);
  const minted = mintViewGrantSecret();
  const nonce = mintViewNonce();
  const outcome = await hub.execute(createViewGrantCommand, {
    workspaceId: FIX.workspace,
    actorHumanId: FIX.owner,
    authorizationEpoch: 1,
    now: NOW,
    idempotencyKey: randomUlid(),
    input: {
      versionId,
      grantSecretHash: minted.secretHash,
      viewNonce: nonce,
      sessionHash: SESSION_HASH,
    },
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  const issued = issueViewGrantResponse(outcome.result, minted.secret, nonce);
  return { view_id: issued.view_id, secret: issued.secret, nonce: issued.nonce };
}

function bootstrapRequest(viewId: string, init: RequestInit = {}): Request {
  return new Request(`${ORIGIN}/view/${viewId}`, { method: "GET", ...init });
}

function redeemRequest(
  viewId: string,
  secret: string | null,
  nonce: string | null,
  extra: Record<string, string> = {},
): Request {
  const form = new URLSearchParams();
  if (secret !== null) form.set("view_secret", secret);
  if (nonce !== null) form.set("view_nonce", nonce);
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new Request(`${ORIGIN}/view/${viewId}/redeem`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": "192.0.2.71",
      referer: `${ORIGIN}/view/${viewId}`,
    },
    body: form.toString(),
  });
}

function expectNoCookie(response: Response): void {
  expect(response.headers.get("set-cookie")).toBeNull();
}

describe("artifact view bootstrap", () => {
  it("serves a fixed byte-identical document with the bootstrap policy", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const first = await call(db, r2.bucket, bootstrapRequest(randomUlid()));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(first.headers.get("content-security-policy")).toBe(viewBootstrapCsp(APP_ORIGIN));
    expect(first.headers.get("content-security-policy")).not.toContain("sandbox");
    expect(first.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(first.headers.get("content-security-policy")).toContain(`frame-ancestors ${APP_ORIGIN}`);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("permissions-policy")).toBe(VIEW_PERMISSIONS_POLICY);
    expectNoCookie(first);
    const body = await first.text();
    expect(body).toBe(buildViewBootstrap());
    const second = await call(db, r2.bucket, bootstrapRequest(randomUlid()));
    expect(await second.text()).toBe(body);
    // The fixed field names are protocol; no credential value is embedded.
    expect(body).toContain('"view_secret"');
    expect(body).toContain('"view_nonce"');
    expect(body.includes(mintViewGrantSecret().secret)).toBe(false);
  });

  it("rejects malformed view IDs and wrong methods without an oracle", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const malformed = await call(db, r2.bucket, bootstrapRequest("not-a-view"));
    expect(malformed.status).toBe(403);
    expect(await malformed.json()).toEqual({ error: "request_rejected", message: "request rejected" });
    const posted = await call(
      db,
      r2.bucket,
      new Request(`${ORIGIN}/view/${randomUlid()}`, { method: "POST" }),
    );
    expect(posted.status).toBe(405);
  });

  it("refuses app session cookies on the artifact origin", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const response = await call(
      db,
      r2.bucket,
      new Request(`${ORIGIN}/view/${randomUlid()}`, {
        headers: { cookie: "__Host-bfb_session=stolen-value" },
      }),
    );
    expect(response.status).toBe(400);
    expectNoCookie(response);
  });
});

describe("artifact view redemption", () => {
  it("returns raw hostile HTML under the exact final policy", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const version = await publish(db, r2, { format: "html", bytes: HTML });
    const grant = await issue(db, version.version_id);
    const response = await call(db, r2.bucket, redeemRequest(grant.view_id, grant.secret, grant.nonce));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe(viewFinalCsp(APP_ORIGIN));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("permissions-policy")).toBe(VIEW_PERMISSIONS_POLICY);
    expectNoCookie(response);
    // Raw bytes are served; containment comes from the sandbox and CSP claims
    // proven by the browser suite, not from server-side sanitizing.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(HTML);
  });

  it("serves every format with its content type and the same policy", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const svg = new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    );
    const cases: Array<{ format: string; bytes: Uint8Array; type: string }> = [
      { format: "svg", bytes: svg, type: "image/svg+xml" },
      { format: "png", bytes: PNG, type: "image/png" },
      { format: "markdown", bytes: MARKDOWN, type: "text/html; charset=utf-8" },
      {
        format: "mermaid",
        bytes: new TextEncoder().encode("graph TD\nA-->B\n"),
        type: "text/html; charset=utf-8",
      },
      { format: "diff", bytes: new TextEncoder().encode("--- a\n+++ b\n"), type: "text/html; charset=utf-8" },
      { format: "json", bytes: new TextEncoder().encode(`{"a":1}`), type: "text/html; charset=utf-8" },
      { format: "log", bytes: new TextEncoder().encode("line one\n"), type: "text/html; charset=utf-8" },
    ];
    for (const candidate of cases) {
      const version = await publish(db, r2, { format: candidate.format, bytes: candidate.bytes });
      const grant = await issue(db, version.version_id);
      const response = await call(
        db,
        r2.bucket,
        redeemRequest(grant.view_id, grant.secret, grant.nonce),
      );
      expect(response.status, candidate.format).toBe(200);
      expect(response.headers.get("content-type"), candidate.format).toBe(candidate.type);
      expect(response.headers.get("content-security-policy"), candidate.format).toBe(
        viewFinalCsp(APP_ORIGIN),
      );
      expectNoCookie(response);
      const body = await response.text();
      expect(body.includes(grant.secret), candidate.format).toBe(false);
      expect(body.includes(grant.nonce), candidate.format).toBe(false);
    }
    const rendered = await (
      await call(
        db,
        r2.bucket,
        redeemRequest(
          (await issue(db, (await publish(db, r2, { format: "markdown", bytes: MARKDOWN })).version_id))
            .view_id,
          "x".repeat(43),
          "0".repeat(32),
        ),
      )
    ).text();
    expect(rendered).toContain("request rejected");
  });

  it("rejects replay, wrong secrets, wrong nonces, and malformed redemption uniformly", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const version = await publish(db, r2, { format: "html", bytes: HTML });
    const grant = await issue(db, version.version_id);
    const getsBefore = r2.calls.filter((entry) => entry.op === "get").length;
    const first = await call(db, r2.bucket, redeemRequest(grant.view_id, grant.secret, grant.nonce));
    expect(first.status).toBe(200);
    const uniform = { error: "request_rejected", message: "request rejected" };
    const attempts: Request[] = [
      redeemRequest(grant.view_id, grant.secret, grant.nonce),
      redeemRequest(grant.view_id, mintViewGrantSecret().secret, grant.nonce),
      redeemRequest(grant.view_id, grant.secret, mintViewNonce()),
      redeemRequest(randomUlid(), grant.secret, grant.nonce),
      redeemRequest("not-a-view", grant.secret, grant.nonce),
      redeemRequest(grant.view_id, null, grant.nonce),
      redeemRequest(grant.view_id, grant.secret, null),
      redeemRequest(grant.view_id, grant.secret, grant.nonce, { extra: "smuggled" }),
      new Request(`${ORIGIN}/view/${grant.view_id}/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.71" },
        body: JSON.stringify({ view_secret: grant.secret, view_nonce: grant.nonce }),
      }),
      new Request(`${ORIGIN}/view/${grant.view_id}/redeem`, { method: "GET" }),
    ];
    for (const attempt of attempts) {
      const response = await call(db, r2.bucket, attempt);
      expect(response.status).toBe(response.status === 405 ? 405 : 403);
      if (response.status === 403) {
        expect(await response.json()).toEqual(uniform);
      }
      expectNoCookie(response);
    }
    // Only the single successful redemption read object bytes.
    expect(r2.calls.filter((entry) => entry.op === "get").length).toBe(getsBefore + 1);
  });

  it("fails oversized redemption bodies before bytes", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const version = await publish(db, r2, { format: "html", bytes: HTML });
    const grant = await issue(db, version.version_id);
    const response = await call(
      db,
      r2.bucket,
      new Request(`${ORIGIN}/view/${grant.view_id}/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "192.0.2.71",
        },
        body: `view_secret=${grant.secret}&view_nonce=${grant.nonce}&pad=${"x".repeat(9000)}`,
      }),
    );
    expect(response.status).toBe(413);
    expect(r2.calls.filter((entry) => entry.op === "get").length).toBe(0);
  });

  it("rejects expired grants and revoked epochs before bytes", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const version = await publish(db, r2, { format: "html", bytes: HTML });
    const grant = await issue(db, version.version_id);
    const expired = await createArtifactFetchHandler({ db, now: LATE })(
      redeemRequest(grant.view_id, grant.secret, grant.nonce),
      env(r2.bucket),
    );
    expect(expired.status).toBe(403);
    const live = await issue(db, version.version_id);
    await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
    const revoked = await call(db, r2.bucket, redeemRequest(live.view_id, live.secret, live.nonce));
    expect(revoked.status).toBe(403);
    expect(r2.calls.filter((entry) => entry.op === "get").length).toBe(0);
  });

  it("fails closed on missing or tampered R2 bytes without leaking the grant", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const version = await publish(db, r2, { format: "html", bytes: HTML });
    const key = `workspaces/${FIX.workspace}/artifacts/sha256/${digest(HTML)}`;
    const missing = await issue(db, version.version_id);
    r2.objects.delete(key);
    const gone = await call(db, r2.bucket, redeemRequest(missing.view_id, missing.secret, missing.nonce));
    expect(gone.status).toBe(500);
    expect(await gone.json()).toEqual({ error: "view_failed" });
    const tampered = await issue(db, version.version_id);
    r2.objects.set(key, { bytes: new TextEncoder().encode("tampered bytes") });
    const corrupt = await call(
      db,
      r2.bucket,
      redeemRequest(tampered.view_id, tampered.secret, tampered.nonce),
    );
    expect(corrupt.status).toBe(500);
    const body = await corrupt.text();
    expect(body.includes(tampered.secret)).toBe(false);
    expect(body).not.toContain(digest(HTML));
  });

  it("keeps redemption attempt caps durable across isolates", async () => {
    const db = await openDb();
    const r2 = fakeR2();
    const version = await publish(db, r2, { format: "html", bytes: HTML });
    const grants: Array<{ view_id: string; secret: string; nonce: string }> = [];
    for (let index = 0; index < 21; index += 1) {
      grants.push(await issue(db, version.version_id));
    }
    const statuses: number[] = [];
    for (const grant of grants) {
      const response = await call(
        db,
        r2.bucket,
        new Request(`${ORIGIN}/view/${grant.view_id}/redeem`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": "192.0.2.94",
          },
          body: `view_secret=${encodeURIComponent(grant.secret)}&view_nonce=${grant.nonce}`,
        }),
      );
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(statuses[20]).toBe(403);
    // The budgeted-out grant was never consumed, so a fresh IP still redeems it.
    const spared = grants[20]!;
    const retry = await call(
      db,
      r2.bucket,
      new Request(`${ORIGIN}/view/${spared.view_id}/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "192.0.2.95",
        },
        body: `view_secret=${encodeURIComponent(spared.secret)}&view_nonce=${spared.nonce}`,
      }),
    );
    expect(retry.status).toBe(200);
  });
});

describe("view bootstrap channel", () => {
  function drive(pathname: string, parentThrows = false) {
    const submitted: Array<{ action: string; method: string; fields: Record<string, string> }> = [];
    const parentPosts: Array<{ message: unknown; transfer: unknown[] }> = [];
    const hints: string[] = [];
    let portHandler: ((event: { data: unknown }) => void) | null = null;
    const port1 = {
      closed: 0,
      close() {
        this.closed += 1;
      },
      set onmessage(handler: (event: { data: unknown }) => void) {
        portHandler = handler;
      },
    };
    const fakeChannel = { port1, port2: { kind: "port2" } };
    const fakeDocument = {
      createElement(tag: string) {
        if (tag === "form") {
          return {
            tag,
            method: "",
            action: "",
            children: [] as unknown[],
            appendChild(child: unknown) {
              this.children.push(child);
            },
            submit() {
              const fields: Record<string, string> = {};
              for (const child of this.children as Array<{
                name?: string;
                value?: string;
              }>) {
                if (child.name) fields[child.name] = child.value ?? "";
              }
              submitted.push({ action: this.action, method: this.method, fields });
            },
          };
        }
        return {
          tag,
          type: "",
          name: "",
          value: "",
        };
      },
      body: {
        appendChild(_child: unknown) {},
      },
      getElementById(_id: string) {
        return {
          set textContent(value: string) {
            hints.push(value);
          },
        };
      },
    };
    const fakeWindow = {
      setTimeout() {
        return 0;
      },
      parent: {
        postMessage(message: unknown, _target: string, transfer: unknown[]) {
          if (parentThrows) throw new Error("denied");
          parentPosts.push({ message, transfer });
        },
      },
    };
    const runner = new Function(
      "window",
      "document",
      "location",
      "setTimeout",
      "MessageChannel",
      `${VIEW_BOOTSTRAP_SCRIPT}\nreturn ${"null"};`,
    );
    runner(
      fakeWindow,
      fakeDocument,
      { pathname },
      () => 0,
      function FakeMessageChannel(this: unknown) {
        return fakeChannel;
      },
    );
    return {
      submitted,
      parentPosts,
      hints,
      deliver: (data: unknown) => portHandler?.({ data }),
    };
  }

  it("offers a fresh port to the parent and redeems exactly once over it", () => {
    const viewId = randomUlid();
    const secret = mintViewGrantSecret().secret;
    const nonce = mintViewNonce();
    const driven = drive(`/view/${viewId}`);
    // The ready signal carries no authority: a type tag plus the port only.
    expect(driven.parentPosts.length).toBe(1);
    expect(driven.parentPosts[0]!.message).toEqual({ type: "bfb-view-ready" });
    expect(driven.parentPosts[0]!.transfer.length).toBe(1);
    // Malformed grants over the port are ignored.
    for (const malformed of [
      null,
      "string",
      { type: "other", secret, nonce },
      { type: "bfb-view-grant", secret, nonce, extra: 1 },
      { type: "bfb-view-grant", secret: "short", nonce },
      { type: "bfb-view-grant", secret, nonce: "bad" },
    ]) {
      driven.deliver(malformed);
      expect(driven.submitted, JSON.stringify(malformed)).toEqual([]);
    }
    driven.deliver({ type: "bfb-view-grant", secret, nonce });
    expect(driven.submitted).toEqual([
      {
        action: `/view/${viewId}/redeem`,
        method: "POST",
        fields: { view_secret: secret, view_nonce: nonce },
      },
    ]);
    // A second grant over the same port is ignored after the single redemption.
    driven.deliver({ type: "bfb-view-grant", secret, nonce });
    expect(driven.submitted.length).toBe(1);
  });

  it("shows a reload hint when the bootstrap path carries no view", () => {
    const driven = drive("/view/not-a-view");
    expect(driven.parentPosts.length).toBe(1);
    driven.deliver({
      type: "bfb-view-grant",
      secret: mintViewGrantSecret().secret,
      nonce: mintViewNonce(),
    });
    expect(driven.submitted).toEqual([]);
    expect(driven.hints.length).toBeGreaterThan(0);
  });

  it("shows a reload hint when the parent post is refused", () => {
    const driven = drive(`/view/${randomUlid()}`, true);
    expect(driven.parentPosts).toEqual([]);
    expect(driven.hints.length).toBeGreaterThan(0);
  });

  it("keeps the secret hash binding verifiable off the wire", () => {
    const secret = mintViewGrantSecret().secret;
    expect(artifactHash(secret)).toMatch(/^[0-9a-f]{64}$/);
  });
});
