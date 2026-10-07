// ABOUTME: Proves the manual GitHub linking hold through genuine mounted browser sessions and Hub commands.
// ABOUTME: Historical evidence and cache fixtures retain useful reads without permitting manual linking effects.

import type { SqlDatabase } from "@bfb/db";
import {
  FIX,
  WorkspaceHub,
  bumpMemberEpoch,
  createTaskCommand,
  linkGitHubEvidenceCommand,
  randomUlid,
  seedSyntheticWorkspace,
  type GitHubEvidenceRecord,
  type LinkGitHubEvidenceInput,
} from "@bfb/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const NOW = "2026-10-08T12:00:00.000Z";
const ORIGIN = AUTH_TEST_ENV.APP_ORIGIN;
const BASE = `/api/v1/workspaces/${FIX.workspace}/github/evidence`;
const UNAVAILABLE = {
  error: "request_rejected",
  message: "manual GitHub evidence linking is unavailable",
};
const OBSERVERS = ["human", "runner"] as const;
const KEYS = ["absent", "visible", "hidden"] as const;
type Observer = (typeof OBSERVERS)[number];
type Key = (typeof KEYS)[number];
type Actor = "owner" | "member" | "reviewer";
const contexts: AuthTestContext[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function canonicalSnapshot(db: SqlDatabase) {
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  const snapshot: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    // HTTP abuse accounting is expected, but no business or auth-session table is omitted.
    if (["sqlite_sequence", "d1_migrations", "rate_limit_buckets"].includes(name)) continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    snapshot[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return snapshot;
}

async function foreignKeys(db: SqlDatabase) {
  expect(await db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

async function noBusinessEffects(db: SqlDatabase, requests: () => Promise<void>) {
  await foreignKeys(db);
  const before = await canonicalSnapshot(db);
  await requests();
  expect.soft(await canonicalSnapshot(db)).toEqual(before);
  await foreignKeys(db);
}

async function unavailable(response: Response) {
  expect.soft(response.status).toBe(409);
  expect.soft(response.headers.get("cache-control")).toBe("no-store");
  expect.soft(await response.json()).toEqual(UNAVAILABLE);
}

async function fixture() {
  const context = openAuthTestContext(NOW);
  contexts.push(context);
  const db = context.db;
  await seedSyntheticWorkspace(db, NOW);
  const hub = new WorkspaceHub(db);
  const tasks = [];
  for (const title of ["Synthetic shared GitHub history", "Synthetic private GitHub history"]) {
    const outcome = await hub.execute(createTaskCommand, {
      workspaceId: FIX.workspace,
      actorHumanId: FIX.member,
      authorizationEpoch: 1,
      idempotencyKey: randomUlid(),
      input: { projectId: FIX.projectA, title, priority: "P2" },
    });
    if (!outcome.ok) throw new Error("synthetic task setup failed");
    tasks.push(outcome.result);
  }
  const [shared, privateTask] = tasks;
  if (!shared || !privateTask) throw new Error("synthetic task setup incomplete");
  await db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, privateTask.id, FIX.member, NOW);

  const actors = {} as Record<Actor, { cookie: string; csrf: string }>;
  const mounted = (database = db) => {
    const bindings = {
      DB: {},
      ARTIFACTS: {},
      ASSETS: {},
      JOBS: {},
      JOBS_DLQ: {},
      WORKSPACE_HUB: createTestWorkspaceHubNamespace(database),
      APP_ORIGIN: ORIGIN,
      ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
      LAUNCH_ORIGIN: "https://launch.bfb.example.test",
      JURISDICTION: "eu",
      ENVIRONMENT: "local",
    } as unknown as ControlBindings;
    const app = createControlApp(validateControlEnv(bindings), {
      db: database,
      now: NOW,
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      humanAuth: () => ({
        auth: context.auth,
        keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
        abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
      }),
    });
    return { app, bindings };
  };
  for (const [actor, humanId] of [
    ["owner", FIX.owner],
    ["member", FIX.member],
    ["reviewer", FIX.reviewer],
  ] as const) {
    const session = await seedAuthSession(context, {
      userId: `manual-hold-${actor}-user`,
      sessionId: `manual-hold-${actor}-session`,
      token: `manual-hold-${actor}-token`,
      email: `${actor}@synthetic.test`,
      humanId,
      now: NOW,
    });
    const { app, bindings } = mounted();
    const response = await app.request(
      new Request(ORIGIN + "/auth/session", { headers: { cookie: session.cookie } }),
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
    suffix: string,
    body?: unknown,
    actor: Actor = "member",
    database = db,
    headers: Record<string, string> = {},
  ) => {
    const { app, bindings } = mounted(database);
    return app.request(
      new Request(ORIGIN + BASE + suffix, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: actors[actor].cookie,
          ...(body === undefined
            ? {}
            : {
                origin: ORIGIN,
                "sec-fetch-site": "same-origin",
                "x-bfb-csrf": actors[actor].csrf,
                "content-type": "application/json",
              }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      undefined,
      bindings,
    );
  };

  // Retained historical fixtures only: no setup invokes the held manual-link command.
  const history = new Map<string, GitHubEvidenceRecord>();
  const seedHistory = async (
    ref: string,
    taskId: string | null,
    observedBy: "github" | Observer,
    observedAt = NOW,
  ) => {
    const row: GitHubEvidenceRecord = {
      id: randomUlid(),
      workspace_id: FIX.workspace,
      project_id: FIX.projectA,
      task_id: taskId,
      repository_id: "1234",
      kind: "commit",
      ref,
      version_token: "synthetic-history-v1",
      state: { status: "synthetic historical observation" },
      observed_by: observedBy,
      observed_at: observedAt,
      resource_version: 3,
    };
    await db
      .prepare(
        `INSERT INTO github_evidence
         (workspace_id,id,project_id,task_id,repository_id,kind,ref,version_token,state_json,observed_by,observed_at,resource_version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.workspace_id,
        row.id,
        row.project_id,
        row.task_id,
        row.repository_id,
        row.kind,
        row.ref,
        row.version_token,
        JSON.stringify(row.state),
        row.observed_by,
        row.observed_at,
        row.resource_version,
      );
    return row;
  };
  for (const key of ["visible", "hidden"] as const) {
    for (const observer of OBSERVERS) {
      const row = await seedHistory(
        `synthetic-${key}-manual-key`,
        key === "hidden" ? privateTask.id : shared.id,
        observer,
        key === "hidden" ? NOW : "2026-10-08T11:58:00.000Z",
      );
      history.set(`${key}:${observer}`, row);
    }
  }
  const publicRef = "synthetic-independent-public-observation";
  const verified = await seedHistory(publicRef, null, "github", "2026-10-08T11:59:00.000Z");
  // A private association cannot hide the independent public observation of this reference.
  await seedHistory(publicRef, privateTask.id, "human");
  const body = (
    key: Key = "absent",
    observedBy: Observer = "human",
    taskId?: string,
    requestId = randomUlid(),
  ) => ({
    request_id: requestId,
    project_id: FIX.projectA,
    ...(taskId === undefined ? {} : { task_id: taskId }),
    repository_id: "1234",
    kind: "commit",
    ref: `synthetic-${key}-manual-key`,
    version_token: "synthetic-history-v1",
    state: { status: "synthetic historical observation" },
    observed_by: observedBy,
  });
  return { context, db, request, shared, privateTask, history, verified, publicRef, body };
}

function observeQueries(db: SqlDatabase, queries: string[]): SqlDatabase {
  return {
    prepare(sql) {
      queries.push(sql);
      return db.prepare(sql);
    },
    withTransaction(work) {
      return db.withTransaction((tx) => work(observeQueries(tx, queries)));
    },
  };
}

describe("mounted beta manual GitHub linking hold", () => {
  it.each(KEYS.flatMap((key) => OBSERVERS.map((observer) => ({ key, observer }))))(
    "holds $observer links for $key keys and every valid task association without business effects",
    async ({ key, observer }) => {
      const f = await fixture();
      await noBusinessEffects(f.db, async () => {
        for (const taskId of [undefined, f.shared.id, f.privateTask.id, randomUlid()]) {
          await unavailable(
            await f.request(
              "/links",
              f.body(key, observer, taskId),
              observer === "human" ? "member" : "owner",
            ),
          );
        }
      });
      expect(
        (await f.db.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get()) as {
          count: number;
        },
      ).toMatchObject({ count: expect.any(Number) });
      const buckets = (await f.db.prepare("SELECT count FROM rate_limit_buckets").all()) as {
        count: number;
      }[];
      expect(buckets.some((row) => row.count > 0)).toBe(true);
    },
  );

  it.each(["visible", "hidden"] as const)(
    "holds retained %s caches, changed-input retries and fresh keys without rewriting history",
    async (key) => {
      const f = await fixture();
      const requests = [];
      for (const observer of OBSERVERS) {
        const row = f.history.get(`${key}:${observer}`)!;
        const body = f.body(key, observer, row.task_id!, randomUlid());
        const input: LinkGitHubEvidenceInput = {
          projectId: body.project_id,
          taskId: body.task_id,
          repositoryId: body.repository_id,
          kind: "commit",
          ref: body.ref,
          versionToken: body.version_token,
          state: body.state,
          observedBy: observer,
        };
        const cursor = (await f.db
          .prepare("SELECT cursor FROM workspace_cursors WHERE workspace_id=?")
          .get(FIX.workspace)) as { cursor: number };
        // Synthetic retained pre-hold Hub cache; its original identity and fingerprint are exact.
        await f.db
          .prepare(
            `INSERT INTO idempotency_records
             (workspace_id,idempotency_key,command_name,result_json,created_at) VALUES (?,?,?,?,?)`,
          )
          .run(
            FIX.workspace,
            `github.${body.request_id}`,
            "github.evidence.link",
            JSON.stringify({
              result: row,
              cursor: cursor.cursor,
              authorizationEpoch: 1,
              actorHumanId: FIX.member,
              inputFingerprint: linkGitHubEvidenceCommand.inputFingerprint!(input),
            }),
            NOW,
          );
        requests.push(body);
      }
      await noBusinessEffects(f.db, async () => {
        for (const body of requests) {
          await unavailable(await f.request("/links", body));
          await unavailable(
            await f.request("/links", { ...body, version_token: "synthetic-changed-retry" }),
          );
          await unavailable(await f.request("/links", { ...body, request_id: randomUlid() }));
        }
      });
    },
  );

  it("denies before task, evidence or idempotency selection in the registered Hub command", async () => {
    const f = await fixture();
    const queries: string[] = [];
    const db = observeQueries(f.db, queries);
    await noBusinessEffects(f.db, async () => {
      await unavailable(
        await f.request("/links", f.body("visible", "human", f.shared.id), "member", db),
      );
      await unavailable(await f.request("/links", f.body("hidden", "runner"), "member", db));
    });
    expect(queries.some((sql) => /FROM workspace_members AS membership/.test(sql))).toBe(true);
    expect(
      queries.filter((sql) =>
        /\b(?:FROM|JOIN)\s+(?:tasks|github_evidence|idempotency_records)\b/i.test(sql),
      ),
    ).toEqual([]);
  });

  it("retains pure malformed closed-shape and bounded-field admission", async () => {
    const f = await fixture();
    const body = f.body();
    const malformed = [
      { ...body, unknown_field: true },
      { ...body, request_id: "" },
      { ...body, task_id: "not-a-task-id" },
      { ...body, repository_id: "not-numeric" },
      { ...body, kind: "unknown_kind" },
      { ...body, ref: "" },
      { ...body, ref: "x".repeat(513) },
      { ...body, version_token: "x".repeat(129) },
      { ...body, observed_by: "github" },
      { ...body, state: [] },
      { ...body, state: { status: 123 } },
    ];
    await noBusinessEffects(f.db, async () => {
      for (const value of malformed) expect((await f.request("/links", value)).status).toBe(400);
    });
  });

  it("retains actual cookie, CSRF, Reviewer and project admission", async () => {
    const f = await fixture();
    await f.db
      .prepare("DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?")
      .run(FIX.workspace, FIX.projectB, FIX.member);
    await noBusinessEffects(f.db, async () => {
      expect((await f.request("/links", f.body(), "member", f.db, { cookie: "" })).status).toBe(
        401,
      );
      expect(
        (await f.request("/links", f.body(), "member", f.db, { "x-bfb-csrf": "" })).status,
      ).toBe(403);
      expect((await f.request("/links", f.body(), "reviewer")).status).toBe(403);
      expect((await f.request("/links", { ...f.body(), project_id: FIX.projectB })).status).toBe(
        403,
      );
    });
    await f.db
      .prepare(
        "UPDATE workspace_authorization_epochs SET revoked_at=? WHERE workspace_id=? AND human_id=?",
      )
      .run(NOW, FIX.workspace, FIX.member);
    await noBusinessEffects(f.db, async () => {
      expect((await f.request("/links", f.body())).status).toBe(403);
    });
  });

  it("preserves useful history, independent public provenance and private omission before limits", async () => {
    const f = await fixture();
    await noBusinessEffects(f.db, async () => {
      for (const actor of ["owner", "member", "reviewer"] as const) {
        const project = actor === "reviewer" ? `&project_id=${FIX.projectA}` : "";
        const response = await f.request(`?limit=1${project}`, undefined, actor);
        expect(response.status).toBe(200);
        const page = (await response.json()) as { evidence: GitHubEvidenceRecord[] };
        expect(page.evidence).toEqual([f.verified]);
        const verification = await f.request(
          "/verification",
          {
            ...(actor === "reviewer" ? { project_id: FIX.projectA } : {}),
            refs: [
              {
                kind: "github",
                ref: `github:1234:commit:${f.publicRef}`,
                version: "synthetic-history-v1",
              },
              { kind: "github", ref: "github:1234:commit:synthetic-hidden-manual-key" },
              { kind: "github", ref: "github:1234:commit:synthetic-visible-manual-key" },
              { kind: "external", ref: "synthetic-opaque-reference" },
            ],
          },
          actor,
        );
        expect(verification.status).toBe(200);
        expect(
          ((await verification.json()) as { statuses: Array<{ provenance: string }> }).statuses.map(
            (row) => row.provenance,
          ),
        ).toEqual(["github_verified", "unverified", "runner_observed", "opaque"]);
      }
    });
  });

  it.each(["epoch", "project"] as const)(
    "keeps the captured %s ceiling in the current evidence selection",
    async (loss) => {
      // Separate requests/fixtures prove both actual final selectors rather than reloading a lost epoch.
      for (const operation of ["list", "verification"] as const) {
        const f = await fixture();
        let fired = false;
        let afterLoss: Awaited<ReturnType<typeof canonicalSnapshot>> | undefined;
        const db: SqlDatabase = {
          ...f.db,
          prepare(sql) {
            const statement = f.db.prepare(sql);
            if (!/FROM github_evidence\b/.test(sql)) return statement;
            return {
              ...statement,
              async all(...parameters) {
                expect(fired).toBe(false);
                fired = true;
                if (loss === "epoch") {
                  expect(await bumpMemberEpoch(f.db, FIX.workspace, FIX.member)).toBe(2);
                } else {
                  expect(
                    (
                      await f.db
                        .prepare(
                          "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
                        )
                        .run(FIX.workspace, FIX.projectA, FIX.member)
                    ).changes,
                  ).toBe(1);
                }
                afterLoss = await canonicalSnapshot(f.db);
                return statement.all(...parameters);
              },
            };
          },
        };
        const response =
          operation === "list"
            ? await f.request("", undefined, "member", db)
            : await f.request(
                "/verification",
                { refs: [{ kind: "github", ref: `github:1234:commit:${f.publicRef}` }] },
                "member",
                db,
              );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const body = await response.json();
        expect(body).toEqual(
          operation === "list"
            ? { ok: true, evidence: [] }
            : {
                ok: true,
                statuses: [
                  {
                    kind: "github",
                    ref: `github:1234:commit:${f.publicRef}`,
                    provenance: "unverified",
                  },
                ],
              },
        );
        expect(fired).toBe(true);
        expect(afterLoss).toBeDefined();
        expect(await canonicalSnapshot(f.db)).toEqual(afterLoss);
        await foreignKeys(f.db);
      }
    },
  );

  it("keeps existing HTTP abuse admission separate from the manual hold and business state", async () => {
    const f = await fixture();
    await unavailable(await f.request("/links", f.body()));
    const buckets = (await f.db
      .prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets")
      .get()) as { count: number };
    expect(buckets.count).toBeGreaterThan(0);
    await f.db.prepare("UPDATE rate_limit_buckets SET count=100").run();
    await noBusinessEffects(f.db, async () => {
      const response = await f.request("/links", f.body());
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: "request_rejected",
        message: "request rejected",
      });
    });
  });
});
