// ABOUTME: Exercises human attention body and observation delivery through genuine browser and CLI credentials.
// ABOUTME: Final-selection permission and answer races must not return a stale private detail or create read effects.

import type { SqlDatabase } from "@bfb/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerAttentionCommand,
  bumpMemberEpoch,
  cliHash,
  FIX,
  mintCliKey,
  randomUlid,
  requestAttentionCommand,
  resolveAttentionCommand,
  transitionExecutionCommand,
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

const QUESTION = "SYNTHETIC-HUMAN-DETAIL-QUESTION";
const ANSWER = "SYNTHETIC-HUMAN-DETAIL-ANSWER";
const contexts: AuthTestContext[] = [];
type Transport = "browser" | "cli";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(LAUNCH_NOW));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) context.raw.close();
  vi.useRealTimers();
});

async function snapshot(db: SqlDatabase) {
  const business: Record<string, unknown[]> = {},
    authority: Record<string, unknown[]> = {};
  const tables = (await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()) as Array<{ name: string }>;
  for (const { name } of tables) {
    if (
      name.startsWith("sqlite_") ||
      name.startsWith("_cf_") ||
      ["d1_migrations", "rate_limit_buckets"].includes(name)
    )
      continue;
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/u);
    const group =
      name.startsWith("oauth_") ||
      name.startsWith("better_auth_") ||
      name === "preregistered_oauth_clients" ||
      [
        "workspace_members",
        "workspace_authorization_epochs",
        "project_access",
        "task_privacy",
        "task_human_grants",
      ].includes(name)
        ? authority
        : business;
    group[name] = await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return { business, authority };
}

async function fixture(
  options: {
    empty?: boolean;
    resolved?: boolean;
    viewer?: string;
    cliProjects?: readonly string[];
  } = {},
) {
  const viewer = options.viewer ?? FIX.reviewer;
  const context = openAuthTestContext(LAUNCH_NOW);
  contexts.push(context);
  const f = await captureFixture(context.db, false, false, {
    taskCreatorHumanId: FIX.member,
    requestingHumanId: FIX.owner,
  });
  let attention = success(
    await f.native(requestAttentionCommand, {
      principal: f.principal,
      request: { ...f.bound(), kind: "clarification", question: QUESTION, blocking: true },
    }),
  );
  if (options.empty) {
    // A synthetic historical attention row with no observation exists independently of immutable history.
    const id = randomUlid();
    await f.db
      .prepare(
        `INSERT INTO attention_requests
      (workspace_id,id,project_id,task_id,run_id,run_execution_id,assignment_generation,kind,required_role,reference_kind,reference_id,question,blocking,state,answer,answered_by_human_id,requested_at,first_response_at,answered_at,resolved_at,resource_version)
      SELECT workspace_id,?,project_id,task_id,run_id,run_execution_id,assignment_generation,kind,required_role,reference_kind,reference_id,question,blocking,state,answer,answered_by_human_id,requested_at,first_response_at,answered_at,resolved_at,resource_version
      FROM attention_requests WHERE workspace_id=? AND id=?`,
      )
      .run(id, FIX.workspace, attention.id);
    attention = { ...attention, id };
  }
  if (options.resolved) {
    attention = success(
      await f.human(
        answerAttentionCommand,
        { attentionId: attention.id, expectedVersion: 1, answer: ANSWER },
        LAUNCH_NOW,
        FIX.member,
      ),
    );
    attention = success(
      await f.human(
        resolveAttentionCommand,
        { attentionId: attention.id, expectedVersion: attention.resource_version },
        LAUNCH_NOW,
        FIX.member,
      ),
    );
  }
  const execution = (await f.db
    .prepare("SELECT resource_version FROM run_executions WHERE workspace_id=? AND id=?")
    .get(FIX.workspace, attention.run_execution_id)) as { resource_version: number };
  success(
    await f.human(transitionExecutionCommand, {
      runId: attention.run_id,
      executionId: attention.run_execution_id,
      expectedVersion: execution.resource_version,
      state: "ended",
      endReason: "process_exit",
    }),
  );
  await f.db
    .prepare(
      "INSERT INTO task_privacy (workspace_id,task_id,owner_human_id,created_at) VALUES (?,?,?,?)",
    )
    .run(FIX.workspace, f.task.id, FIX.member, LAUNCH_NOW);
  const grantId = randomUlid();
  await f.db
    .prepare(
      "INSERT INTO task_human_grants (workspace_id,id,task_id,human_id,authorization_epoch,permission,created_at) VALUES (?,?,?,?,1,'read',?)",
    )
    .run(FIX.workspace, grantId, f.task.id, viewer, LAUNCH_NOW);
  const session = await seedAuthSession(context, {
    userId: "human-detail-viewer-user",
    sessionId: "human-detail-viewer-session",
    token: "human-detail-viewer-token",
    email: "human-detail@synthetic.test",
    name: "Synthetic detail viewer",
    humanId: viewer,
    now: LAUNCH_NOW,
  });
  const key = mintCliKey();
  // Synthetic previously exchanged CLI binding; the real bearer resolver and narrowed project ceiling remain active.
  await f.db
    .prepare(
      `INSERT INTO api_key_bindings
    (workspace_id,id,principal_type,human_id,auth_user_id,device_code_hash,key_hash,key_prefix,scopes_json,project_ids_json,authorization_epoch,expires_at,exchanged_at,created_at)
    VALUES (?,?,'human',?,?,?,?,?,?,?,1,'2027-09-12T12:00:00.000Z',?,?)`,
    )
    .run(
      FIX.workspace,
      randomUlid(),
      viewer,
      session.userId,
      cliHash(randomUlid()),
      key.keyHash,
      key.keyPrefix,
      JSON.stringify(["bfb:read", "bfb:task:write"]),
      JSON.stringify(options.cliProjects ?? [FIX.projectA]),
      LAUNCH_NOW,
      LAUNCH_NOW,
    );
  const fake = <T extends object>(label: string) => ({ __synthetic: label }) as unknown as T;
  const bindings: ControlBindings = {
    DB: fake<D1Database>("db"),
    ARTIFACTS: fake<R2Bucket>("r2"),
    ASSETS: fake<Fetcher>("assets"),
    JOBS: fake<Queue>("jobs"),
    JOBS_DLQ: fake<Queue>("dlq"),
    WORKSPACE_HUB: createTestWorkspaceHubNamespace(f.db),
    APP_ORIGIN: AUTH_TEST_ENV.APP_ORIGIN,
    ARTIFACT_ORIGIN: "https://artifacts.bfb.example.test",
    LAUNCH_ORIGIN: "https://launch.bfb.example.test",
    JURISDICTION: "eu",
    ENVIRONMENT: "local",
  };
  const app = createControlApp(validateControlEnv(bindings), {
    db: f.db,
    now: LAUNCH_NOW,
    abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    humanAuth: () => ({
      auth: context.auth,
      keys: parseAuthKeys(AUTH_TEST_ENV.BETTER_AUTH_SECRETS),
      abuseSecret: AUTH_TEST_ENV.AUTH_ABUSE_SECRET,
    }),
  });
  const request = (transport: Transport, id = attention.id) =>
    app.request(
      new Request(
        `${AUTH_TEST_ENV.APP_ORIGIN}${transport === "browser" ? `/api/v1/workspaces/${FIX.workspace}/attention/${id}` : `/api/v1/cli/attention/${id}`}`,
        {
          headers:
            transport === "browser"
              ? { cookie: session.cookie }
              : { authorization: `Bearer ${key.key}` },
        },
      ),
      undefined,
      bindings,
    );
  return { ...f, attention, grantId, context, request };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function beforeDetail(f: Fixture, change: () => Promise<void>) {
  const original = f.db.prepare.bind(f.db);
  let observed = false,
    baseline: Awaited<ReturnType<typeof snapshot>> | undefined;
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    const statement = original(sql);
    if (!sql.includes("attention_observations") || !sql.includes("SELECT")) return statement;
    return {
      ...statement,
      all: async (...args: unknown[]) => {
        if (!observed) {
          observed = true;
          await change();
          baseline = await snapshot(f.db);
        }
        return statement.all(...args);
      },
    };
  });
  return { observed: () => observed, baseline: () => baseline };
}

async function revoke(f: Fixture) {
  await f.db
    .prepare("UPDATE task_human_grants SET revoked_at=? WHERE workspace_id=? AND id=?")
    .run(LAUNCH_NOW, FIX.workspace, f.grantId);
  expect(
    await f.db.prepare("SELECT revoked_at FROM task_human_grants WHERE id=?").get(f.grantId),
  ).toEqual({ revoked_at: LAUNCH_NOW });
}

describe("human attention final detail delivery", () => {
  it.each(["browser", "cli"] as const)(
    "%s withholds a body whose read grant is lost before observations",
    async (transport) => {
      const f = await fixture({ viewer: transport === "cli" ? FIX.owner : FIX.reviewer }),
        cut = beforeDetail(f, () => revoke(f));
      const response = await f.request(transport);
      expect(cut.observed()).toBe(true);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it.each(["project", "epoch"] as const)(
    "browser refuses current %s loss at the final detail cut",
    async (kind) => {
      const f = await fixture(),
        cut = beforeDetail(f, async () => {
          if (kind === "project") {
            const changed = await f.db
              .prepare(
                "DELETE FROM project_access WHERE workspace_id=? AND project_id=? AND human_id=?",
              )
              .run(FIX.workspace, FIX.projectA, FIX.reviewer);
            expect(changed.changes).toBe(1);
          } else await bumpMemberEpoch(f.db, FIX.workspace, FIX.reviewer);
        });
      const response = await f.request("browser");
      expect(cut.observed()).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it("an empty observation list cannot disguise late parent denial", async () => {
    const f = await fixture({ empty: true }),
      cut = beforeDetail(f, () => revoke(f));
    const response = await f.request("browser");
    expect(cut.observed()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(QUESTION);
    expect(await snapshot(f.db)).toEqual(cut.baseline());
  });

  it.each(["browser", "cli"] as const)(
    "%s returns the concurrently committed canonical answer with its observations",
    async (transport) => {
      const f = await fixture({ viewer: transport === "cli" ? FIX.owner : FIX.reviewer }),
        cut = beforeDetail(f, async () => {
          success(
            await f.human(
              answerAttentionCommand,
              { attentionId: f.attention.id, expectedVersion: 1, answer: ANSWER },
              LAUNCH_NOW,
              FIX.member,
            ),
          );
        });
      const response = await f.request(transport);
      expect(cut.observed()).toBe(true);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attention: { id: f.attention.id, state: "answered", answer: ANSWER, resource_version: 2 },
        observations: [{ observed_kind: "requested" }, { observed_kind: "answered" }],
      });
      expect(await snapshot(f.db)).toEqual(cut.baseline());
    },
  );

  it.each(["browser", "cli"] as const)(
    "%s preserves an authorized historical empty detail without read effects",
    async (transport) => {
      const f = await fixture({
          empty: true,
          viewer: transport === "cli" ? FIX.owner : FIX.reviewer,
        }),
        before = await snapshot(f.db);
      const response = await f.request(transport);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ attention: f.attention, observations: [] });
      expect(await snapshot(f.db)).toEqual(before);
    },
  );

  it("answered and resolved ended history retains ordered observations and missing parity", async () => {
    const f = await fixture({ resolved: true }),
      before = await snapshot(f.db);
    const response = await f.request("browser");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attention: f.attention,
      observations: [
        { observed_kind: "requested" },
        { observed_kind: "answered" },
        { observed_kind: "resolved" },
      ],
    });
    expect((await f.request("browser", randomUlid())).status).toBe(404);
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("missing and currently denied browser details share one no-store envelope", async () => {
    const f = await fixture();
    await revoke(f);
    const before = await snapshot(f.db),
      denied = await f.request("browser"),
      missing = await f.request("browser", randomUlid());
    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(denied.headers.get("cache-control")).toContain("no-store");
    expect(missing.headers.get("cache-control")).toContain("no-store");
    expect(await denied.json()).toEqual(await missing.json());
    expect(await snapshot(f.db)).toEqual(before);
  });

  it("the CLI project binding stays narrower than the same human's browser authority", async () => {
    const f = await fixture({ viewer: FIX.owner, cliProjects: [FIX.projectB] }),
      before = await snapshot(f.db);
    const browser = await f.request("browser"),
      cli = await f.request("cli");
    expect(browser.status).toBe(200);
    expect(await browser.text()).toContain(QUESTION);
    expect(cli.status).toBe(404);
    expect(cli.headers.get("cache-control")).toContain("no-store");
    expect(await cli.json()).toEqual({ error: "not_found" });
    expect(await snapshot(f.db)).toEqual(before);
  });
});
