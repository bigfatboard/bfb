// ABOUTME: Proves original public credentials and post-Hub delivery through mounted browser and device-authenticated CLI routes.
// ABOUTME: Independent revocation snapshots separate denied admission from committed work whose reply is withheld.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createArtifactCommand,
  createProjectCommand,
  FIX,
  randomUlid,
  requestAttentionCommand,
  revokeBindingCommand,
} from "@bfb/domain";
import { captureFixture } from "../../../packages/domain/test/agent-capture-fixture.js";
import { LAUNCH_NOW, success } from "../../../packages/domain/test/launch-fixture.js";
import { parseAuthKeys } from "../src/auth/better-auth.js";
import { validateControlEnv, type ControlBindings } from "../src/env.js";
import { createTestWorkspaceHubNamespace } from "../src/hub-client.js";
import { createControlApp } from "../src/routes.js";
import {
  AUTH_TEST_ENV,
  openAuthTestContext,
  seedAuthSession,
  type AuthTestContext,
} from "./auth-helpers.js";

const origin = AUTH_TEST_ENV.APP_ORIGIN,
  marker = "SYNTHETIC-PUBLIC-BUSINESS-ROUTE";
const contexts: AuthTestContext[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const context of contexts.splice(0)) context.raw.close();
});

async function effects(db: SqlDatabase) {
  const result: Record<string, unknown[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as { name: string }[];
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/u);
    result[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return result;
}

async function fixture() {
  const now = new Date().toISOString(),
    context = openAuthTestContext(now);
  contexts.push(context);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
  const f = await captureFixture(context.db, false);
  const attention = success(
    await f.native(requestAttentionCommand, {
      principal: f.principal,
      request: { ...f.bound(), kind: "clarification", question: marker, blocking: false },
    }),
  );
  const artifact = success(
    await f.human(createArtifactCommand, {
      artifactId: null,
      runId: attention.run_id,
      format: "markdown",
      role: "review",
      declaredSize: 10,
      expectedDigest: "a".repeat(64),
      grantSecretHash: "b".repeat(64),
    }),
  );
  vi.useRealTimers();
  const session = await seedAuthSession(context, { humanId: FIX.owner, now });
  const base = createTestWorkspaceHubNamespace(f.db);
  let rpcCut: ((commandName: string, phase: "before" | "body") => Promise<void>) | undefined;
  const namespace = {
    ...base,
    jurisdiction() {
      return namespace as unknown as DurableObjectNamespace;
    },
    get(id: DurableObjectId) {
      const stub = base.get(id);
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const commandName = JSON.parse(String(init?.body)).commandName as string;
          await rpcCut?.(commandName, "before");
          const response = await stub.fetch(input, init);
          const json = response.json.bind(response);
          Object.defineProperty(response, "json", {
            value: async () => {
              const body = await json();
              await rpcCut?.(commandName, "body");
              return body;
            },
          });
          return response;
        },
      } as DurableObjectStub;
    },
  };
  const fake = <T extends object>(label: string) => ({ __synthetic: label }) as unknown as T;
  const bindings: ControlBindings = {
    DB: fake<D1Database>("db"),
    ARTIFACTS: fake<R2Bucket>("r2"),
    ASSETS: fake<Fetcher>("assets"),
    JOBS: fake<Queue>("jobs"),
    JOBS_DLQ: fake<Queue>("dlq"),
    WORKSPACE_HUB: namespace as unknown as DurableObjectNamespace,
    APP_ORIGIN: origin,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
  const app = createControlApp(validateControlEnv(bindings), {
    db: f.db,
    now,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  const request = (input: Request) => app.request(input, undefined, bindings);
  const auth = await request(
    new Request(`${origin}/auth/session`, { headers: { cookie: session.cookie } }),
  );
  expect(auth.status).toBe(200);
  const csrf = ((await auth.json()) as { csrf_token: string }).csrf_token;
  const browserHeaders = {
    cookie: session.cookie,
    origin,
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "x-bfb-csrf": csrf,
  };
  const issued = await request(
    new Request(`${origin}/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "bfb-cli" }),
    }),
  );
  expect(issued.status).toBe(200);
  const code = (await issued.json()) as { device_code: string; user_code: string };
  const approved = await request(
    new Request(`${origin}/api/v1/workspaces/${FIX.workspace}/cli/authorize`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({ user_code: code.user_code, project_ids: [FIX.projectA] }),
    }),
  );
  expect(approved.status).toBe(201);
  const bindingId = ((await approved.json()) as { binding: { binding_id: string } }).binding
    .binding_id;
  const exchanged = await request(
    new Request(`${origin}/api/v1/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "bfb-cli", device_code: code.device_code }),
    }),
  );
  expect(exchanged.status).toBe(200);
  const credential = ((await exchanged.json()) as { credential: string }).credential;
  const cli = (path: string, body?: unknown) =>
    request(
      new Request(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const revoke = async () => {
    success(await f.human(revokeBindingCommand, { bindingId }, now, FIX.owner));
  };
  return {
    ...f,
    now,
    context,
    attention,
    artifact,
    bindingId,
    credential,
    request,
    cli,
    browserHeaders,
    revoke,
    setRpcCut: (cut: typeof rpcCut) => {
      rpcCut = cut;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const reads = [
  "projects",
  "project",
  "tasks",
  "task",
  "runs",
  "run",
  "attention",
  "attention-detail",
  "artifacts",
  "artifact",
  "session",
] as const;
function readPath(f: Fixture, name: (typeof reads)[number]) {
  return `/api/v1/cli/${
    {
      projects: "projects",
      project: `projects/${FIX.projectA}`,
      tasks: "tasks",
      task: `tasks/${f.task.id}`,
      runs: `runs?task_id=${f.task.id}`,
      run: `runs/${f.attention.run_id}`,
      attention: "attention",
      "attention-detail": `attention/${f.attention.id}`,
      artifacts: `artifacts?run_id=${f.attention.run_id}`,
      artifact: `artifacts/${f.artifact.artifact_id}`,
      session: "session",
    }[name]
  }`;
}

function afterCredentialCapture(f: Fixture, change: () => Promise<void>) {
  const prepare = f.db.prepare.bind(f.db);
  let seen = false,
    baseline: Awaited<ReturnType<typeof effects>> | undefined;
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.includes("SELECT projects.id") || !sql.includes("project_access")) return statement;
    return {
      ...statement,
      all: async (...args: unknown[]) => {
        const rows = await statement.all(...args);
        if (!seen) {
          seen = true;
          await change();
          baseline = await effects(f.db);
        }
        return rows;
      },
    };
  });
  return { seen: () => seen, baseline: () => baseline };
}

describe("public business transport authority", () => {
  it.each(reads)(
    "CLI %s denies production revocation after credential project capture",
    async (name) => {
      const f = await fixture(),
        cut = afterCredentialCapture(f, f.revoke);
      const response = await f.cli(readPath(f, name)),
        body = await response.text();
      expect(cut.seen()).toBe(true);
      expect(await effects(f.db)).toEqual(cut.baseline());
      expect(response.status).not.toBe(200);
      expect(body).not.toContain(marker);
      expect(body).not.toContain(f.task.id);
    },
  );

  it.each(["fresh", "cached"] as const)(
    "CLI %s creation withholds a reply after the real Hub body await",
    async (mode) => {
      const f = await fixture(),
        body = { project_id: FIX.projectA, title: marker, request_id: randomUlid() };
      if (mode === "cached") expect((await f.cli("/api/v1/cli/tasks", body)).status).toBe(200);
      let seen = false,
        baseline: Awaited<ReturnType<typeof effects>> | undefined;
      f.setRpcCut(async (command, phase) => {
        if (command === "task.create" && phase === "body" && !seen) {
          seen = true;
          await f.revoke();
          baseline = await effects(f.db);
        }
      });
      const response = await f.cli("/api/v1/cli/tasks", body),
        text = await response.text();
      expect(seen).toBe(true);
      expect(await effects(f.db)).toEqual(baseline);
      expect(response.status).not.toBe(200);
      expect(text).not.toContain(marker);
      expect(
        await f.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE title=?").get(marker),
      ).toEqual({ count: 1 });
    },
  );

  it("CLI creation denies revocation before real Hub admission without command effects", async () => {
    const f = await fixture();
    let seen = false,
      baseline: Awaited<ReturnType<typeof effects>> | undefined;
    f.setRpcCut(async (command, phase) => {
      if (command === "task.create" && phase === "before" && !seen) {
        seen = true;
        await f.revoke();
        baseline = await effects(f.db);
      }
    });
    const response = await f.cli("/api/v1/cli/tasks", {
      project_id: FIX.projectA,
      title: marker,
      request_id: randomUlid(),
    });
    expect(seen).toBe(true);
    expect(response.status).not.toBe(200);
    expect(await effects(f.db)).toEqual(baseline);
  });

  it("browser task creation cannot adopt a genuine new project during its body await", async () => {
    const f = await fixture();
    let seen = false,
      projectId: string | undefined,
      baseline: Awaited<ReturnType<typeof effects>> | undefined;
    // Zero high-water means pull occurs only when the actual body reader asks
    // for bytes, after the route has captured its original principal.
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          expect(seen).toBe(false);
          seen = true;
          const project = success(
            await f.human(
              createProjectCommand,
              {
                name: "Synthetic added project",
                slug: "synthetic-added-project",
                tint: "#112233",
                accessMode: "workspace",
                repositoryHost: "github.com",
                hostedRepositoryId: "synthetic-added",
                repositorySubpath: ".",
              },
              f.now,
              FIX.owner,
            ),
          );
          projectId = project.id;
          baseline = await effects(f.db);
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ project_id: projectId, title: marker, request_id: randomUlid() }),
            ),
          );
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await f.request(
      new Request(`${origin}/api/v1/workspaces/${FIX.workspace}/tasks`, {
        method: "POST",
        headers: f.browserHeaders,
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(seen).toBe(true);
    expect(projectId).toBeDefined();
    expect(response.status).not.toBe(200);
    expect(await effects(f.db)).toEqual(baseline);
  });

  it("healthy CLI pages, historical retry and successful self-revoke remain usable", async () => {
    const f = await fixture();
    for (const name of reads) expect((await f.cli(readPath(f, name))).status, name).toBe(200);
    const body = { project_id: FIX.projectA, title: marker, request_id: randomUlid() };
    const original = await (await f.cli("/api/v1/cli/tasks", body)).json();
    const before = await effects(f.db),
      replayed = await (await f.cli("/api/v1/cli/tasks", body)).json();
    expect(replayed).toEqual({ ...original, replayed: true });
    expect(await effects(f.db)).toEqual(before);
    expect(JSON.stringify(await effects(f.db))).not.toContain("publicAuthority");
    const logout = await f.cli("/api/v1/cli/session/revoke", {});
    expect(logout.status).toBe(200);
    expect((await f.cli("/api/v1/cli/session")).status).not.toBe(200);
  });
});
