// ABOUTME: Connects the compiled production viewer to real local Workers, Hub, D1 and R2.
// ABOUTME: Synthetic browser sessions exercise credential boundaries without touching the enrolled pilot.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptD1, type D1Like, type SqlDatabase } from "@bfb/db";
import { FIX, isUlid, seedSyntheticWorkspace } from "@bfb/domain";
import { createTestHarness } from "wrangler";
import { v02Digest, v02ProbeScript } from "./e2e-fixture.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = "2026-09-17T12:00:00.000Z";
const SIGNING = "v02-runtime-synthetic-signing-key-55c1e7";
const SESSION = "v02-runtime-synthetic-session";
const TOKEN = "v02-runtime-synthetic-session-token";
const signed = `${TOKEN}.${createHmac("sha256", SIGNING).update(TOKEN).digest("base64")}`;
const COOKIE = `__Host-bfb_session=${encodeURIComponent(signed)}`;
const CSRF = `2.${createHmac("sha256", SIGNING).update(`bfb-csrf:${SESSION}`).digest("hex")}`;

export interface V02RuntimeFixture {
  appUrl: string;
  artUrl: string;
  db: SqlDatabase;
  versions: Record<string, { id: string; artifactId: string; hash: string }>;
  counts: {
    grants: number;
    redemptions: number;
    denied: number;
    artifactCookies: number;
    appHits: number;
  };
  browser(path: string, body: unknown): Promise<Response>;
  dispatchAudit(outboxId: string): Promise<Response>;
  publish(
    format: "html" | "markdown",
    text: string,
    binding?: { runId?: string; artifactId?: string },
  ): Promise<{ id: string; artifactId: string; hash: string }>;
  close(): Promise<void>;
}

async function incoming(request: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("cf-connecting-ip", "192.0.2.151");
  if (!headers.has("x-v02-test-time")) {
    headers.set("x-v02-test-time", new Date().toISOString());
  }
  const url = new URL(request.url ?? "/", origin);
  return new Request(url, {
    method: request.method ?? "GET",
    headers,
    ...(bytes.length ? { body: bytes as unknown as BodyInit } : {}),
  });
}

async function outgoing(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, key) => target.setHeader(key, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "::", resolve);
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startV02RuntimeFixture(
  appPort: number,
  artPort: number,
  options: { reviewEnabled?: boolean } = {},
): Promise<V02RuntimeFixture> {
  const appUrl = `http://bfb.localhost:${appPort}`;
  const artUrl = `http://artifacts.bfb.localhost:${artPort}`;
  const base = {
    compatibility_date: "2026-08-08",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_name: "bfb-v02-runtime-test",
        database_id: "00000000-0000-4000-8000-000000000126",
        migrations_dir: resolve(root, "migrations/d1"),
      },
    ],
  };
  const server = createTestHarness({
    root,
    workers: [
      {
        config: {
          ...base,
          name: "bfb-v02-runtime-control",
          main: resolve(root, "tools/artifact-viewer/control.ts"),
          vars: {
            ENVIRONMENT: "local",
            ARTIFACT_VIEWER_ENABLED: "true",
            ARTIFACT_REVIEW_ENABLED: String(options.reviewEnabled ?? false),
            JURISDICTION: "global",
            APP_ORIGIN: appUrl,
            ARTIFACT_ORIGIN: artUrl,
            LAUNCH_ORIGIN: `http://launch.bfb.localhost:${appPort}`,
            BETTER_AUTH_SECRETS: `2:${SIGNING},1:v02-runtime-previous-signing-key-9d22b0`,
            GITHUB_CLIENT_ID: "v02-runtime-synthetic-client",
            GITHUB_CLIENT_SECRET: "v02-runtime-synthetic-secret",
            AUTH_ABUSE_SECRET: "v02-runtime-synthetic-abuse-key-4c88e2abxx-long",
          },
          r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v02-runtime-artifacts" }],
          queues: {
            producers: [
              { binding: "JOBS", queue: "bfb-v02-runtime-jobs" },
              { binding: "JOBS_DLQ", queue: "bfb-v02-runtime-jobs-dlq" },
            ],
          },
          assets: { directory: resolve(root, "apps/web/dist/viewer-runtime"), binding: "ASSETS" },
          durable_objects: {
            bindings: [
              {
                name: "WORKSPACE_HUB",
                class_name: "WorkspaceHub",
                script_name: "bfb-v02-runtime-hub",
              },
            ],
          },
        },
      },
      {
        config: {
          ...base,
          name: "bfb-v02-runtime-hub",
          main: resolve(root, "apps/control-worker/src/index.ts"),
          durable_objects: { bindings: [{ name: "WORKSPACE_HUB", class_name: "WorkspaceHub" }] },
          exports: { WorkspaceHub: { type: "durable-object", storage: "sqlite" } },
        },
      },
      {
        config: {
          ...base,
          name: "bfb-v02-runtime-artifact",
          main: resolve(root, "tools/artifact-viewer/artifact.ts"),
          vars: {
            ENVIRONMENT: "local",
            ARTIFACT_VIEWER_ENABLED: "true",
            APP_ORIGIN: appUrl,
            ARTIFACT_ORIGIN: artUrl,
            UPLOAD_ABUSE_SECRET: "v02-runtime-upload-abuse-secret-8e13d2axx-long",
          },
          r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "bfb-v02-runtime-artifacts" }],
        },
      },
    ],
  });
  const counts = { grants: 0, redemptions: 0, denied: 0, artifactCookies: 0, appHits: 0 };
  const versions: V02RuntimeFixture["versions"] = {};
  const app = server.getWorker("bfb-v02-runtime-control");
  const artifact = server.getWorker("bfb-v02-runtime-artifact");
  async function forward(worker: typeof app, request: Request) {
    return worker.fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      ...(request.method !== "GET" && request.method !== "HEAD"
        ? { body: await request.text() }
        : {}),
    });
  }
  const appServer = createServer((req, res) => {
    void (async () => {
      try {
        const request = await incoming(req, appUrl);
        const url = new URL(request.url);
        if (url.pathname === "/__test/hit") counts.appHits++;
        const asset = /^\/assets\/([A-Za-z0-9_-]+\.(js|css))$/.exec(url.pathname);
        if (asset?.[1]) {
          res.setHeader(
            "content-type",
            asset[2] === "css"
              ? "text/css; charset=utf-8"
              : "application/javascript; charset=utf-8",
          );
          res.end(await readFile(join(root, "apps/web/dist/viewer-runtime/assets", asset[1])));
          return;
        }
        if (url.pathname === "/__test/component") {
          const format = url.searchParams.get("format") ?? "html";
          const version = versions[format];
          if (!version) throw new Error("Unknown synthetic format.");
          const viewerProps = {
            workspaceId: FIX.workspace,
            versionId: version.id,
            contentHash: version.hash,
            format,
            csrfToken: CSRF,
            artifactOrigin: artUrl,
          };
          const review = url.searchParams.get("panel") === "review";
          const taskId = url.searchParams.get("task_id");
          if (review && (!options.reviewEnabled || taskId === null || !isUlid(taskId))) {
            res.statusCode = 400;
            res.end();
            return;
          }
          const props = review
            ? { workspaceId: FIX.workspace, taskId, role: "owner", csrfToken: CSRF }
            : viewerProps;
          const html = await readFile(
            join(root, "apps/web/dist/viewer-runtime/index.html"),
            "utf8",
          );
          res.setHeader("content-type", "text/html; charset=utf-8");
          // This cookie authenticates only the disposable synthetic Better Auth session.
          res.setHeader("set-cookie", `${COOKIE}; Path=/; HttpOnly; Secure; SameSite=Lax`);
          res.end(
            html.replace(
              "</head>",
              `<script>window.${review ? "__v03Props" : "__v02Props"}=${JSON.stringify(props)};</script></head>`,
            ),
          );
          return;
        }
        const response = await forward(app, request);
        if (url.pathname.endsWith("/views")) {
          if (response.status === 201) counts.grants++;
          else counts.denied++;
        }
        await outgoing(response as unknown as Response, res);
      } catch {
        res.statusCode = 500;
        res.end();
      }
    })();
  });
  const artifactServer = createServer((req, res) => {
    void (async () => {
      try {
        const request = await incoming(req, artUrl);
        if (request.headers.has("cookie")) counts.artifactCookies++;
        const response = await forward(artifact, request);
        if (new URL(request.url).pathname.endsWith("/redeem")) {
          if (response.status === 200) counts.redemptions++;
          else counts.denied++;
        }
        await outgoing(response as unknown as Response, res);
      } catch {
        res.statusCode = 500;
        res.end();
      }
    })();
  });
  async function browser(path: string, body: unknown) {
    return app.fetch(appUrl + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appUrl,
        "sec-fetch-site": "same-origin",
        cookie: COOKIE,
        "x-bfb-csrf": CSRF,
        "cf-connecting-ip": "192.0.2.150",
        "x-v02-test-time": new Date().toISOString(),
      },
      body: JSON.stringify(body),
    }) as unknown as Promise<Response>;
  }
  async function publish(
    format: "html" | "markdown",
    text: string,
    binding: { runId?: string; artifactId?: string } = {},
  ) {
    const bytes = new TextEncoder().encode(text);
    const hash = v02Digest(bytes);
    const created = await browser(`/api/v1/workspaces/${FIX.workspace}/artifacts`, {
      format,
      role: "review",
      declared_size: bytes.length,
      expected_digest: hash,
      ...(binding.runId ? { run_id: binding.runId } : {}),
      ...(binding.artifactId ? { artifact_id: binding.artifactId } : {}),
    });
    assert.equal(created.status, 201, "Synthetic publication prepare failed.");
    const prepared = (await created.json()) as {
      artifact_id: string;
      version_id: string;
      upload_grant: { grant_id: string; secret: string };
    };
    const uploaded = await artifact.fetch(`${artUrl}/upload/${prepared.upload_grant.grant_id}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${prepared.upload_grant.secret}`,
        "cf-connecting-ip": "192.0.2.150",
        "x-v02-test-time": new Date().toISOString(),
      },
      body: bytes as unknown as never,
    });
    assert.equal(uploaded.status, 200, "Synthetic publication upload failed.");
    const finalized = await browser(
      `/api/v1/workspaces/${FIX.workspace}/artifacts/${prepared.version_id}/finalize`,
      { content_hash: hash, size: bytes.length },
    );
    assert.equal(finalized.status, 200, "Synthetic publication finalize failed.");
    return { id: prepared.version_id, artifactId: prepared.artifact_id, hash };
  }
  try {
    await server.listen();
    await app.applyD1Migrations("DB");
    const env = (await app.getEnv()) as unknown as { DB: D1Like };
    const db = adaptD1(env.DB);
    await seedSyntheticWorkspace(db, NOW, "global");
    const authUser = "v02-runtime-synthetic-user";
    await db
      .prepare(
        `INSERT INTO better_auth_users (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,1,?,?)`,
      )
      .run(authUser, "Synthetic viewer", "viewer@synthetic.test", NOW, NOW);
    await db.prepare(`UPDATE humans SET better_auth_user_id=? WHERE id=?`).run(authUser, FIX.owner);
    await db
      .prepare(
        `INSERT INTO better_auth_sessions (id,expires_at,token,created_at,updated_at,user_id) VALUES (?,?,?,?,?,?)`,
      )
      .run(SESSION, "2027-09-17T12:00:00.000Z", TOKEN, NOW, NOW, authUser);
    const texts = {
      html: `<!doctype html><html><body><h1>Synthetic isolated preview</h1><script>${v02ProbeScript(appUrl)}</script></body></html>`,
      markdown: "# Synthetic isolated plan\n\nThis content came through real D1 and R2.\n",
    };
    for (const format of ["html", "markdown"] as const) {
      versions[format] = await publish(format, texts[format]);
    }
    await listen(appServer, appPort);
    await listen(artifactServer, artPort);
    return {
      appUrl,
      artUrl,
      db,
      versions,
      counts,
      browser,
      publish,
      dispatchAudit(outboxId) {
        return app.fetch(`${appUrl}/__v02/audit/${outboxId}`, {
          method: "POST",
        }) as unknown as Promise<Response>;
      },
      async close() {
        await close(appServer);
        await close(artifactServer);
        await server.close();
      },
    };
  } catch (error) {
    await close(appServer);
    await close(artifactServer);
    await server.close();
    throw error;
  }
}
