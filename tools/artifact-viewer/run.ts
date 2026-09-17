// ABOUTME: Certifies artifact previews across two control isolates and the Artifact Worker.
// ABOUTME: Real D1, disposable R2, and the production hub prove headers, corpus, and budgets.

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildViewBootstrap,
  viewBootstrapCsp,
  viewFinalCsp,
  VIEW_PERMISSIONS_POLICY,
} from "@bfb/artifact-worker";
import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import {
  FIX,
  bumpMemberEpoch,
  seedSyntheticWorkspace,
  syntheticUlid,
} from "@bfb/domain";
import { createTestHarness } from "wrangler";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ORIGIN = "https://bfb.v02.test";
const ARTIFACT_ORIGIN = "https://artifacts.v02.test";
const T0 = "2026-09-17T12:00:00.000Z";
const T1 = "2026-09-17T12:05:00.000Z";
const T1_LATE = "2026-09-17T12:11:01.000Z";
const T2 = "2026-09-17T12:10:00.000Z";
const T3 = "2026-09-17T12:15:00.000Z";
const SIGNING = "v02-runtime-current-signing-key-55c1e7";
const SESSION = "v02-synthetic-session";
const SESSION_TOKEN = "v02-synthetic-session-token";
const MEMBER_SESSION = "v02-synthetic-member-session";
const MEMBER_TOKEN = "v02-synthetic-member-token";
const REVIEWER_SESSION = "v02-synthetic-reviewer-session";
const REVIEWER_TOKEN = "v02-synthetic-reviewer-token";

const HTML_HOSTILE = new TextEncoder().encode(
  `<!doctype html><html><head><title>hostile</title></head><body>` +
    `<script>fetch("https://bfb.v02.test/api/v1/workspaces/x").then(()=>top.location="https://evil.example.test/")</script>` +
    `<img src="https://bfb.v02.test/__test/hit?t=img">` +
    `<form action="https://bfb.v02.test/__test/hit?t=form" method="post"><input name="x" value="1"></form>` +
    `<a href="https://bfb.v02.test/__test/hit?t=download" download="x.html">dl</a>` +
    `<script>window.open("https://bfb.v02.test/__test/hit?t=popup");localStorage.setItem("x","1");parent.document.title="x"</script>` +
    `</body></html>`,
);
const SVG_HOSTILE = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">` +
    `<script>fetch("https://bfb.v02.test/api")</script>` +
    `<image href="https://bfb.v02.test/__test/hit?t=svg" width="10" height="10"/>` +
    `<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><form action="https://evil.example.test"/></body></foreignObject>` +
    `<rect width="10" height="10" onclick="alert(1)"/>` +
    `</svg>`,
);
const MD_HOSTILE = new TextEncoder().encode(
  `# synthetic review\n\n</script><script>alert(document.cookie)</script>\n\n` +
    `<img src=x onerror=alert(1)>\n\n[evil](javascript:alert(1))\n\n[beacon](https://bfb.v02.test/__test/hit?t=md)\n`,
);
const MERMAID_HOSTILE = new TextEncoder().encode(
  `graph TD\nA-->B\nclick A javascript:alert(document.cookie)\nstyle B fill:red\nB-->C\n`,
);
const MERMAID_HUGE = new TextEncoder().encode(
  `graph TD\n${Array.from({ length: 500 }, (_, index) => `N${index}-->M${index}`).join("\n")}\n`,
);
const JSON_HOSTILE = new TextEncoder().encode(
  `{"title":"</script><script>alert(1)</script>","url":"https://bfb.v02.test/__test/hit?t=json"}`,
);
const DIFF_HOSTILE = new TextEncoder().encode(
  `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-<script>alert(1)</script>\n+safe\n`,
);
const LOG_TEXT = new TextEncoder().encode(`line one\nline two\n`);
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33,
  0x44, 0x55, 0x66,
]);

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionPair(sessionId: string, token: string): { cookie: string; csrf: string } {
  const signed = `${token}.${createHmac("sha256", SIGNING).update(token).digest("base64")}`;
  return {
    cookie: `__Host-bfb_session=${encodeURIComponent(signed)}`,
    csrf: `2.${createHmac("sha256", SIGNING).update(`bfb-csrf:${sessionId}`).digest("hex")}`,
  };
}
const OWNER = sessionPair(SESSION, SESSION_TOKEN);
const MEMBER = sessionPair(MEMBER_SESSION, MEMBER_TOKEN);
const REVIEWER = sessionPair(REVIEWER_SESSION, REVIEWER_TOKEN);

const database = {
  binding: "DB",
  database_name: "bfb-v02-test",
  database_id: "00000000-0000-4000-8000-000000000026",
  migrations_dir: resolve(root, "migrations/d1"),
};
const base = {
  compatibility_date: "2026-08-08",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: [database],
};
const control = {
  ...base,
  main: resolve(root, "tools/artifact-viewer/control.ts"),
  vars: {
    ENVIRONMENT: "local",
    JURISDICTION: "global",
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN,
    LAUNCH_ORIGIN: "https://launch.v02.test",
    BETTER_AUTH_SECRETS: `2:${SIGNING},1:v02-runtime-previous-signing-key-9d22b0`,
    GITHUB_CLIENT_ID: "v02-synthetic-github-client",
    GITHUB_CLIENT_SECRET: "v02-synthetic-github-secret",
    AUTH_ABUSE_SECRET: "v02-synthetic-abuse-key-4c88e2abxx-long",
  },
  r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v02-artifacts" }],
  queues: {
    producers: [
      { binding: "JOBS", queue: "bfb-v02-jobs" },
      { binding: "JOBS_DLQ", queue: "bfb-v02-jobs-dlq" },
    ],
  },
  assets: { directory: resolve(root, "apps/web/dist"), binding: "ASSETS" },
  durable_objects: {
    bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub", script_name: "bfb-v02-hub" }],
  },
};
const server = createTestHarness({
  root,
  workers: [
    { config: { ...control, name: "bfb-v02-a" } },
    { config: { ...control, name: "bfb-v02-b" } },
    {
      config: {
        ...base,
        name: "bfb-v02-hub",
        main: resolve(root, "apps/control-worker/src/index.ts"),
        durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
        exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
      },
    },
    {
      config: {
        ...base,
        name: "bfb-v02-artifact",
        main: resolve(root, "tools/artifact-viewer/artifact.ts"),
        vars: {
          ENVIRONMENT: "local",
          ARTIFACT_ORIGIN,
          APP_ORIGIN: ORIGIN,
          UPLOAD_ABUSE_SECRET: "v02-harness-upload-abuse-secret-8e13d2axx-long",
        },
        r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v02-artifacts" }],
      },
    },
  ],
});

type Session = { cookie: string; csrf: string };

function browser(
  index: number,
  method: string,
  path: string,
  body: unknown,
  session: Session = OWNER,
  ip = "192.0.2.91",
  now: string = T0,
) {
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": ip,
      "x-v02-test-time": now,
      cookie: session.cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-bfb-csrf": session.csrf,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return server.getWorker(index % 2 ? "bfb-v02-b" : "bfb-v02-a").fetch(ORIGIN + path, init);
}

function upload(grantId: string, secret: string, body: Uint8Array, ip = "192.0.2.91", now: string = T0) {
  return server.getWorker("bfb-v02-artifact").fetch(`${ARTIFACT_ORIGIN}/upload/${grantId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "cf-connecting-ip": ip,
      "x-v02-test-time": now,
      authorization: `Bearer ${secret}`,
    },
    body: body as unknown as never,
  });
}

function bootstrap(viewId: string, ip = "192.0.2.91", now: string = T0) {
  return server.getWorker("bfb-v02-artifact").fetch(`${ARTIFACT_ORIGIN}/view/${viewId}`, {
    headers: { "cf-connecting-ip": ip, "x-v02-test-time": now },
  });
}

function redeem(
  viewId: string,
  secret: string | null,
  nonce: string | null,
  ip = "192.0.2.91",
  now: string = T0,
  extra = "",
) {
  const form = new URLSearchParams();
  if (secret !== null) form.set("view_secret", secret);
  if (nonce !== null) form.set("view_nonce", nonce);
  return server.getWorker("bfb-v02-artifact").fetch(`${ARTIFACT_ORIGIN}/view/${viewId}/redeem`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
      "x-v02-test-time": now,
      referer: `${ARTIFACT_ORIGIN}/view/${viewId}`,
    },
    body: `${form.toString()}${extra}` as unknown as never,
  });
}

type WorkerResponse = Awaited<ReturnType<typeof redeem>>;

async function rejected(response: WorkerResponse): Promise<void> {
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "request_rejected",
    message: "request rejected",
  });
}

async function seedHuman(
  db: SqlDatabase,
  userId: string,
  sessionId: string,
  token: string,
  humanId: string,
  email: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO better_auth_users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(userId, email, email, T0, T0);
  await db.prepare(`UPDATE humans SET better_auth_user_id = ? WHERE id = ?`).run(userId, humanId);
  await db
    .prepare(
      `INSERT INTO better_auth_sessions (id, expires_at, token, created_at, updated_at, user_id) VALUES (?, '2027-09-17T12:00:00.000Z', ?, ?, ?, ?)`,
    )
    .run(sessionId, token, T0, T0, userId);
}

type CreatedView = {
  view_id: string;
  version_id: string;
  content_hash: string;
  format: string;
  nonce: string;
  secret: string;
  expires_at: string;
};

async function createView(
  index: number,
  versionId: string,
  session: Session = OWNER,
  ip = "192.0.2.91",
  now: string = T0,
): Promise<CreatedView> {
  const response = await browser(
    index,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/artifacts/${versionId}/views`,
    {},
    session,
    ip,
    now,
  );
  assert.equal(response.status, 201, `view create failed: ${await response.clone().text()}`);
  return (await response.json()) as CreatedView;
}

async function publish(
  index: number,
  format: string,
  bytes: Uint8Array,
  ip = "192.0.2.91",
  now: string = T0,
): Promise<string> {
  const created = (await (
    await browser(
      index,
      "POST",
      `/api/v1/workspaces/${FIX.workspace}/artifacts`,
      {
        format,
        role: "review",
        declared_size: bytes.byteLength,
        expected_digest: digest(bytes),
      },
      OWNER,
      ip,
      now,
    )
  ).json()) as {
    version_id: string;
    upload_grant: { grant_id: string; secret: string };
  };
  const uploaded = await upload(created.upload_grant.grant_id, created.upload_grant.secret, bytes, ip, now);
  assert.equal(uploaded.status, 200, `upload failed: ${await uploaded.clone().text()}`);
  const finalized = await browser(
    1 - index,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/artifacts/${created.version_id}/finalize`,
    { content_hash: digest(bytes), size: bytes.byteLength },
    OWNER,
    ip,
    now,
  );
  assert.equal(finalized.status, 200, `finalize failed: ${await finalized.clone().text()}`);
  return created.version_id;
}

const outcomes: Record<string, number> = {};
function note(name: string, value = 1): void {
  outcomes[name] = (outcomes[name] ?? 0) + value;
}

const corpusRows: Array<{ case: string; proof: string; result: string }> = [];
const headerCaptures: Record<string, Record<string, string>> = {};

function captureHeaders(name: string, response: WorkerResponse): void {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headerCaptures[name] = headers;
}

function expectFinalPolicy(response: WorkerResponse, label: string): void {
  assert.equal(response.headers.get("content-security-policy"), viewFinalCsp(ORIGIN), `${label} CSP`);
  assert.equal(response.headers.get("cache-control"), "private, no-store", `${label} cache`);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer", `${label} referrer`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff", `${label} nosniff`);
  assert.equal(response.headers.get("permissions-policy"), VIEW_PERMISSIONS_POLICY, `${label} permissions`);
  assert.equal(response.headers.get("set-cookie"), null, `${label} set-cookie`);
}

try {
  await server.listen();
  const worker = server.getWorker("bfb-v02-a");
  await worker.applyD1Migrations("DB");
  const env = (await worker.getEnv()) as unknown as { DB: D1Like };
  const db = adaptD1(env.DB);

  await seedSyntheticWorkspace(db, T0, "global");
  await seedHuman(db, "v02-user", SESSION, SESSION_TOKEN, FIX.owner, "owner@synthetic.test");
  await seedHuman(db, "v02-member-user", MEMBER_SESSION, MEMBER_TOKEN, FIX.member, "member@synthetic.test");
  await seedHuman(
    db,
    "v02-reviewer-user",
    REVIEWER_SESSION,
    REVIEWER_TOKEN,
    FIX.restricted,
    "restricted@synthetic.test",
  );

  // Publish one hostile version per format through the real route flow.
  const versions = {
    html: await publish(0, "html", HTML_HOSTILE),
    svg: await publish(1, "svg", SVG_HOSTILE),
    markdown: await publish(0, "markdown", MD_HOSTILE),
    mermaid: await publish(1, "mermaid", MERMAID_HOSTILE),
    mermaidHuge: await publish(0, "mermaid", MERMAID_HUGE),
    json: await publish(1, "json", JSON_HOSTILE),
    diff: await publish(0, "diff", DIFF_HOSTILE),
    log: await publish(1, "log", LOG_TEXT),
    png: await publish(0, "png", PNG),
  };
  note("published", 9);

  // Bootstrap: fixed bytes, bootstrap policy, no oracle, no cookies.
  const bootstrapResponse = await bootstrap(syntheticUlid("V02BOOT"));
  assert.equal(bootstrapResponse.status, 200);
  const bootstrapBody = await bootstrapResponse.text();
  assert.equal(bootstrapBody, buildViewBootstrap());
  assert.equal(bootstrapResponse.headers.get("content-security-policy"), viewBootstrapCsp(ORIGIN));
  assert(!bootstrapResponse.headers.get("content-security-policy")?.includes("sandbox"));
  assert(bootstrapResponse.headers.get("content-security-policy")?.includes("form-action 'self'"));
  assert.equal(bootstrapResponse.headers.get("cache-control"), "private, no-store");
  assert.equal(bootstrapResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(bootstrapResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(bootstrapResponse.headers.get("set-cookie"), null);
  captureHeaders("bootstrap", bootstrapResponse);
  note("bootstrap_fixed");
  corpusRows.push({
    case: "Bootstrap served for unknown view ID",
    proof: "GET /view/:id returns byte-identical fixed document without bytes",
    result: "200, fixed bootstrap, no oracle",
  });
  const malformedBootstrap = await bootstrap("not-a-view");
  assert.equal(malformedBootstrap.status, 403);
  note("bootstrap_malformed_rejected");
  const cookied = await server.getWorker("bfb-v02-artifact").fetch(
    `${ARTIFACT_ORIGIN}/view/${syntheticUlid("V02COOK")}`,
    { headers: { cookie: "__Host-bfb_session=stolen", "x-v02-test-time": T0 } },
  );
  assert.equal(cookied.status, 400);
  note("artifact_cookie_rejected");

  // Redemption matrix: every format redeems under the exact final policy.
  const secrets: string[] = [];
  const nonces: string[] = [];
  async function redeemVersion(
    label: string,
    versionId: string,
    expectedType: string,
    check: (body: string) => void,
  ): Promise<void> {
    const grant = await createView(0, versionId);
    assert.match(grant.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.match(grant.nonce, /^[0-9a-f]{32}$/);
    assert(!("grant_hash" in grant), "grant hash must not leave the server");
    secrets.push(grant.secret);
    nonces.push(grant.nonce);
    const response = await redeem(grant.view_id, grant.secret, grant.nonce);
    assert.equal(response.status, 200, `${label}: ${await response.clone().text()}`);
    assert.equal(response.headers.get("content-type"), expectedType, label);
    expectFinalPolicy(response, label);
    captureHeaders(`redeem:${label}`, response);
    const body = await response.text();
    assert(!body.includes(grant.secret), `${label} leaks secret`);
    assert(!body.includes(grant.nonce), `${label} leaks nonce`);
    check(body);
    note("redeemed");
    corpusRows.push({
      case: `Redeem ${label}`,
      proof: "bounded POST with secret+nonce; exact version rechecked before bytes",
      result: `200 ${expectedType}, exact final CSP`,
    });
  }

  await redeemVersion("html", versions.html, "text/html; charset=utf-8", (body) => {
    assert(body.includes("top.location"), "hostile bytes served raw under sandbox+CSP");
  });
  await redeemVersion("svg", versions.svg, "image/svg+xml", (body) => {
    assert(body.includes("<script>"), "hostile SVG served raw under sandbox+CSP");
  });
  await redeemVersion("markdown", versions.markdown, "text/html; charset=utf-8", (body) => {
    assert(!body.includes("<script>"), "rendered markdown must not contain raw script");
    assert(body.includes("synthetic review"), "markdown heading rendered");
  });
  await redeemVersion("mermaid", versions.mermaid, "text/html; charset=utf-8", (body) => {
    assert(!body.includes("javascript:"), "active mermaid directives dropped");
    assert(body.includes("omitted"), "dropped lines disclosed");
  });
  await redeemVersion("mermaid-huge", versions.mermaidHuge, "text/html; charset=utf-8", (body) => {
    assert(/preview unavailable/i.test(body), "over-cap diagram falls back safely");
  });
  await redeemVersion("json", versions.json, "text/html; charset=utf-8", (body) => {
    assert(!body.includes("<script>"), "rendered JSON must not contain raw script");
  });
  await redeemVersion("diff", versions.diff, "text/html; charset=utf-8", (body) => {
    assert(!body.includes("<script>"), "rendered diff must not contain raw script");
  });
  await redeemVersion("log", versions.log, "text/html; charset=utf-8", (body) => {
    assert(body.includes("line one"), "log text rendered");
  });
  const pngGrant = await createView(1, versions.png, OWNER, "192.0.2.92");
  secrets.push(pngGrant.secret);
  nonces.push(pngGrant.nonce);
  const pngResponse = await redeem(pngGrant.view_id, pngGrant.secret, pngGrant.nonce, "192.0.2.92");
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get("content-type"), "image/png");
  expectFinalPolicy(pngResponse, "png");
  captureHeaders("redeem:png", pngResponse);
  assert.equal(new Uint8Array(await pngResponse.arrayBuffer()).byteLength, PNG.byteLength);
  note("redeemed");
  corpusRows.push({
    case: "Redeem png",
    proof: "bounded POST with secret+nonce; exact version rechecked before bytes",
    result: "200 image/png, exact final CSP",
  });

  // Reload mints a fresh grant; replay and credential abuse fail uniformly.
  const first = await createView(0, versions.html);
  secrets.push(first.secret);
  nonces.push(first.nonce);
  assert.equal((await redeem(first.view_id, first.secret, first.nonce)).status, 200);
  note("redeem_happy");
  await rejected(await redeem(first.view_id, first.secret, first.nonce));
  note("replay_rejected");
  const fresh = await createView(1, versions.html);
  secrets.push(fresh.secret);
  nonces.push(fresh.nonce);
  await rejected(await redeem(fresh.view_id, "wrong-secret-value-0123456789abcdef0123", fresh.nonce));
  note("wrong_secret_rejected");
  await rejected(await redeem(fresh.view_id, fresh.secret, "f".repeat(32)));
  note("wrong_nonce_rejected");
  await rejected(await redeem(syntheticUlid("V02NOGRT"), fresh.secret, fresh.nonce));
  note("unknown_view_rejected");
  await rejected(await redeem("not-a-view", fresh.secret, fresh.nonce));
  note("malformed_view_rejected");
  const oversized = await redeem(fresh.view_id, fresh.secret, fresh.nonce, "192.0.2.91", T0, `&pad=${"x".repeat(9000)}`);
  assert.equal(oversized.status, 413);
  note("oversize_rejected");
  corpusRows.push(
    { case: "Grant replay", proof: "same view redeemed twice", result: "403 uniform, one byte effect" },
    { case: "Wrong secret", proof: "valid view ID with unknown secret", result: "403 uniform, no effect" },
    { case: "Wrong nonce", proof: "valid secret with foreign channel nonce", result: "403 uniform, no effect" },
    { case: "Unknown view", proof: "random view ID with live secret", result: "403 uniform" },
    { case: "Oversized body", proof: "9 KiB redemption padding", result: "413 before bytes" },
  );

  // Expiry, revocation, reviewer previews, and non-available versions.
  const expiring = await createView(0, versions.html, OWNER, "192.0.2.93", T1);
  secrets.push(expiring.secret);
  nonces.push(expiring.nonce);
  assert.equal((await redeem(expiring.view_id, expiring.secret, expiring.nonce, "192.0.2.93", T1_LATE)).status, 403);
  note("expiry_rejected");
  const revoked = await createView(0, versions.html, OWNER, "192.0.2.93", T1);
  secrets.push(revoked.secret);
  nonces.push(revoked.nonce);
  await bumpMemberEpoch(db, FIX.workspace, FIX.owner);
  await rejected(await redeem(revoked.view_id, revoked.secret, revoked.nonce, "192.0.2.93", T1));
  note("revoked_redeem_rejected");
  const reviewerView = await createView(1, versions.html, REVIEWER, "192.0.2.93", T1);
  assert.equal(
    (await redeem(reviewerView.view_id, reviewerView.secret, reviewerView.nonce, "192.0.2.93", T1)).status,
    200,
  );
  note("reviewer_preview");
  const uploadingVersion = (await (
    await browser(0, "POST", `/api/v1/workspaces/${FIX.workspace}/artifacts`, {
      format: "markdown",
      role: "review",
      declared_size: LOG_TEXT.byteLength,
      expected_digest: digest(LOG_TEXT),
    }, OWNER, "192.0.2.93", T1)
  ).json()) as { version_id: string };
  const uploadingView = await browser(
    0,
    "POST",
    `/api/v1/workspaces/${FIX.workspace}/artifacts/${uploadingVersion.version_id}/views`,
    {},
    OWNER,
    "192.0.2.93",
    T1,
  );
  assert.equal(uploadingView.status, 403);
  note("uploading_version_rejected");
  corpusRows.push(
    { case: "Expired grant", proof: "redeem past 5-minute TTL", result: "403 before bytes" },
    { case: "Revoked epoch", proof: "membership epoch bumped after issuance", result: "403 before bytes" },
    { case: "Reviewer preview", proof: "reviewer role opens an available version", result: "200" },
    { case: "Uploading version", proof: "view grant for non-available version", result: "403" },
  );

  // R2 tampering fails closed without leaking the grant.
  const TAMPER_HTML = new TextEncoder().encode("<!doctype html><html><body><p>tamper</p></body></html>");
  const tamperVersion = await publish(0, "html", TAMPER_HTML, "192.0.2.94", T2);
  const tamperGrant = await createView(1, tamperVersion, OWNER, "192.0.2.94", T2);
  secrets.push(tamperGrant.secret);
  nonces.push(tamperGrant.nonce);
  const artifactEnv = (await server.getWorker("bfb-v02-artifact").getEnv()) as unknown as {
    ARTIFACTS: { put(key: string, value: Uint8Array): Promise<unknown> };
  };
  await artifactEnv.ARTIFACTS.put(
    `workspaces/${FIX.workspace}/artifacts/sha256/${digest(TAMPER_HTML)}`,
    new TextEncoder().encode("tampered bytes"),
  );
  const tampered = await redeem(tamperGrant.view_id, tamperGrant.secret, tamperGrant.nonce, "192.0.2.94", T2);
  assert.equal(tampered.status, 500);
  const tamperedBody = await tampered.text();
  assert(!tamperedBody.includes(tamperGrant.secret), "failure must not leak the grant");
  note("r2_tamper_rejected");
  corpusRows.push({
    case: "Tampered R2 bytes",
    proof: "object overwritten after finalize; hash re-verified before serving",
    result: "500 view_failed, no grant leak",
  });

  // Redemption budgets survive Worker-isolate changes; the 21st attempt fails closed.
  const budgetGrants: CreatedView[] = [];
  for (let index = 0; index < 21; index += 1) {
    budgetGrants.push(
      await createView(index, versions.html, index < 11 ? OWNER : MEMBER, `192.0.2.${128 + index}`, T3),
    );
  }
  const budgetStatuses: number[] = [];
  for (const candidate of budgetGrants) {
    const response = await redeem(candidate.view_id, candidate.secret, candidate.nonce, "192.0.2.94", T3);
    budgetStatuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(budgetStatuses.slice(0, 20), Array.from({ length: 20 }, () => 200));
  assert.equal(budgetStatuses[20], 403);
  note("budget_exhausted");
  const spared = budgetGrants[20]!;
  secrets.push(spared.secret);
  nonces.push(spared.nonce);
  const sparedResponse = await redeem(spared.view_id, spared.secret, spared.nonce, "192.0.2.95", T3);
  assert.equal(sparedResponse.status, 200);
  note("budget_isolated_by_ip");
  corpusRows.push({
    case: "Redemption budget across isolates",
    proof: "21 redeems from one pinned IP across alternating control isolates",
    result: "20 x 200 then 403; spared grant redeems from a fresh IP",
  });

  // Capability scan: no secret, nonce, or local path survives in D1 or R2 keys.
  const dump = JSON.stringify({
    grants: await db.prepare(`SELECT * FROM artifact_view_grants`).all(),
    versions: await db.prepare(`SELECT * FROM artifact_versions`).all(),
    audit: await db.prepare(`SELECT payload_json FROM artifact_audit_outbox`).all(),
    events: await db.prepare(`SELECT payload_json FROM semantic_events`).all(),
    idempotency: await db.prepare(`SELECT result_json FROM idempotency_records`).all(),
    buckets: await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all(),
  });
  for (const secret of secrets) {
    assert(!dump.includes(secret), "view secret retained outside its hashed grant");
  }
  for (const nonce of nonces) {
    assert(!dump.includes(nonce), "channel nonce retained outside its hash");
  }
  assert(!dump.includes("/tmp/") && !dump.includes("/Users/"), "local path retained in diagnostics");
  const buckets = (await db.prepare(`SELECT bucket_key FROM rate_limit_buckets`).all()) as Array<{
    bucket_key: string;
  }>;
  assert(buckets.length > 0, "abuse budgets never persisted");
  for (const bucket of buckets) assert.match(bucket.bucket_key, /^[0-9a-f]{64}$/);
  note("scan_clean");

  const evidenceDir = process.env.BFB_V02_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), "bfb-v02-"));
  const corpusReport = [
    "# WP-V02 hostile corpus report",
    "",
    "Every row was proven against real Workers, D1, and disposable R2",
    "(`tools/artifact-viewer/run.ts`, `V02_D1_OK`). Browser sandbox and CSP",
    "claims are proven separately by `apps/web/test/e2e/v02-viewer.spec.ts`.",
    "",
    "| Case | Proof | Result |",
    "| --- | --- | --- |",
    ...corpusRows.map((row) => `| ${row.case} | ${row.proof} | ${row.result} |`),
    "",
  ].join("\n");
  writeFileSync(join(evidenceDir, "hostile-corpus.md"), corpusReport);
  writeFileSync(join(evidenceDir, "headers.json"), JSON.stringify(headerCaptures, null, 2));
  console.log(`[v02] evidence: ${evidenceDir}`);

  console.log(JSON.stringify({ ...outcomes, evidenceDir }));
  console.log("V02_D1_OK");
} finally {
  await server.close();
}
