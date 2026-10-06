// ABOUTME: Exercises shared-only GitHub evidence through mounted browser sessions and CSRF writes.
// ABOUTME: Historical task associations and recipient interleaves never use injected browser authority.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  createTaskCommand,
  linkGitHubEvidenceCommand,
  randomUlid,
  seedSyntheticWorkspace,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { success } from "../../../packages/domain/test/launch-fixture.js";
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

const NOW = "2026-10-06T12:00:00.000Z",
  ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/github/evidence`;
const CANARY = "SYNTHETIC_GITHUB_HTTP_REF";
const contexts: AuthTestContext[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  contexts.splice(0).forEach((context) => context.raw.close());
  vi.useRealTimers();
});
async function fixture() {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  await seedSyntheticWorkspace(context.db, NOW);
  const db = context.db,
    hub = new WorkspaceHub(db);
  const task = success(
    await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title: "Synthetic HTTP evidence task", priority: "P2" },
    }),
  );
  const bindings = {
    DB: {},
    ARTIFACTS: {},
    ASSETS: {},
    JOBS: {},
    JOBS_DLQ: {},
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(db),
    APP_ORIGIN: ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  } as unknown as ControlBindings;
  const app = (database = db) =>
    createControlApp(validateControlEnv(bindings), {
      db: database,
      now: NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
  const actors = {} as Record<"owner" | "member" | "reviewer", { cookie: string; csrf: string }>;
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.restricted],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `private-gh-${actor}-user`,
      sessionId: `private-gh-${actor}-session`,
      token: `private-gh-${actor}-token`,
      humanId,
      email: `${actor}@synthetic.test`,
      now: NOW,
    });
    const response = await app().request(
      new Request(`${ORIGIN}/auth/session`, { headers: { cookie: session.cookie } }),
      undefined,
      bindings,
    );
    expect(response.status).toBe(200);
    actors[actor] = {
      cookie: session.cookie,
      csrf: ((await response.json()) as { csrf_token: string }).csrf_token,
    };
  }
  const request = (
    path = BASE,
    actor: keyof typeof actors = "owner",
    body?: Record<string, unknown>,
    database = db,
  ) =>
    app(database).request(
      new Request(ORIGIN + path, {
        method: body ? "POST" : "GET",
        headers: {
          cookie: actors[actor].cookie,
          ...(body
            ? {
                origin: ORIGIN,
                "sec-fetch-site": "same-origin",
                "x-bfb-csrf": actors[actor].csrf,
                "content-type": "application/json",
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      undefined,
      bindings,
    );
  const input = {
    projectId: FIX.projectA,
    taskId: task.id,
    repositoryId: "1234",
    kind: "commit" as const,
    ref: CANARY,
    versionToken: "synthetic-v1",
    state: {},
    observedBy: "runner" as const,
  };
  const link = (value = input) =>
    hub.execute(linkGitHubEvidenceCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: value,
    });
  const body = (taskId: string | undefined = task.id, requestId = randomUlid()) => ({
    request_id: requestId,
    project_id: FIX.projectA,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    repository_id: "1234",
    kind: "commit",
    ref: CANARY,
    version_token: "synthetic-v1",
    observed_by: "runner",
  });
  const privacy = () =>
    db
      .prepare(
        "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
      )
      .run(FIX.workspace, task.id, FIX.member, NOW);
  return { db, task, input, link, body, privacy, request };
}
function before(db: SqlDatabase, match: RegExp, change: () => Promise<void>): SqlDatabase {
  let fired = false;
  return {
    ...db,
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!match.test(sql)) return statement;
      const invoke = async () => {
        if (!fired) {
          fired = true;
          await change();
        }
      };
      return {
        ...statement,
        async get(...params) {
          await invoke();
          return statement.get(...params);
        },
        async all(...params) {
          await invoke();
          return statement.all(...params);
        },
      };
    },
  };
}

describe("mounted private GitHub evidence", () => {
  it.each(["parent", "epoch", "project"])(
    "does not return earlier verified provenance after a second-ref %s revoke",
    async (mode) => {
      const f = await fixture(),
        second = "composition-second-http";
      for (const [ref, taskId] of [
        [CANARY, f.task.id],
        [second, null],
      ] as const) {
        await f.db
          .prepare(
            `INSERT INTO github_evidence
          (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
          VALUES (?,?,?,?,'1234','commit',?,'synthetic-http-version','{}','github',?,1)`,
          )
          .run(FIX.workspace, randomUlid(), FIX.projectA, taskId, ref, NOW);
      }
      const body = {
        refs: [CANARY, second].map((ref) => ({
          kind: "github",
          ref: `github:1234:commit:${ref}`,
          version: "synthetic-http-version",
        })),
      };
      const shared = await f.request(BASE + "/verification", "owner", body);
      expect(shared.status).toBe(200);
      expect(
        ((await shared.json()) as { statuses: Array<{ provenance: string }> }).statuses.map(
          (row) => row.provenance,
        ),
      ).toEqual(["github_verified", "github_verified"]);
      let changed = false,
        reads = 0;
      const db: SqlDatabase = {
        ...f.db,
        prepare(sql) {
          const statement = f.db.prepare(sql);
          if (!/FROM github_evidence/.test(sql)) return statement;
          return {
            ...statement,
            async all(...parameters) {
              reads++;
              if (
                !changed &&
                parameters.some((value) => typeof value === "string" && value.includes(second))
              ) {
                changed = true;
                if (mode === "parent") await f.privacy();
                else if (mode === "epoch") {
                  await f.db
                    .prepare(
                      "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
                    )
                    .run(FIX.owner);
                  await f.db
                    .prepare(
                      "UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?",
                    )
                    .run(FIX.owner);
                } else {
                  await f.db
                    .prepare("UPDATE projects SET access_mode = 'restricted' WHERE id = ?")
                    .run(FIX.projectA);
                  await f.db
                    .prepare("DELETE FROM project_access WHERE project_id = ? AND human_id = ?")
                    .run(FIX.projectA, FIX.owner);
                }
              }
              return statement.all(...parameters);
            },
          };
        },
      };
      const response = await f.request(BASE + "/verification", "owner", body, db);
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { statuses: Array<{ provenance: string }> }).statuses.map(
          (row) => row.provenance,
        ),
      ).toEqual(
        mode === "parent" ? ["unverified", "github_verified"] : ["unverified", "unverified"],
      );
      expect(changed).toBe(true);
      expect(reads).toBe(1);
    },
  );
  it.each(["owner", "member"] as const)(
    "denies explicit private and missing task identically for %s",
    async (actor) => {
      const f = await fixture();
      await f.privacy();
      const hidden = await f.request(BASE + "/links", actor, f.body());
      const missing = await f.request(BASE + "/links", actor, f.body(randomUlid()));
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await hidden.json()).toEqual(await missing.json());
      expect(await f.db.prepare("SELECT id FROM github_evidence").all()).toEqual([]);
    },
  );
  it("keeps shared links and their unchanged retry working", async () => {
    const f = await fixture(),
      body = f.body();
    const first = await f.request(BASE + "/links", "member", body),
      retry = await f.request(BASE + "/links", "member", body);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    const page = await f.request();
    expect(page.status).toBe(200);
    expect(((await page.json()) as { evidence: unknown[] }).evidence).toHaveLength(1);
  });
  it("fences omitted-task updates and cached replies against retained private lineage", async () => {
    const f = await fixture();
    const body = f.body();
    delete (body as { task_id?: string }).task_id;
    expect((await f.request(BASE + "/links", "member", body)).status).toBe(200);
    const row = success(await f.link());
    await f.privacy();
    expect((await f.request(BASE + "/links", "member", body)).status).toBe(404);
    expect(
      (await f.request(BASE + "/links", "member", { ...body, request_id: randomUlid() })).status,
    ).toBe(404);
    expect(
      await f.db
        .prepare("SELECT task_id,resource_version FROM github_evidence WHERE id = ?")
        .get(row.id),
    ).toEqual({ task_id: f.task.id, resource_version: 2 });
  });
  it("excludes private rows before HTTP pagination and verification", async () => {
    const f = await fixture();
    success(await f.link({ ...f.input, taskId: undefined, ref: "public-http-ref" }));
    success(await f.link());
    await f.privacy();
    await f.db
      .prepare(
        "UPDATE github_evidence SET observed_at = '2026-10-06T13:00:00.000Z' WHERE task_id IS NOT NULL",
      )
      .run();
    const page = await f.request(BASE + "?limit=1");
    expect(page.status).toBe(200);
    expect(
      ((await page.json()) as { evidence: Array<{ ref: string }> }).evidence.map((row) => row.ref),
    ).toEqual(["public-http-ref"]);
    const verification = await f.request(BASE + "/verification", "owner", {
      refs: [{ kind: "github", ref: `github:1234:commit:${CANARY}` }],
    });
    expect(verification.status).toBe(200);
    expect(await verification.text()).toContain('"provenance":"unverified"');
  });
  it.each(["owner", "member", "reviewer"] as const)(
    "applies current project scope to every role, including %s",
    async (actor) => {
      const f = await fixture();
      success(await f.link({ ...f.input, taskId: undefined }));
      await f.db
        .prepare("UPDATE projects SET access_mode = 'restricted' WHERE workspace_id = ? AND id = ?")
        .run(FIX.workspace, FIX.projectA);
      await f.db
        .prepare("DELETE FROM project_access WHERE workspace_id = ? AND project_id = ?")
        .run(FIX.workspace, FIX.projectA);
      const page = await f.request(
        actor === "reviewer" ? BASE + `?project_id=${FIX.projectA}` : BASE,
        actor,
      );
      if (actor === "reviewer") expect(page.status).toBe(403);
      else {
        expect(page.status).toBe(200);
        expect(await page.json()).toMatchObject({ evidence: [] });
      }
      const response = await f.request(BASE + "/verification", actor, {
        ...(actor === "reviewer" ? { project_id: FIX.projectA } : {}),
        refs: [{ kind: "github", ref: `github:1234:commit:${CANARY}` }],
      });
      if (actor === "reviewer") expect(response.status).toBe(403);
      else expect(await response.text()).toContain('"provenance":"unverified"');
    },
  );
  it("rejects a recipient epoch changed between authenticated route and evidence selection", async () => {
    const f = await fixture();
    success(await f.link());
    const db = before(f.db, /FROM github_evidence/, async () => {
      await f.db
        .prepare(
          "UPDATE workspace_authorization_epochs SET authorization_epoch = 2 WHERE human_id = ?",
        )
        .run(FIX.owner);
      await f.db
        .prepare("UPDATE workspace_members SET authorization_epoch = 2 WHERE human_id = ?")
        .run(FIX.owner);
    });
    const response = await f.request(BASE, "owner", undefined, db);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ evidence: [] });
  });
});
